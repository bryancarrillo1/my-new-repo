import type { FastifyInstance } from "fastify";
import type { EventHub } from "../events.ts";

const KEEPALIVE_MS = 15_000;

/**
 * GET /events — Server-Sent Events stream of the caller's pipeline events.
 * SSE is plain HTTP: the response never ends and each message is a
 * `data: ...\n\n` chunk. Browsers reconnect automatically if it drops.
 */
export function eventRoutes(hub: EventHub) {
  return async (app: FastifyInstance): Promise<void> => {
    // Streams never finish by themselves, so end them when the server shuts
    // down; otherwise graceful shutdown would wait on them forever.
    const open = new Set<NodeJS.WritableStream>();
    app.addHook("preClose", async () => {
      for (const res of open) res.end();
    });

    app.get("/events", (req, reply) => {
      // Take over the raw Node response; Fastify won't try to serialize a body.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        // Stop nginx (the gateway in M9) from buffering the stream.
        "x-accel-buffering": "no",
      });
      res.write(": connected\n\n");
      open.add(res);

      const unsubscribe = hub.subscribe((event) => {
        if (event.ownerId !== req.userId) return; // only your own videos
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      // Comment lines keep idle proxies from closing the connection.
      const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);

      req.raw.on("close", () => {
        clearInterval(keepalive);
        unsubscribe();
        open.delete(res);
      });
    });
  };
}
