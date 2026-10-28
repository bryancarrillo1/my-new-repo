-- M2: background processing. Postgres owns job state; the queue only carries
-- job IDs. The outbox makes "commit job" and "enqueue job" atomic.

CREATE TABLE processing_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id          uuid NOT NULL REFERENCES videos (id),
  kind              text NOT NULL CHECK (kind IN ('probe', 'transcode')),
  -- Output height for transcode jobs; 0 for probe (0, not NULL, so the UNIQUE
  -- constraint below treats it as a value).
  target_height     int NOT NULL DEFAULT 0,
  state             text NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'running', 'completed', 'failed')),
  -- Incremented on every claim. Doubles as the fencing token: a worker may only
  -- write results while the row still carries the attempt number it claimed.
  attempt           int NOT NULL DEFAULT 0,
  max_attempts      int NOT NULL DEFAULT 4,
  lease_owner       text,
  lease_expires_at  timestamptz,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  progress          real NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  -- Creating the same job twice is a no-op, which makes fan-out idempotent.
  UNIQUE (video_id, kind, target_height)
);
CREATE INDEX processing_jobs_video_idx ON processing_jobs (video_id);
CREATE INDEX processing_jobs_running_idx ON processing_jobs (lease_expires_at) WHERE state = 'running';

-- Durable "please send this job to the queue" instructions, written in the same
-- transaction as the job. The dispatcher sends unsent rows and marks them sent.
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  job_id        uuid NOT NULL REFERENCES processing_jobs (id),
  available_at  timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_unsent_idx ON outbox (available_at) WHERE sent_at IS NULL;

-- Append-only timeline that powers the UI's pipeline view.
CREATE TABLE job_events (
  id         bigserial PRIMARY KEY,
  video_id   uuid NOT NULL REFERENCES videos (id),
  job_id     uuid REFERENCES processing_jobs (id),
  type       text NOT NULL,
  attempt    int,
  worker_id  text,
  detail     jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_events_video_idx ON job_events (video_id, id);

-- A rendition row exists only once its output is complete and verified, so
-- "rows in this table" == "resolutions we may advertise".
CREATE TABLE renditions (
  video_id       uuid NOT NULL REFERENCES videos (id),
  height         int NOT NULL,
  output_prefix  text NOT NULL,
  verified_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, height)
);
