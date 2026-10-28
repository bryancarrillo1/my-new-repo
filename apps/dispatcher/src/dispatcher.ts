import { sendJobMessage, withTransaction } from "@vpp/core";
import { setTimeout as sleep } from "node:timers/promises";

const BATCH_SIZE = 20;
const IDLE_POLL_MS = 250;

/**
 * Sends one batch of due outbox rows to the queue. Returns how many were sent.
 *
 * - `FOR UPDATE SKIP LOCKED` lets several dispatchers run at once: each one
 *   claims a different batch instead of waiting on (or double-sending) rows
 *   another dispatcher already holds.
 * - A row is marked sent only after the queue accepted the message. If we crash
 *   between send and COMMIT, the row stays unsent and is sent again later. That
 *   is at-least-once delivery, and it's fine because workers are idempotent.
 */
export async function dispatchOnce(): Promise<number> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; job_id: string }>(
      `SELECT id, job_id FROM outbox
        WHERE sent_at IS NULL AND available_at <= now()
        ORDER BY id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [BATCH_SIZE],
    );
    for (const row of rows) {
      await sendJobMessage({ jobId: row.job_id });
      await tx.query(`UPDATE outbox SET sent_at = now() WHERE id = $1`, [row.id]);
    }
    return rows.length;
  });
}

/** Runs until `signal` is aborted. Polls quickly when idle, immediately when busy. */
export async function runDispatcher(signal: AbortSignal, log = console): Promise<void> {
  while (!signal.aborted) {
    try {
      const sent = await dispatchOnce();
      if (sent > 0) {
        log.info(`[dispatcher] sent ${sent} job(s)`);
        continue;
      }
    } catch (err) {
      log.error("[dispatcher] batch failed; will retry", err);
    }
    await sleep(IDLE_POLL_MS, undefined, { signal }).catch(() => {});
  }
}
