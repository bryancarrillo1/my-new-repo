import {
  PermanentError,
  RetryableError,
  pool,
  takeCrashToken,
  type ChaosSettings,
} from "@vpp/core";

/**
 * Thrown only by tests' replacement for runtime.crash. processMessage lets it
 * escape untouched, so a simulated crash leaves the job exactly as a real one
 * would: running, lease held, message unacknowledged.
 */
export class SimulatedCrash extends Error {
  override name = "SimulatedCrash";
}

/**
 * How the worker "crashes". A real hard exit (no cleanup, no lease release:
 * exactly what `kill -9` or an OOM does). Tests replace it, because
 * process.exit would take the test runner down with it.
 */
export const runtime = {
  crash(reason: string): never {
    console.error(`[worker] CRASH: ${reason}`);
    process.exit(137);
  },
};

/**
 * Fault-injection hooks that handlers call at fixed points. Driven by the
 * chaos_settings row, which the System page edits. With default settings
 * they do nothing.
 */
export interface Faults {
  /** Scales simulated work time (slow mode). */
  readonly slowFactor: number;
  /** Start of a job: where corrupt or unsupported input would be detected. */
  atStart(): void;
  /** Work done, results not yet committed: the riskiest moment to fail. */
  beforeCommit(): Promise<void>;
}

export function faultsFrom(chaos: ChaosSettings, random: () => number = Math.random): Faults {
  return {
    slowFactor: chaos.slowFactor,
    atStart() {
      if (chaos.permanentFailures) {
        throw new PermanentError("Unsupported codec (injected by chaos settings)");
      }
    },
    async beforeCommit() {
      if (chaos.failureRate > 0 && random() < chaos.failureRate) {
        throw new RetryableError("Storage write timed out (injected transient failure)");
      }
      // "Output saved, database not updated" (PROJECT_OVERVIEW): the worker dies
      // after doing the work but before recording it. The lease expires and the
      // job is redone; attempt-scoped output paths keep the two attempts apart.
      if (chaos.crashNext > 0 && (await takeCrashToken(pool))) {
        runtime.crash("injected crash after output write, before DB commit");
      }
    },
  };
}
