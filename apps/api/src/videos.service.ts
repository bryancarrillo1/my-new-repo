import { createHash } from "node:crypto";
import {
  AppError,
  NotFoundError,
  config,
  headObjectSize,
  originalKey,
  pool,
  presignUpload,
  withTransaction,
  type UploadSessionStatus,
  type VideoStatus,
} from "@vpp/core";

export interface CreateVideoInput {
  title: string;
  fileName: string;
  fileSizeBytes: number;
}

export interface CreateVideoResponse {
  videoId: string;
  uploadId: string;
  uploadUrl: string;
  uploadUrlExpiresAt: string;
}

export interface VideoStatusResponse {
  videoId: string;
  status: VideoStatus;
  playbackReady: boolean;
  availableResolutions: number[];
}

// Thrown inside the transaction to roll it back when another request with the
// same idempotency key won the race. Never escapes this module.
class IdempotencyRaceLost extends Error {}

// ---------------------------------------------------------------------------
// POST /videos
// ---------------------------------------------------------------------------

/**
 * Creates the video + upload session and returns a presigned upload URL.
 *
 * Idempotency: with a key, a retry returns the *same* videoId/uploadId instead
 * of creating a duplicate video. We store IDs rather than the full response so a
 * replay gets a freshly signed URL (the original may have expired).
 */
export async function createVideo(
  ownerId: string,
  input: CreateVideoInput,
  idempotencyKey?: string,
): Promise<{ response: CreateVideoResponse; replayed: boolean }> {
  const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

  if (idempotencyKey) {
    const existing = await findIdempotentResult(ownerId, idempotencyKey, requestHash);
    if (existing) return { response: await buildCreateResponse(existing, input), replayed: true };
  }

  try {
    const ids = await withTransaction(async (tx) => {
      const videoId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO videos (id, owner_id, title, source_key) VALUES ($1, $2, $3, $4)`,
        [videoId, ownerId, input.title, originalKey(videoId)],
      );
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO upload_sessions (video_id, object_key, file_name, expected_size)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [videoId, originalKey(videoId), input.fileName, input.fileSizeBytes],
      );
      const uploadId = rows[0]!.id;

      if (idempotencyKey) {
        // If a concurrent request already inserted this key, this INSERT waits
        // for that transaction to commit, then inserts nothing. We roll back our
        // own video so exactly one video exists per key.
        const inserted = await tx.query(
          `INSERT INTO idempotency_keys (owner_id, key, request_hash, video_id, upload_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [ownerId, idempotencyKey, requestHash, videoId, uploadId],
        );
        if (inserted.rowCount === 0) throw new IdempotencyRaceLost();
      }
      return { videoId, uploadId };
    });
    return { response: await buildCreateResponse(ids, input), replayed: false };
  } catch (err) {
    if (!(err instanceof IdempotencyRaceLost) || !idempotencyKey) throw err;
    const winner = await findIdempotentResult(ownerId, idempotencyKey, requestHash);
    if (!winner) throw err; // unreachable: the conflicting row was committed
    return { response: await buildCreateResponse(winner, input), replayed: true };
  }
}

async function findIdempotentResult(
  ownerId: string,
  key: string,
  requestHash: string,
): Promise<{ videoId: string; uploadId: string } | null> {
  const { rows } = await pool.query<{ request_hash: string; video_id: string; upload_id: string }>(
    `SELECT request_hash, video_id, upload_id FROM idempotency_keys WHERE owner_id = $1 AND key = $2`,
    [ownerId, key],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.request_hash !== requestHash) {
    throw new AppError(422, "idempotency_key_reused", "Idempotency-Key was already used with a different request body");
  }
  return { videoId: row.video_id, uploadId: row.upload_id };
}

async function buildCreateResponse(
  ids: { videoId: string; uploadId: string },
  input: CreateVideoInput,
): Promise<CreateVideoResponse> {
  const expiresAt = new Date(Date.now() + config.UPLOAD_URL_TTL_SECONDS * 1000);
  return {
    ...ids,
    uploadUrl: await presignUpload(originalKey(ids.videoId), input.fileSizeBytes),
    uploadUrlExpiresAt: expiresAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// POST /videos/:videoId/uploads/:uploadId/complete
// ---------------------------------------------------------------------------

interface UploadSessionRow {
  object_key: string;
  // pg returns Postgres `bigint` as a string, because JS numbers can't represent
  // every 64-bit integer exactly. We convert explicitly where we use it.
  expected_size: string;
  status: UploadSessionStatus;
  owner_id: string;
  video_status: VideoStatus;
}

/**
 * Verifies the bytes really landed in storage, then moves the video to `queued`.
 *
 * Safe to call repeatedly: a completed session just reports current state, and
 * the conditional UPDATEs (`WHERE status = 'pending'`) mean two concurrent
 * calls can't both "win" the transition.
 */
export async function completeUpload(
  ownerId: string,
  videoId: string,
  uploadId: string,
): Promise<{ videoId: string; status: VideoStatus }> {
  const { rows } = await pool.query<UploadSessionRow>(
    `SELECT s.object_key, s.expected_size, s.status, v.owner_id, v.status AS video_status
       FROM upload_sessions s JOIN videos v ON v.id = s.video_id
      WHERE s.id = $1 AND s.video_id = $2`,
    [uploadId, videoId],
  );
  const session = rows[0];
  // Same 404 for "doesn't exist" and "not yours" so IDs can't be probed.
  if (!session || session.owner_id !== ownerId) throw new NotFoundError("Upload");

  if (session.status === "completed") return { videoId, status: session.video_status };

  const actualSize = await headObjectSize(session.object_key);
  if (actualSize === null) {
    throw new AppError(409, "upload_incomplete", "No uploaded object found; upload the file before completing");
  }
  const expectedSize = Number(session.expected_size);
  if (actualSize !== expectedSize) {
    throw new AppError(422, "size_mismatch", "Uploaded object size does not match fileSizeBytes", {
      expectedSize,
      actualSize,
    });
  }

  const status = await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE upload_sessions SET status = 'completed', completed_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [uploadId],
    );
    await tx.query(
      `UPDATE videos SET status = 'queued', updated_at = now()
        WHERE id = $1 AND status = 'uploading'`,
      [videoId],
    );
    // M2: insert the probe job + outbox row here, in this same transaction.
    const { rows } = await tx.query<{ status: VideoStatus }>(`SELECT status FROM videos WHERE id = $1`, [videoId]);
    return rows[0]!.status;
  });

  return { videoId, status };
}

// ---------------------------------------------------------------------------
// GET /videos/:videoId/status
// ---------------------------------------------------------------------------

export async function getVideoStatus(ownerId: string, videoId: string): Promise<VideoStatusResponse> {
  const { rows } = await pool.query<{ status: VideoStatus }>(
    `SELECT status FROM videos WHERE id = $1 AND owner_id = $2`,
    [videoId, ownerId],
  );
  const video = rows[0];
  if (!video) throw new NotFoundError("Video");

  // Renditions don't exist until M4, so nothing is playable yet.
  return { videoId, status: video.status, playbackReady: false, availableResolutions: [] };
}
