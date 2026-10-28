import { config } from "./config.ts";
import { withTransaction, type Queryable } from "./db.ts";
import type { JobKind, JobState, PipelineEvent, VideoStatus } from "./domain.ts";

export interface JobRow {
  id: string;
  video_id: string;
  kind: JobKind;
  target_height: number;
  state: JobState;
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  progress: number;
  last_error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Thrown when a worker's attempt number no longer matches the row: someone else owns the job now. */
export class StaleLeaseError extends Error {
  constructor(readonly jobId: string, readonly attempt: number) {
    super(`Lease lost for job ${jobId} (attempt ${attempt})`);
    this.name = "StaleLeaseError";
  }
}

export const PIPELINE_CHANNEL = "pipeline";

// ---------------------------------------------------------------------------
// Pure logic (no I/O) — unit tested directly.
// ---------------------------------------------------------------------------

/**
 * Derives a video's overall status from its jobs. Returns null when there is
 * nothing to derive yet (no jobs: the video is still uploading).
 *
 *   probe failed                      → failed  (nothing can be produced)
 *   all jobs terminal, ≥1 rendition   → ready   (even if some renditions failed)
 *   all jobs terminal, 0 renditions   → failed
 *   any job started or finished       → processing
 *   otherwise                         → queued
 */
export function computeVideoStatus(
  jobs: ReadonlyArray<{ kind: JobKind; state: JobState }>,
  renditionCount: number,
): VideoStatus | null {
  if (jobs.length === 0) return null;
  if (jobs.some((j) => j.kind === "probe" && j.state === "failed")) return "failed";
  const isTerminal = (s: JobState) => s === "completed" || s === "failed";
  if (jobs.every((j) => isTerminal(j.state))) return renditionCount > 0 ? "ready" : "failed";
  if (jobs.some((j) => j.state !== "pending")) return "processing";
  return "queued";
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EmitEventInput {
  videoId: string;
  type: string;
  jobId?: string | null;
  attempt?: number | null;
  workerId?: string | null;
  detail?: Record<string, unknown>;
  /** false = notify listeners only, don't add a timeline row (e.g. progress ticks). */
  persist?: boolean;
}

/**
 * Records a timeline event and NOTIFYs listeners. Call it inside the same
 * transaction as the state change it describes: Postgres only delivers the
 * NOTIFY if the transaction commits, so listeners never hear about changes
 * that were rolled back.
 */
export async function emitEvent(tx: Queryable, e: EmitEventInput): Promise<void> {
  if (e.persist !== false) {
    await tx.query(
      `INSERT INTO job_events (video_id, job_id, type, attempt, worker_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [e.videoId, e.jobId ?? null, e.type, e.attempt ?? null, e.workerId ?? null, e.detail ?? {}],
    );
  }
  const { rows } = await tx.query<{ owner_id: string }>(`SELECT owner_id FROM videos WHERE id = $1`, [e.videoId]);
  const payload: PipelineEvent = {
    videoId: e.videoId,
    ownerId: rows[0]?.owner_id ?? "",
    type: e.type,
    jobId: e.jobId ?? null,
  };
  await tx.query(`SELECT pg_notify($1, $2)`, [PIPELINE_CHANNEL, JSON.stringify(payload)]);
}

// ---------------------------------------------------------------------------
// Creating jobs
// ---------------------------------------------------------------------------

/**
 * Creates a job and its outbox row in the caller's transaction. Idempotent:
 * if the (video, kind, height) job already exists, nothing happens and null is
 * returned — so retried requests and redelivered probe messages can't fan out twice.
 */
export async function enqueueJob(
  tx: Queryable,
  job: { videoId: string; kind: JobKind; targetHeight?: number },
): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO processing_jobs (video_id, kind, target_height) VALUES ($1, $2, $3)
     ON CONFLICT (video_id, kind, target_height) DO NOTHING RETURNING id`,
    [job.videoId, job.kind, job.targetHeight ?? 0],
  );
  const jobId = rows[0]?.id;
  if (!jobId) return null;
  await tx.query(`INSERT INTO outbox (job_id) VALUES ($1)`, [jobId]);
  await emitEvent(tx, {
    videoId: job.videoId,
    jobId,
    type: "job_created",
    detail: { kind: job.kind, targetHeight: job.targetHeight ?? 0 },
  });
  return jobId;
}

// ---------------------------------------------------------------------------
// Claiming and finishing jobs
// ---------------------------------------------------------------------------

export async function getJob(db: Queryable, jobId: string): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(`SELECT * FROM processing_jobs WHERE id = $1`, [jobId]);
  return rows[0] ?? null;
}

/**
 * Atomically takes ownership of a job for one lease period. Succeeds only if
 * the job is pending, or running under a lease that has already expired (its
 * worker presumably died). Returns null if someone else holds it or it's done.
 *
 * The returned `attempt` is this worker's fencing token.
 */
export async function claimJob(jobId: string, workerId: string): Promise<JobRow | null> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<JobRow>(
      `UPDATE processing_jobs
          SET state = 'running',
              attempt = attempt + 1,
              lease_owner = $2,
              lease_expires_at = now() + make_interval(secs => $3),
              started_at = coalesce(started_at, now()),
              progress = 0
        WHERE id = $1
          AND next_attempt_at <= now()
          AND (state = 'pending' OR (state = 'running' AND lease_expires_at < now()))
        RETURNING *`,
      [jobId, workerId, config.JOB_LEASE_SECONDS],
    );
    const job = rows[0];
    if (!job) return null;
    await emitEvent(tx, { videoId: job.video_id, jobId, type: "claimed", attempt: job.attempt, workerId });
    await recomputeVideoStatus(tx, job.video_id);
    return job;
  });
}

/**
 * Heartbeat: pushes the lease forward while work is in progress. Returns false
 * if the lease is already gone (expired and claimed by someone else), in which
 * case the caller must stop working on the job.
 */
export async function extendLease(job: JobRow): Promise<boolean> {
  const res = await withTransaction((tx) =>
    tx.query(
      `UPDATE processing_jobs SET lease_expires_at = now() + make_interval(secs => $3)
        WHERE id = $1 AND attempt = $2 AND state = 'running'`,
      [job.id, job.attempt, config.JOB_LEASE_SECONDS],
    ),
  );
  return res.rowCount === 1;
}

/**
 * Graceful handoff on shutdown: gives the job back (pending, no lease) so
 * another worker can claim it immediately rather than after the lease expires.
 * Fenced like every other write; returns false if we no longer owned it.
 */
export async function releaseJob(job: JobRow, workerId: string): Promise<boolean> {
  return withTransaction(async (tx) => {
    const res = await tx.query(
      `UPDATE processing_jobs SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, progress = 0
        WHERE id = $1 AND attempt = $2 AND state = 'running'`,
      [job.id, job.attempt],
    );
    if (res.rowCount === 0) return false;
    await emitEvent(tx, { videoId: job.video_id, jobId: job.id, type: "released", attempt: job.attempt, workerId });
    await recomputeVideoStatus(tx, job.video_id);
    return true;
  });
}

/** Fenced: only writes if `attempt` still matches. Progress ticks are notify-only. */
export async function updateProgress(job: JobRow, progress: number): Promise<void> {
  await withTransaction(async (tx) => {
    const res = await tx.query(
      `UPDATE processing_jobs SET progress = $3 WHERE id = $1 AND attempt = $2 AND state = 'running'`,
      [job.id, job.attempt, progress],
    );
    if (res.rowCount === 0) throw new StaleLeaseError(job.id, job.attempt);
    await emitEvent(tx, { videoId: job.video_id, jobId: job.id, type: "progress", persist: false });
  });
}

/**
 * Marks the job completed — but only if this worker's attempt still owns it.
 * Must run in the same transaction as the job's other result writes, so that
 * either all of them land or none do.
 */
export async function markJobCompleted(tx: Queryable, job: JobRow, workerId: string): Promise<void> {
  const res = await tx.query(
    `UPDATE processing_jobs
        SET state = 'completed', progress = 1, finished_at = now(), lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND attempt = $2 AND state = 'running'`,
    [job.id, job.attempt],
  );
  if (res.rowCount === 0) throw new StaleLeaseError(job.id, job.attempt);
  await emitEvent(tx, { videoId: job.video_id, jobId: job.id, type: "completed", attempt: job.attempt, workerId });
}

export async function markJobFailed(tx: Queryable, job: JobRow, workerId: string, error: string): Promise<void> {
  const res = await tx.query(
    `UPDATE processing_jobs
        SET state = 'failed', finished_at = now(), last_error = $3, lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND attempt = $2 AND state = 'running'`,
    [job.id, job.attempt, error],
  );
  if (res.rowCount === 0) throw new StaleLeaseError(job.id, job.attempt);
  await emitEvent(tx, {
    videoId: job.video_id,
    jobId: job.id,
    type: "failed",
    attempt: job.attempt,
    workerId,
    detail: { error },
  });
}

/**
 * Re-derives the video's status from its jobs and renditions. Locks the video
 * row first, so two jobs finishing at the same moment are serialized here
 * instead of overwriting each other's update.
 *
 * Why FOR NO KEY UPDATE and not FOR UPDATE: by the time we get here, the
 * transaction has inserted a job_events row, and that foreign key took
 * FOR KEY SHARE on this video row. FOR UPDATE conflicts with KEY SHARE, so two
 * transactions that each hold KEY SHARE and each want FOR UPDATE deadlock.
 * FOR NO KEY UPDATE (the lock an UPDATE of non-key columns takes anyway) is
 * compatible with KEY SHARE but still conflicts with itself, so concurrent
 * recomputes for one video remain serialized.
 */
export async function recomputeVideoStatus(tx: Queryable, videoId: string): Promise<VideoStatus> {
  const { rows: videoRows } = await tx.query<{ status: VideoStatus }>(
    `SELECT status FROM videos WHERE id = $1 FOR NO KEY UPDATE`,
    [videoId],
  );
  const current = videoRows[0]!.status;
  const { rows: jobs } = await tx.query<{ kind: JobKind; state: JobState }>(
    `SELECT kind, state FROM processing_jobs WHERE video_id = $1`,
    [videoId],
  );
  const { rows: countRows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM renditions WHERE video_id = $1`,
    [videoId],
  );
  const next = computeVideoStatus(jobs, countRows[0]!.n);
  if (!next || next === current) return current;

  await tx.query(`UPDATE videos SET status = $2, updated_at = now() WHERE id = $1`, [videoId, next]);
  await emitEvent(tx, { videoId, type: "video_status", detail: { from: current, to: next } });
  return next;
}

/** Convenience for code paths that aren't already inside a transaction. */
export function recordEvent(e: EmitEventInput): Promise<void> {
  return withTransaction((tx) => emitEvent(tx, e));
}

