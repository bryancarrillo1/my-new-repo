// Domain types shared by the API, dispatcher, workers and the web UI.
// This file must stay free of Node-only imports: the browser bundle imports it
// via "@vpp/core/domain".

// A union of string literals is TypeScript's lightweight enum (≈ Python's Literal[...]).
// `as const` keeps the array's element types as literals so we can derive the type from it.
export const VIDEO_STATUSES = ["uploading", "queued", "processing", "ready", "failed"] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export const UPLOAD_SESSION_STATUSES = ["pending", "completed"] as const;
export type UploadSessionStatus = (typeof UPLOAD_SESSION_STATUSES)[number];

export type JobKind = "probe" | "transcode";
export type JobState = "pending" | "running" | "completed" | "failed";

/** Output heights we produce, smallest first. */
export const TARGET_HEIGHTS = [360, 720, 1080] as const;

// ---------------------------------------------------------------------------
// API response shapes. The UI imports these too, so both sides compile
// against one definition.
// ---------------------------------------------------------------------------

export interface CreateVideoResponse {
  videoId: string;
  uploadId: string;
  uploadUrl: string;
  uploadUrlExpiresAt: string;
}

export interface VideoSummary {
  videoId: string;
  title: string;
  status: VideoStatus;
  playbackReady: boolean;
  availableResolutions: number[];
  /** Mean progress of transcode jobs (0–1), or null before any exist. */
  progress: number | null;
  createdAt: string;
}

export interface JobView {
  jobId: string;
  kind: JobKind;
  targetHeight: number;
  state: JobState;
  attempt: number;
  maxAttempts: number;
  progress: number;
  leaseOwner: string | null;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobEventView {
  id: number;
  jobId: string | null;
  type: string;
  attempt: number | null;
  workerId: string | null;
  detail: Record<string, unknown>;
  at: string;
}

export interface VideoDetail extends VideoSummary {
  jobs: JobView[];
  events: JobEventView[];
}

/** Payload pushed over Server-Sent Events. A hint to refetch, not the state itself. */
export interface PipelineEvent {
  videoId: string;
  ownerId: string;
  type: string;
  jobId: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base error carrying an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(404, "not_found", `${what} not found`);
  }
}
