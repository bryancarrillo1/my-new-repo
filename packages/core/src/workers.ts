import { config } from "./config.ts";
import type { Queryable } from "./db.ts";

// A registry of live worker processes, kept fresh by a heartbeat. It powers
// the System page (who's alive, what they're doing) and the "kill" button.
// It is NOT used for job ownership; leases on processing_jobs do that.

export interface WorkerIdentity {
  workerId: string;
  hostname: string;
  pid: number;
}

export async function registerWorker(db: Queryable, w: WorkerIdentity): Promise<void> {
  await db.query(
    `INSERT INTO workers (id, hostname, pid) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), kill_requested = false`,
    [w.workerId, w.hostname, w.pid],
  );
}

/** Refreshes last_seen_at and the current job; returns whether a kill was requested. */
export async function workerHeartbeat(
  db: Queryable,
  workerId: string,
  currentJobId: string | null,
): Promise<{ killRequested: boolean }> {
  const { rows } = await db.query<{ kill_requested: boolean }>(
    `UPDATE workers SET last_seen_at = now(), current_job_id = $2 WHERE id = $1 RETURNING kill_requested`,
    [workerId, currentJobId],
  );
  return { killRequested: rows[0]?.kill_requested ?? false };
}

export async function unregisterWorker(db: Queryable, workerId: string): Promise<void> {
  await db.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
}

export async function requestWorkerKill(db: Queryable, workerId: string): Promise<boolean> {
  const res = await db.query(`UPDATE workers SET kill_requested = true WHERE id = $1`, [workerId]);
  return res.rowCount === 1;
}

/** Heartbeats missed before a worker counts as dead. */
export const DEAD_AFTER_BEATS = 5;

/** SQL expression: is this worker row still alive? */
export const WORKER_ALIVE_SQL = `last_seen_at > now() - make_interval(secs => ${
  (DEAD_AFTER_BEATS * config.WORKER_HEARTBEAT_MS) / 1000
})`;

/** Removes workers that stopped heartbeating long ago (crashed, never unregistered). */
export async function reapDeadWorkers(db: Queryable): Promise<number> {
  const res = await db.query(
    `DELETE FROM workers WHERE last_seen_at < now() - make_interval(secs => $1)`,
    // Keep dead rows around for a while so the UI can show "dead" before they vanish.
    [(DEAD_AFTER_BEATS * 3 * config.WORKER_HEARTBEAT_MS) / 1000],
  );
  return res.rowCount ?? 0;
}
