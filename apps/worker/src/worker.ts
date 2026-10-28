import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { Message } from "@aws-sdk/client-sqs";
import { z } from "zod";
import {
  StaleLeaseError,
  claimJob,
  classifyError,
  config,
  deleteJobMessage,
  extendLease,
  extendMessageVisibility,
  getChaos,
  getJob,
  pool,
  receiveJobMessages,
  recordEvent,
  recordFailure,
  registerWorker,
  releaseJob,
  unregisterWorker,
  withTransaction,
  workerHeartbeat,
  type JobRow,
} from "@vpp/core";
import { SimulatedCrash, faultsFrom, runtime } from "./faults.ts";
import { handlers } from "./handlers.ts";

const JobMessageSchema = z.object({ jobId: z.uuid() });

export function makeWorkerId(): string {
  return `${os.hostname().split(".")[0]}-${process.pid}`;
}

type Log = Pick<Console, "info" | "warn" | "error">;

/** What this worker is doing right now; reported by the registry heartbeat. */
export interface WorkerState {
  currentJobId: string | null;
}

/**
 * Handles one queue message end to end. The message is only a pointer: the
 * job row in Postgres decides whether there is anything to do.
 */
export async function processMessage(
  msg: Message,
  workerId: string,
  signal: AbortSignal,
  log: Log = console,
  state: WorkerState = { currentJobId: null },
) {
  const parsed = JobMessageSchema.safeParse(JSON.parse(msg.Body ?? "null"));
  if (!parsed.success) {
    log.warn(`[${workerId}] dropping malformed message`, msg.Body);
    await deleteJobMessage(msg.ReceiptHandle!);
    return;
  }
  const { jobId } = parsed.data;

  const job = await claimJob(jobId, workerId);
  if (!job) {
    // Duplicate delivery of a finished job, or another worker holds a live
    // lease. Either way there's nothing for us to do; acknowledge it.
    const current = await getJob(pool, jobId);
    log.info(`[${workerId}] skip job ${jobId}: ${current ? `state=${current.state}` : "not found"}`);
    await deleteJobMessage(msg.ReceiptHandle!);
    return;
  }

  log.info(`[${workerId}] claimed ${job.kind}${job.target_height ? ` ${job.target_height}p` : ""} job ${jobId} (attempt ${job.attempt})`);

  // The handler is cancelled if we shut down OR if the heartbeat finds that
  // our lease is gone. AbortSignal.any combines the two.
  const leaseLost = new AbortController();
  const stopHeartbeat = startHeartbeat(job, msg.ReceiptHandle!, leaseLost, workerId, log);
  state.currentJobId = job.id;
  try {
    const faults = faultsFrom(await getChaos(pool));
    await handlers[job.kind]({ job, workerId, signal: AbortSignal.any([signal, leaseLost.signal]), faults });
    log.info(`[${workerId}] completed job ${jobId}`);
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err; // tests only: behave like process death
    if (signal.aborted) {
      // Shutting down mid-job is not a job failure. Hand the job back so
      // another worker can take it right away: release the DB lease (fenced)
      // and make the message visible again. If this process dies before
      // getting here, the lease and visibility timeouts recover it anyway,
      // just ~1 lease later.
      await releaseJob(job, workerId).catch(() => false);
      await extendMessageVisibility(msg.ReceiptHandle!, 0).catch(() => {});
      log.warn(`[${workerId}] shutting down mid-job; released job ${jobId} for another worker`);
      return;
    }
    const cause = leaseLost.signal.aborted ? new StaleLeaseError(job.id, job.attempt) : err;
    await handleFailure(job, workerId, cause, log);
  } finally {
    stopHeartbeat();
    state.currentJobId = null;
  }
  await deleteJobMessage(msg.ReceiptHandle!);
}

/**
 * Renews the DB lease and the message's visibility every lease/3 seconds, so a
 * job may run far longer than one lease as long as its worker is alive. If the
 * lease turns out to be gone, or we can't renew it for a whole lease period
 * (e.g. the DB is unreachable), abort the work: someone else may own it now.
 */
function startHeartbeat(
  job: JobRow,
  receiptHandle: string,
  leaseLost: AbortController,
  workerId: string,
  log: Log,
): () => void {
  const stop = new AbortController();
  const leaseMs = config.JOB_LEASE_SECONDS * 1000;

  (async () => {
    let lastRenewed = Date.now();
    while (!stop.signal.aborted) {
      await sleep(leaseMs / 3, undefined, { signal: stop.signal }).catch(() => {});
      if (stop.signal.aborted) return;
      try {
        if (!(await extendLease(job))) {
          log.warn(`[${workerId}] lease lost for job ${job.id}; abandoning work`);
          leaseLost.abort();
          return;
        }
        await extendMessageVisibility(receiptHandle, config.JOB_LEASE_SECONDS);
        lastRenewed = Date.now();
      } catch (err) {
        log.warn(`[${workerId}] heartbeat failed`, err);
        if (Date.now() - lastRenewed >= leaseMs) {
          leaseLost.abort();
          return;
        }
      }
    }
  })();

  return () => stop.abort();
}

async function handleFailure(job: JobRow, workerId: string, err: unknown, log: Log): Promise<void> {
  if (err instanceof StaleLeaseError) {
    // Fencing worked: our lease expired and another attempt owns the job now,
    // so our results were discarded. Record it so it shows up in the timeline.
    log.warn(`[${workerId}] ${err.message}; result discarded`);
    await recordEvent({
      videoId: job.video_id,
      jobId: job.id,
      type: "stale_write_rejected",
      attempt: job.attempt,
      workerId,
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  const kind = classifyError(err);
  try {
    const outcome = await withTransaction((tx) => recordFailure(tx, job, { error: message, kind, actor: workerId }));
    log.error(
      `[${workerId}] job ${job.id} attempt ${job.attempt}/${job.max_attempts} failed (${kind}): ${message} → ${outcome}`,
    );
  } catch (failErr) {
    // Lost the lease while failing: the new owner decides what happens.
    if (!(failErr instanceof StaleLeaseError)) throw failErr;
  }
}

/** Receives and processes at most one message. Returns whether one was handled. */
export async function pollOnce(
  workerId: string,
  signal: AbortSignal,
  opts: { waitSeconds?: number; log?: Log; state?: WorkerState } = {},
): Promise<boolean> {
  // The receive is deliberately NOT cancelled by `signal`. Aborting a long-poll
  // only closes our end; the queue may still hand the next message to that
  // dead request and hide it for a whole visibility timeout (seen in the M3
  // smoke test: a 30 s stall after every restart). Short polls keep shutdown
  // quick instead.
  const messages = await receiveJobMessages({
    max: 1,
    waitSeconds: opts.waitSeconds ?? 5,
    // Keep the message invisible to other workers for as long as our lease lasts.
    visibilityTimeoutSeconds: config.JOB_LEASE_SECONDS,
  });
  for (const msg of messages) {
    if (signal.aborted) {
      // Arrived while shutting down: give it straight back.
      await extendMessageVisibility(msg.ReceiptHandle!, 0);
      continue;
    }
    await processMessage(msg, workerId, signal, opts.log, opts.state);
  }
  return messages.length > 0;
}

/**
 * The worker's main loop: register in the worker registry, keep a registry
 * heartbeat running (which is also how a "kill" from the System page arrives),
 * and process messages until shut down.
 */
export async function runWorker(workerId: string, signal: AbortSignal, log: Log = console): Promise<void> {
  const state: WorkerState = { currentJobId: null };
  await registerWorker(pool, { workerId, hostname: os.hostname().split(".")[0]!, pid: process.pid });
  const stopRegistry = startRegistryHeartbeat(workerId, state, log);
  try {
    while (!signal.aborted) {
      try {
        await pollOnce(workerId, signal, { log, state });
      } catch (err) {
        if (signal.aborted) break;
        log.error(`[${workerId}] poll failed; backing off`, err);
        await sleep(1000);
      }
    }
  } finally {
    stopRegistry();
    await unregisterWorker(pool, workerId).catch(() => {});
  }
}

function startRegistryHeartbeat(workerId: string, state: WorkerState, log: Log): () => void {
  const timer = setInterval(() => {
    workerHeartbeat(pool, workerId, state.currentJobId).then(
      ({ killRequested }) => {
        // A hard exit mid-job, just like `kill -9`: no lease release, no ack.
        if (killRequested) runtime.crash(`killed from the System page while running job ${state.currentJobId ?? "(idle)"}`);
      },
      (err: unknown) => log.warn(`[${workerId}] registry heartbeat failed`, err),
    );
  }, config.WORKER_HEARTBEAT_MS);
  return () => clearInterval(timer);
}
