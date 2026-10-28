import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AppError, pool } from "@vpp/core";
import { videoRoutes } from "./routes/videos.ts";

// Module augmentation: teach TypeScript that every request carries `userId`,
// which the auth hook below fills in. (Python has no equivalent; you'd just
// monkeypatch the attribute and hope.)
declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

/** Builds the app without listening, so tests can drive it with `app.inject()`. */
export function buildApp(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });

  // Auth stub: the server derives ownership from the caller's identity, never
  // from the request body. Swap this for real auth (JWT, session) later.
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    if (req.url === "/health") return;
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId.length === 0) {
      throw new AppError(401, "unauthenticated", "Missing X-User-Id header");
    }
    req.userId = userId;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "invalid_request", issues: err.issues });
    }
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, ...err.details });
    }
    req.log.error(err);
    return reply.status(500).send({ error: "internal" });
  });

  app.register(videoRoutes);
  return app;
}
