import {
  NO_CHAOS,
  WORKER_ALIVE_SQL,
  deleteJobMessage,
  getChaos,
  pool,
  queueDepth,
  receiveJobMessages,
  redriveJob,
  requestWorkerKill,
  updateChaos,
  type ChaosSettings,
  type JobKind,
  type JobState,
  type SystemView,
  type WorkerView,
} from "@vpp/core";

// Operator-facing actions behind /admin. PROJECT_OVERVIEW keeps job management
// internal ("does not require public CRUD endpoints"), so none of this is part
// of the public video API. In the demo any logged-in user is an operator;
// hosted mode (M9) rate-limits these.

export async function getSystemView(): Promise<SystemView> {
  const [workers, chaos, jobsQueue, deadLetter, backlog, byState] = await Promise.all([
    listWorkers(),
    getChaos(pool),
    queueDepth("jobs"),
    queueDepth("dead-letter"),
    pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE sent_at IS NULL`),
    pool.query<{ state: JobState; n: number }>(`SELECT state, count(*)::int AS n FROM processing_jobs GROUP BY state`),
  ]);
  const jobsByState: Record<JobState, number> = { pending: 0, running: 0, completed: 0, failed: 0 };
  for (const row of byState.rows) jobsByState[row.state] = row.n;

  return {
    workers,
    chaos,
    queues: { jobs: jobsQueue, deadLetter },
    outboxBacklog: backlog.rows[0]!.n,
    jobsByState,
  };
}

async function listWorkers(): Promise<WorkerView[]> {
  const { rows } = await pool.query<{
    id: string; hostname: string; pid: number; started_at: Date; last_seen_at: Date; alive: boolean;
    kill_requested: boolean; job_id: string | null; kind: JobKind | null; target_height: number | null;
    video_id: string | null; title: string | null;
  }>(
    `SELECT w.id, w.hostname, w.pid, w.started_at, w.last_seen_at, w.kill_requested,
            (${WORKER_ALIVE_SQL}) AS alive,
            j.id AS job_id, j.kind, j.target_height, v.id AS video_id, v.title
       FROM workers w
       LEFT JOIN processing_jobs j ON j.id = w.current_job_id
       LEFT JOIN videos v ON v.id = j.video_id
      ORDER BY w.started_at`,
  );
  return rows.map((w) => ({
    workerId: w.id,
    hostname: w.hostname,
    pid: w.pid,
    startedAt: w.started_at.toISOString(),
    lastSeenAt: w.last_seen_at.toISOString(),
    alive: w.alive,
    killRequested: w.kill_requested,
    currentJob:
      w.job_id && w.video_id
        ? {
            jobId: w.job_id,
            label: w.kind === "probe" ? "Probe" : `Transcode ${w.target_height}p`,
            videoId: w.video_id,
            videoTitle: w.title ?? "",
          }
        : null,
  }));
}

export function setChaos(patch: Partial<ChaosSettings>): Promise<ChaosSettings> {
  return updateChaos(patch);
}

export function resetChaos(): Promise<ChaosSettings> {
  return updateChaos(NO_CHAOS);
}

export function killWorker(workerId: string): Promise<boolean> {
  return requestWorkerKill(pool, workerId);
}

export function retryJob(jobId: string, actor: string): Promise<boolean> {
  return redriveJob(jobId, actor);
}

/**
 * DLQ redrive, like SQS's "start DLQ redrive": drain the dead-letter queue and
 * give each failed job a fresh attempt budget. A message whose job is no
 * longer failed (already retried from the UI, say) is simply dropped, so
 * redriving is idempotent.
 */
export async function redriveDeadLetters(actor: string): Promise<{ messages: number; redriven: number }> {
  let messages = 0;
  let redriven = 0;
  for (let batch = 0; batch < 20; batch++) {
    const received = await receiveJobMessages({
      queue: "dead-letter",
      max: 10,
      waitSeconds: 0,
      visibilityTimeoutSeconds: 30,
    });
    if (received.length === 0) break;
    for (const msg of received) {
      messages++;
      const jobId = parseJobId(msg.Body);
      if (jobId && (await redriveJob(jobId, actor))) redriven++;
      await deleteJobMessage(msg.ReceiptHandle!, "dead-letter");
    }
  }
  return { messages, redriven };
}

function parseJobId(body: string | undefined): string | null {
  try {
    const parsed = JSON.parse(body ?? "") as { jobId?: unknown };
    return typeof parsed.jobId === "string" ? parsed.jobId : null;
  } catch {
    return null;
  }
}
