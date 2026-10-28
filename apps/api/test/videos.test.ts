import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { config, originalKey, pool, s3 } from "@vpp/core";
import { buildApp } from "../src/server.ts";

let app: FastifyInstance;
// A fresh user per run keeps tests independent without truncating tables.
const user = `test-user-${crypto.randomUUID()}`;
const headers = { "x-user-id": user };

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function createVideo(size: number, extraHeaders: Record<string, string> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/videos",
    headers: { ...headers, ...extraHeaders },
    payload: { title: "My video", fileName: "clip.mp4", fileSizeBytes: size },
  });
  return { res, body: res.json() };
}

function complete(videoId: string, uploadId: string, asUser = user) {
  return app.inject({
    method: "POST",
    url: `/videos/${videoId}/uploads/${uploadId}/complete`,
    headers: { "x-user-id": asUser },
  });
}

/** Uploads bytes straight to object storage, exactly as a real client would. */
async function putBytes(uploadUrl: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const res = await fetch(uploadUrl, { method: "PUT", body: bytes });
  expect(res.status).toBe(200);
}

describe("upload flow", () => {
  it("rejects requests without an identity", async () => {
    const res = await app.inject({ method: "POST", url: "/videos", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("validates the request body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/videos",
      headers,
      payload: { title: "", fileName: "x.mp4", fileSizeBytes: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("create → upload → complete moves the video to queued, and complete is idempotent", async () => {
    const bytes = new TextEncoder().encode("not really a video");
    const { res, body } = await createVideo(bytes.length);
    expect(res.statusCode).toBe(201);
    expect(body.uploadUrl).toContain(body.videoId);

    const status0 = await app.inject({ url: `/videos/${body.videoId}/status`, headers });
    expect(status0.json()).toMatchObject({ status: "uploading", playbackReady: false });

    await putBytes(body.uploadUrl, bytes);

    const first = await complete(body.videoId, body.uploadId);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ videoId: body.videoId, status: "queued" });

    const second = await complete(body.videoId, body.uploadId);
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
  });

  it("refuses to complete before any bytes are uploaded", async () => {
    const { body } = await createVideo(100);
    const res = await complete(body.videoId, body.uploadId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("upload_incomplete");
  });

  it("refuses to complete when the uploaded size does not match", async () => {
    const { body } = await createVideo(10);
    // The presigned URL is signed for 10 bytes, so storage itself rejects 5.
    const res = await fetch(body.uploadUrl, { method: "PUT", body: new Uint8Array(5) });
    expect(res.ok).toBe(false);
    const done = await complete(body.videoId, body.uploadId);
    expect(done.statusCode).toBe(409);
  });

  it("double-checks size on complete even if storage accepted a different object", async () => {
    const { body } = await createVideo(10);
    // Bypass the presigned URL (e.g. a misbehaving client or storage) to land 3 bytes.
    await s3.send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: originalKey(body.videoId), Body: "abc" }));
    const res = await complete(body.videoId, body.uploadId);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "size_mismatch", expectedSize: 10, actualSize: 3 });
  });

  it("hides other users' uploads", async () => {
    const { body } = await createVideo(10);
    const res = await complete(body.videoId, body.uploadId, "someone-else");
    expect(res.statusCode).toBe(404);
  });
});

describe("idempotent create", () => {
  it("replays the same video for a repeated key", async () => {
    const key = { "idempotency-key": crypto.randomUUID() };
    const a = await createVideo(42, key);
    const b = await createVideo(42, key);
    expect(b.res.statusCode).toBe(201);
    expect(b.res.headers["idempotent-replayed"]).toBe("true");
    expect(b.body.videoId).toBe(a.body.videoId);
    expect(b.body.uploadId).toBe(a.body.uploadId);
  });

  it("creates exactly one video when the same key races", async () => {
    const key = { "idempotency-key": crypto.randomUUID() };
    const results = await Promise.all(Array.from({ length: 5 }, () => createVideo(7, key)));
    const ids = new Set(results.map((r) => r.body.videoId));
    expect(ids.size).toBe(1);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM videos WHERE id = $1", [[...ids][0]]);
    expect(rows[0].n).toBe(1);
  });

  it("rejects reusing a key with a different body", async () => {
    const key = { "idempotency-key": crypto.randomUUID() };
    await createVideo(1, key);
    const { res } = await createVideo(2, key);
    expect(res.statusCode).toBe(422);
  });
});

describe("session + live events", () => {
  it("logs in with a signed cookie that authenticates later requests", async () => {
    const login = await app.inject({ method: "POST", url: "/session", payload: { username: "cookie-user" } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies[0]!;
    const me = await app.inject({ url: "/session", cookies: { [cookie.name]: cookie.value } });
    expect(me.json()).toEqual({ username: "cookie-user" });

    // An unsigned (forged) cookie is ignored: you're simply not logged in.
    const forged = await app.inject({ url: "/session", cookies: { [cookie.name]: "cookie-user" } });
    expect(forged.json()).toEqual({ username: null });
    const blocked = await app.inject({ url: "/videos", cookies: { [cookie.name]: "cookie-user" } });
    expect(blocked.statusCode).toBe(401);
  });

  it("streams the owner's pipeline events over SSE", async () => {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const abort = new AbortController();
    const res = await fetch(`${address}/events`, { headers, signal: abort.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const bytes = new TextEncoder().encode("abc");
    const { body } = await createVideo(bytes.length);
    await putBytes(body.uploadUrl, bytes);
    await complete(body.videoId, body.uploadId);

    // Read chunks until we see the upload_completed event for our video.
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (!text.includes(`"type":"upload_completed"`)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += value;
    }
    abort.abort();
    expect(text).toContain(`"videoId":"${body.videoId}"`);
    expect(text).toContain(`"type":"job_created"`);
  });
});
