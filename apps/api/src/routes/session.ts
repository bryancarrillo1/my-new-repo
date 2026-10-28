import type { FastifyInstance } from "fastify";
import { z } from "zod";

export const SESSION_COOKIE = "vpp_user";

const LoginBody = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{2,32}$/, "2–32 letters, digits, _ or -"),
});

// Demo "login": no password, just a signed cookie naming the user. It exists
// because browsers' EventSource (used for live updates) can't send custom
// headers, so the X-User-Id stub doesn't work there. Real auth would replace
// this route and the cookie check in server.ts, nothing else.
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/session", async (req, reply) => {
    const { username } = LoginBody.parse(req.body);
    reply.setCookie(SESSION_COOKIE, username, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      signed: true,
      maxAge: 60 * 60 * 24 * 30,
    });
    return { username };
  });

  // Public: answers "who am I?" with null instead of a 401 when logged out,
  // so the UI's first load doesn't log an error.
  app.get("/session", async (req) => ({ username: req.userId || null }));

  app.delete("/session", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });
}
