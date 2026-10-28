import { api } from "./api.ts";

/**
 * Where an upload is. A *discriminated union*: the `phase` field tells
 * TypeScript which other fields exist, so `state.loaded` only type-checks
 * inside an `if (state.phase === "uploading")` branch. (Python's closest
 * equivalent is a tagged union of dataclasses matched with `match`.)
 */
export type UploadState =
  | { phase: "idle" }
  | { phase: "creating" }
  | { phase: "uploading"; loaded: number; total: number; bytesPerSecond: number }
  | { phase: "finalizing" }
  | { phase: "done"; videoId: string }
  | { phase: "error"; message: string };

/**
 * PUTs a file to a presigned URL, reporting progress.
 *
 * Why XMLHttpRequest and not fetch? fetch has no upload-progress events
 * (streaming request bodies would work but need HTTP/2 and aren't supported
 * everywhere). XHR's `upload.onprogress` is still the portable way.
 */
export function putWithProgress(
  url: string,
  body: Blob,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Storage rejected the upload (HTTP ${xhr.status})`));
    xhr.onerror = () => reject(new Error("Network error while uploading to storage"));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/**
 * The whole client-side upload flow:
 *   1. POST /videos            reserve a video + get a presigned URL
 *   2. PUT  <presigned URL>    bytes go browser → storage, never via the API
 *   3. POST …/complete         API verifies the object and queues processing
 *
 * The idempotency key is generated once per file selection, so if the user
 * retries after a network blip, step 1 returns the same video, not a duplicate.
 */
export async function uploadVideo(opts: {
  file: File;
  title: string;
  idempotencyKey: string;
  onState: (s: UploadState) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { file, title, idempotencyKey, onState, signal } = opts;

  onState({ phase: "creating" });
  const created = await api.createVideo(
    { title, fileName: file.name, fileSizeBytes: file.size },
    idempotencyKey,
  );

  const started = performance.now();
  onState({ phase: "uploading", loaded: 0, total: file.size, bytesPerSecond: 0 });
  await putWithProgress(
    created.uploadUrl,
    file,
    (loaded, total) => {
      const seconds = (performance.now() - started) / 1000;
      onState({ phase: "uploading", loaded, total, bytesPerSecond: seconds > 0 ? loaded / seconds : 0 });
    },
    signal,
  );

  onState({ phase: "finalizing" });
  await api.completeUpload(created.videoId, created.uploadId);
  onState({ phase: "done", videoId: created.videoId });
  return created.videoId;
}
