import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, NotFoundError } from "@vpp/core";
import {
  getSystemView,
  killWorker,
  redriveDeadLetters,
  resetChaos,
  retryJob,
  setChaos,
} from "../admin.service.ts";

const ChaosPatch = z
  .object({
    failureRate: z.number().min(0).max(1),
    permanentFailures: z.boolean(),
    slowFactor: z.number().min(1).max(10),
    dispatcherPaused: z.boolean(),
    crashNext: z.number().int().min(0).max(10),
  })
  .partial()
  .strict();

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/system", () => getSystemView());

  app.patch("/admin/chaos", async (req) => {
    const patch = ChaosPatch.parse(req.body);
    // zod's partial() output types each key as `T | undefined`; strip the
    // undefineds so the object satisfies Partial<ChaosSettings> exactly.
    return setChaos(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  });

  app.post("/admin/chaos/reset", () => resetChaos());

  app.post("/admin/workers/:workerId/kill", async (req, reply) => {
    const { workerId } = z.object({ workerId: z.string().min(1) }).parse(req.params);
    if (!(await killWorker(workerId))) throw new NotFoundError("Worker");
    return reply.status(202).send({ workerId, killRequested: true });
  });

  app.post("/admin/jobs/:jobId/retry", async (req, reply) => {
    const { jobId } = z.object({ jobId: z.uuid() }).parse(req.params);
    if (!(await retryJob(jobId, `operator:${req.userId}`))) {
      throw new AppError(409, "job_not_failed", "Only failed jobs can be retried");
    }
    return reply.status(202).send({ jobId, state: "pending" });
  });

  app.post("/admin/dlq/redrive", (req) => redriveDeadLetters(`operator:${req.userId}`));
}
