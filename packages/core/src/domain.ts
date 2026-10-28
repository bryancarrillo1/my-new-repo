// Domain types shared by the API, dispatcher and workers.

// A union of string literals is TypeScript's lightweight enum (≈ Python's Literal[...]).
// `as const` keeps the array's element types as literals so we can derive the type from it.
export const VIDEO_STATUSES = ["uploading", "queued", "processing", "ready", "failed"] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export const UPLOAD_SESSION_STATUSES = ["pending", "completed"] as const;
export type UploadSessionStatus = (typeof UPLOAD_SESSION_STATUSES)[number];

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
