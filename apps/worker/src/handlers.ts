import { setTimeout as sleep } from "node:timers/promises";
import {
  TARGET_HEIGHTS,
  config,
  enqueueJob,
  markJobCompleted,
  recomputeVideoStatus,
  updateProgress,
  withTransaction,
  type JobKind,
  type JobRow,
} from "@vpp/core";
import type { Faults } from "./faults.ts";

export interface JobContext {
  job: JobRow;
  workerId: string;
  signal: AbortSignal;
  faults: Faults;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

// Placeholders: they simulate work with sleeps so the queue/outbox/claim
// machinery can be built and observed before real ffmpeg arrives in M5.

/** Pretends to inspect the source, then fans out one transcode job per target height. */
const probe: JobHandler = async ({ job, workerId, signal, faults }) => {
  faults.atStart();
  await sleep(config.PLACEHOLDER_STEP_MS * faults.slowFactor, undefined, { signal });
  await faults.beforeCommit();
  await withTransaction(async (tx) => {
    // Fence first: if we no longer own the job, nothing below is written.
    await markJobCompleted(tx, job, workerId);
    // Fan-out is idempotent thanks to UNIQUE(video_id, kind, target_height).
    for (const height of TARGET_HEIGHTS) {
      await enqueueJob(tx, { videoId: job.video_id, kind: "transcode", targetHeight: height });
    }
    await recomputeVideoStatus(tx, job.video_id);
  });
};

/** Pretends to transcode in 10 steps, reporting progress, then records a rendition. */
const transcode: JobHandler = async ({ job, workerId, signal, faults }) => {
  faults.atStart();
  for (let step = 1; step <= 10; step++) {
    await sleep(config.PLACEHOLDER_STEP_MS * faults.slowFactor, undefined, { signal });
    await updateProgress(job, step / 10);
  }
  await faults.beforeCommit();
  await withTransaction(async (tx) => {
    await markJobCompleted(tx, job, workerId);
    await tx.query(
      `INSERT INTO renditions (video_id, height, output_prefix) VALUES ($1, $2, $3)
       ON CONFLICT (video_id, height) DO NOTHING`,
      [job.video_id, job.target_height, `placeholder/${job.video_id}/${job.target_height}/a${job.attempt}/`],
    );
    await recomputeVideoStatus(tx, job.video_id);
  });
};

// `Record<JobKind, JobHandler>` makes the compiler insist on a handler for
// every job kind — add a kind to the union and this line stops compiling.
export const handlers: Record<JobKind, JobHandler> = { probe, transcode };
