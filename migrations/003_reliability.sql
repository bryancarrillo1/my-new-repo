-- M4: retries, dead-lettering, worker registry, chaos controls.

-- The outbox can now target either queue. A job that exhausts its retries (or
-- fails permanently) gets a 'dead-letter' outbox row in the same transaction
-- that marks it failed, so "job failed" and "job is in the DLQ" can't diverge.
ALTER TABLE outbox
  ADD COLUMN queue text NOT NULL DEFAULT 'jobs' CHECK (queue IN ('jobs', 'dead-letter'));

-- Why the last attempt failed: retryable errors get another attempt (until
-- max_attempts), permanent ones (corrupt or unsupported input) fail at once.
ALTER TABLE processing_jobs
  ADD COLUMN error_kind text CHECK (error_kind IN ('retryable', 'permanent'));

-- Live worker processes, kept fresh by a heartbeat. The reconciler removes
-- rows whose heartbeat stopped (crashed workers).
CREATE TABLE workers (
  id              text PRIMARY KEY,
  hostname        text NOT NULL,
  pid             int NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  current_job_id  uuid REFERENCES processing_jobs (id),
  -- Set by the chaos panel; the worker hard-exits mid-job when it sees it.
  kill_requested  boolean NOT NULL DEFAULT false
);

-- Fault injection, stored as data so every worker and the dispatcher read
-- the same settings and the UI can change them at runtime. Exactly one row.
CREATE TABLE chaos_settings (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Probability that a job fails with a transient (retryable) error.
  failure_rate        real NOT NULL DEFAULT 0 CHECK (failure_rate BETWEEN 0 AND 1),
  -- Every job fails with a permanent error (e.g. "unsupported codec").
  permanent_failures  boolean NOT NULL DEFAULT false,
  -- Multiplies job duration, to make races and timeouts easy to watch.
  slow_factor         real NOT NULL DEFAULT 1 CHECK (slow_factor BETWEEN 1 AND 10),
  -- Dispatcher stops sending outbox rows (and reconciling): a dispatcher outage.
  dispatcher_paused   boolean NOT NULL DEFAULT false,
  -- One-shot: the next N jobs crash their worker after the work, before the
  -- DB commit, i.e. "output saved but database not updated".
  crash_next          int NOT NULL DEFAULT 0 CHECK (crash_next >= 0),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO chaos_settings DEFAULT VALUES;
