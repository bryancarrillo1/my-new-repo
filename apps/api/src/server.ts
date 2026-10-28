import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { AppError, config, pool } from "@vpp/core";
import { EventHub } from "./events.ts";
import { adminRoutes } from "./routes/admin.ts";
import { eventRoutes } from "./routes/events.ts";
import { SESSION_COOKIE, sessionRoutes } from "./routes/session.ts";
import { videoRoutes } from "./routes/videos.ts";

// Module augmentation: teach TypeScript that every request carries `userId`,
// which the auth hook below fills in. (Python has no equivalent; you'd just
// monkeypatch the attribute and hope.)
declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

// Routes reachable without an identity, keyed by "METHOD path". They still get
// `req.userId` filled in when the caller happens to be logged in.
const PUBLIC_ROUTES = new Set(["GET /health", "POST /session", "GET /session"]);

/** Who is calling: X-User-Id header (tests, curl) or the signed demo cookie (browser). */
function identify(req: FastifyRequest): string {
  const header = req.headers["x-user-id"];
  if (typeof header === "string" && header.length > 0) return header;
  const raw = req.cookies[SESSION_COOKIE];
  const unsigned = raw ? req.unsignCookie(raw) : null;
  return unsigned?.valid && unsigned.value ? unsigned.value : "";
}

/** Builds the app without listening, so tests can drive it with `app.inject()`. */
export function buildApp(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const hub = new EventHub();

  app.register(cookie, { secret: config.SESSION_SECRET });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });

  // Auth stub: the server derives ownership from the caller's identity, never
  // from the request body. Accepts the signed demo cookie (browser) or an
  // X-User-Id header (tests, curl). Swap this for real auth later.
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    req.userId = identify(req);
    if (!req.userId && !PUBLIC_ROUTES.has(`${req.method} ${req.routeOptions.url}`)) {
      throw new AppError(401, "unauthenticated", "Log in first (POST /session) or send X-User-Id");
    }
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

  app.addHook("onReady", () => hub.start());
  app.addHook("onClose", () => hub.close());

  app.register(sessionRoutes);
  app.register(videoRoutes);
  app.register(eventRoutes(hub));
  app.register(adminRoutes);
  return app;
}
