import { describe, expect, it } from "vitest";
import { computeVideoStatus, type JobKind, type JobState } from "../src/index.ts";

const probe = (state: JobState) => ({ kind: "probe" as JobKind, state });
const transcode = (state: JobState) => ({ kind: "transcode" as JobKind, state });

describe("computeVideoStatus", () => {
  it("has nothing to say before any job exists", () => {
    expect(computeVideoStatus([], 0)).toBeNull();
  });

  it("is queued while every job is still pending", () => {
    expect(computeVideoStatus([probe("pending")], 0)).toBe("queued");
  });

  it("is processing once any job has started", () => {
    expect(computeVideoStatus([probe("running")], 0)).toBe("processing");
    expect(computeVideoStatus([probe("completed"), transcode("pending")], 0)).toBe("processing");
  });

  it("stays processing while a rendition is already playable", () => {
    expect(computeVideoStatus([probe("completed"), transcode("completed"), transcode("running")], 1)).toBe(
      "processing",
    );
  });

  it("is ready when all jobs are done and at least one rendition exists, even if some failed", () => {
    expect(computeVideoStatus([probe("completed"), transcode("completed"), transcode("failed")], 1)).toBe("ready");
  });

  it("fails when the probe fails or nothing could be produced", () => {
    expect(computeVideoStatus([probe("failed")], 0)).toBe("failed");
    expect(computeVideoStatus([probe("completed"), transcode("failed"), transcode("failed")], 0)).toBe("failed");
  });
});
