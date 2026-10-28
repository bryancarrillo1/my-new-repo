# Video Processing Pipeline

A TypeScript implementation of the design in [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md), built milestone by milestone.

| Milestone | Status |
|---|---|
| M0 Scaffold (workspaces, Docker infra, migrations) | ✅ |
| M1 Create / upload / complete / status, idempotent create | ✅ |
| M2 Probe job + transactional outbox + dispatcher + fake worker | ⏳ next |
| M3 Leases, fencing, retries, DLQ, fault injection | |
| M4 ffprobe/ffmpeg fan-out, verified renditions | |
| M5 Versioned manifests, playback API, CDN cache, player | |
| M6 Resumable multipart uploads + CLI | |
| M7 Reconciler, metrics, load test | |

## Layout

```
apps/api/            Fastify HTTP API (routes → service → SQL)
packages/core/       Shared config, Postgres, S3 storage, migrations, domain types
migrations/          Plain .sql files, applied in filename order
infra/               Config for the local S3 (SeaweedFS) and SQS (ElasticMQ) stand-ins
scripts/             setup (migrate + create bucket), test global setup
```

## Running locally

Requires Node 24+ and Docker.

```sh
npm install
npm run infra:up     # Postgres :5433, S3 :8333, SQS :9324
npm run setup        # apply migrations, create bucket (safe to re-run)
npm test             # integration tests against the real containers
npm run dev:api      # API on :3000, reloads on change
```

### Walk through the upload flow

```sh
printf 'fake video bytes' > /tmp/clip.mp4
SIZE=$(stat -f%z /tmp/clip.mp4)   # Linux: stat -c%s

# 1. Create — the API returns a presigned URL; bytes never go through the API.
curl -s -X POST localhost:3000/videos \
  -H 'x-user-id: alice' -H 'content-type: application/json' \
  -H 'idempotency-key: demo-1' \
  -d "{\"title\":\"Demo\",\"fileName\":\"clip.mp4\",\"fileSizeBytes\":$SIZE}"

# 2. Upload straight to object storage
curl -X PUT --data-binary @/tmp/clip.mp4 "<uploadUrl>"

# 3. Complete (call it twice: same answer, no duplicate work)
curl -s -X POST localhost:3000/videos/<videoId>/uploads/<uploadId>/complete -H 'x-user-id: alice'

# 4. Status
curl -s localhost:3000/videos/<videoId>/status -H 'x-user-id: alice'
```

`X-User-Id` is an auth stub: the server takes ownership from it, never from the request body.

## Things worth breaking on purpose

- Re-send step 1 with the same `idempotency-key`: same `videoId`, header `idempotent-replayed: true`.
- Re-send it with the same key but a different body: `422 idempotency_key_reused`.
- Call step 3 before step 2: `409 upload_incomplete`.
- Upload fewer bytes than declared: storage rejects it, because `Content-Length` is part of the signature.

## Notes

- **S3 server:** MinIO no longer publishes community Docker images, so local S3 is SeaweedFS. The code is plain AWS SDK v3 and works unchanged against real S3.
- **Presigned URLs + AWS SDK checksums:** the S3 client sets `requestChecksumCalculation: "WHEN_REQUIRED"`. Without it, the SDK signs a CRC32 of an empty body into presigned PUT URLs and every real upload fails with `BadDigest`.
