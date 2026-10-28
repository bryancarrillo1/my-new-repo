import { withTransaction, type Queryable } from "./db.ts";
import type { ChaosSettings } from "./domain.ts";

// Fault injection lives in Postgres (one row) rather than in each process's
// memory, so every worker and the dispatcher see the same settings and the UI
// can flip them at runtime without restarts.

interface ChaosRow {
  failure_rate: number;
  permanent_failures: boolean;
  slow_factor: number;
  dispatcher_paused: boolean;
  crash_next: number;
}

const toView = (r: ChaosRow): ChaosSettings => ({
  failureRate: r.failure_rate,
  permanentFailures: r.permanent_failures,
  slowFactor: r.slow_factor,
  dispatcherPaused: r.dispatcher_paused,
  crashNext: r.crash_next,
});

export const NO_CHAOS: ChaosSettings = {
  failureRate: 0,
  permanentFailures: false,
  slowFactor: 1,
  dispatcherPaused: false,
  crashNext: 0,
};

export async function getChaos(db: Queryable): Promise<ChaosSettings> {
  const { rows } = await db.query<ChaosRow>(`SELECT * FROM chaos_settings`);
  return rows[0] ? toView(rows[0]) : NO_CHAOS;
}

/** Partial update: only the fields present in `patch` change. */
export async function updateChaos(patch: Partial<ChaosSettings>): Promise<ChaosSettings> {
  const { rows } = await withTransaction((tx) =>
    tx.query<ChaosRow>(
      `UPDATE chaos_settings SET
          failure_rate       = coalesce($1, failure_rate),
          permanent_failures = coalesce($2, permanent_failures),
          slow_factor        = coalesce($3, slow_factor),
          dispatcher_paused  = coalesce($4, dispatcher_paused),
          crash_next         = coalesce($5, crash_next),
          updated_at         = now()
       RETURNING *`,
      [
        patch.failureRate ?? null,
        patch.permanentFailures ?? null,
        patch.slowFactor ?? null,
        patch.dispatcherPaused ?? null,
        patch.crashNext ?? null,
      ],
    ),
  );
  return toView(rows[0]!);
}

/**
 * Atomically consumes one "crash the next job" token. The conditional
 * decrement means two workers can't both take the last token.
 */
export async function takeCrashToken(db: Queryable): Promise<boolean> {
  const res = await db.query(`UPDATE chaos_settings SET crash_next = crash_next - 1 WHERE crash_next > 0`);
  return res.rowCount === 1;
}
