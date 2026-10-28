import { setTimeout as sleep } from "node:timers/promises";
import { config, getChaos, pool, sendJobMessage, withTransaction, type QueueName } from "@vpp/core";
import { reconcileOnce } from "./reconciler.ts";

const BATCH_SIZE = 20;
const IDLE_POLL_MS = 250;

/**
 * Sends one batch of due outbox rows to their queues. Returns how many were sent.
 *
 * - `FOR UPDATE SKIP LOCKED` lets several dispatchers run at once: each one
 *   claims a different batch instead of waiting on (or double-sending) rows
 *   another dispatcher already holds.
 * - A row is marked sent only after the queue accepted the message. If we crash
 *   between send and COMMIT, the row stays unsent and is sent again later. That
 *   is at-least-once delivery, and it's fine because workers are idempotent.
 * - `available_at` holds back retry rows until their backoff delay has passed.
 */
export async function dispatchOnce(): Promise<number> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; job_id: string; queue: QueueName }>(
      `SELECT id, job_id, queue FROM outbox
        WHERE sent_at IS NULL AND available_at <= now()
        ORDER BY available_at, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [BATCH_SIZE],
    );
    for (const row of rows) {
      await sendJobMessage({ jobId: row.job_id }, row.queue);
      await tx.query(`UPDATE outbox SET sent_at = now() WHERE id = $1`, [row.id]);
    }
    return rows.length;
  });
}

type Log = Pick<Console, "info" | "warn" | "error">;

/**
 * Runs until `signal` is aborted: relays the outbox continuously and runs the
 * reconciler every RECONCILE_INTERVAL_MS. Both are skipped while the chaos
 * panel has "pause dispatcher" on, which simulates a dispatcher outage: work
 * piles up safely in the outbox and drains when it resumes.
 */
export async function runDispatcher(signal: AbortSignal, log: Log = console): Promise<void> {
  let lastReconcile = 0;
  let wasPaused = false;

  while (!signal.aborted) {
    try {
      const { dispatcherPaused } = await getChaos(pool);
      if (dispatcherPaused !== wasPaused) {
        log.warn(`[dispatcher] ${dispatcherPaused ? "paused by chaos settings" : "resumed"}`);
        wasPaused = dispatcherPaused;
      }
      if (!dispatcherPaused) {
        if (Date.now() - lastReconcile >= config.RECONCILE_INTERVAL_MS) {
          lastReconcile = Date.now();
          const r = await reconcileOnce();
          const total = r.leasesExpired + r.lostJobsRequeued + r.workersReaped;
          if (total > 0) log.info(`[reconciler] ${JSON.stringify(r)}`);
        }
        const sent = await dispatchOnce();
        if (sent > 0) {
          log.info(`[dispatcher] sent ${sent} message(s)`);
          continue;
        }
      }
    } catch (err) {
      log.error("[dispatcher] iteration failed; will retry", err);
    }
    await sleep(IDLE_POLL_MS, undefined, { signal }).catch(() => {});
  }
}
