-- M1 schema: videos, upload sessions, idempotency keys.
-- Processing jobs, renditions and the outbox arrive in later migrations.

CREATE TABLE videos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    text NOT NULL,
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'uploading'
              CHECK (status IN ('uploading', 'queued', 'processing', 'ready', 'failed')),
  source_key  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX videos_owner_idx ON videos (owner_id, created_at DESC);

CREATE TABLE upload_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id        uuid NOT NULL REFERENCES videos (id),
  object_key      text NOT NULL,
  file_name       text NOT NULL,
  expected_size   bigint NOT NULL CHECK (expected_size > 0),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  -- Multipart upload ID; null for single-PUT uploads (multipart arrives in M6).
  s3_upload_id    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX upload_sessions_video_idx ON upload_sessions (video_id);

-- Makes POST /videos safe to retry. The key is scoped per owner, and we keep a
-- hash of the request so reusing a key with a different body is rejected.
CREATE TABLE idempotency_keys (
  owner_id      text NOT NULL,
  key           text NOT NULL,
  request_hash  text NOT NULL,
  video_id      uuid NOT NULL REFERENCES videos (id),
  upload_id     uuid NOT NULL REFERENCES upload_sessions (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, key)
);
