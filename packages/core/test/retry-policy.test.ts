import { describe, expect, it } from "vitest";
import { PermanentError, RetryableError, backoffDelayMs, classifyError } from "../src/index.ts";

const opts = { baseMs: 1000, maxMs: 30_000 };

describe("backoffDelayMs (exponential, equal jitter)", () => {
  it("guarantees at least half the exponential delay, so delays really increase", () => {
    const floor = (attempt: number) => backoffDelayMs(attempt, opts, () => 0);
    expect([1, 2, 3, 4].map(floor)).toEqual([500, 1000, 2000, 4000]);
  });

  it("adds up to the other half at random", () => {
    expect(backoffDelayMs(3, opts, () => 0.999999)).toBe(4000);
    for (let i = 0; i < 100; i++) {
      const d = backoffDelayMs(3, opts);
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThanOrEqual(4000);
    }
  });

  it("caps at maxMs however many attempts have failed", () => {
    expect(backoffDelayMs(50, opts, () => 0.999999)).toBe(30_000);
    expect(backoffDelayMs(50, opts, () => 0)).toBe(15_000);
  });
});

describe("classifyError", () => {
  it("treats only explicit PermanentErrors as permanent", () => {
    expect(classifyError(new PermanentError("corrupt input"))).toBe("permanent");
    expect(classifyError(new RetryableError("timeout"))).toBe("retryable");
    // Unknown errors are assumed transient; max_attempts bounds the cost.
    expect(classifyError(new Error("ECONNRESET"))).toBe("retryable");
    expect(classifyError("a thrown string")).toBe("retryable");
  });
});
