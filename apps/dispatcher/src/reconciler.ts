import {
  config,
  emitEvent,
  reapDeadWorkers,
  recordFailure,
  withTransaction,
  type JobRow,
} from "@vpp/core";

// The reconciler is the system's safety net. The happy path never needs it:
// queues redeliver unacknowledged messages and workers hand work back on
// shutdown. It exists for the cases where those mechanisms lose something.
// Every pass is idempotent and uses SKIP LOCKED, so several dispatchers can
// run it at once.

export interface ReconcileResult {
  /** Running jobs whose worker vanished: retried or dead-lettered. */
  leasesExpired: number;
  /** Pending jobs that no message will ever wake up: given a new outbox row. */
  lostJobsRequeued: number;
  workersReaped: number;
}

/**
 * A lease is considered abandoned this long after it expired. The grace period
 * lets the normal path (visibility timeout → redelivery → reclaim) win first.
 */
const LEASE_GRACE_SECONDS = 2;

export async function reconcileOnce(): Promise<ReconcileResult> {
  const leasesExpired = await failExpiredLeases();
  const lostJobsRequeued = await requeueLostJobs();
  const workersReaped = await withTransaction((tx) => reapDeadWorkers(tx));
  return { leasesExpired, lostJobsRequeued, workersReaped };
}

/**
 * Running jobs whose lease ran out: the worker crashed (or stalled) mid-job.
 * Each counts as a failed attempt, so recordFailure either schedules a retry
 * with backoff or, once attempts are exhausted, fails and dead-letters the
 * job. Without this, a job whose worker keeps crashing on it would sit in
 * `running` forever once it hit max_attempts (claims refuse it).
 */
async function failExpiredLeases(): Promise<number> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<JobRow>(
      `SELECT * FROM processing_jobs
        WHERE state = 'running' AND lease_expires_at < now() - make_interval(secs => $1)
        ORDER BY lease_expires_at
        LIMIT 50
        FOR UPDATE SKIP LOCKED`,
      [LEASE_GRACE_SECONDS],
    );
    for (const job of rows) {
      await emitEvent(tx, {
        videoId: job.video_id,
        jobId: job.id,
        type: "lease_expired",
        attempt: job.attempt,
        workerId: job.lease_owner,
      });
      await recordFailure(tx, job, {
        error: `Worker ${job.lease_owner ?? "unknown"} stopped responding (lease expired)`,
        kind: "retryable",
        actor: "reconciler",
      });
    }
    return rows.length;
  });
}

/**
 * Pending jobs that are long overdue and have no unsent outbox row: whatever
 * message was meant to wake a worker for them got lost (dropped, purged,
 * deleted by a bug...). Give them a fresh outbox row.
 *
 * Trade-off: under a large queue backlog a job can be overdue simply because
 * it's waiting its turn, so this may send a duplicate message. That's safe,
 * because claims are idempotent, and RECONCILE_STALE_PENDING_SECONDS keeps it rare.
 */
async function requeueLostJobs(): Promise<number> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; video_id: string }>(
      `SELECT j.id, j.video_id FROM processing_jobs j
        WHERE j.state = 'pending'
          AND j.next_attempt_at < now() - make_interval(secs => $1)
          AND j.attempt < j.max_attempts
          AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.job_id = j.id AND o.sent_at IS NULL)
        LIMIT 50
        FOR UPDATE OF j SKIP LOCKED`,
      [config.RECONCILE_STALE_PENDING_SECONDS],
    );
    for (const job of rows) {
      await tx.query(`INSERT INTO outbox (job_id) VALUES ($1)`, [job.id]);
      // Reset the clock so we don't requeue it again on the next pass.
      await tx.query(`UPDATE processing_jobs SET next_attempt_at = now() WHERE id = $1`, [job.id]);
      await emitEvent(tx, { videoId: job.video_id, jobId: job.id, type: "requeued", workerId: "reconciler" });
    }
    return rows.length;
  });
}
