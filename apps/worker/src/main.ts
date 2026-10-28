import { pool } from "@vpp/core";
import { makeWorkerId, runWorker } from "./worker.ts";

const workerId = makeWorkerId();
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown.abort());
}

console.info(`[${workerId}] started`);
await runWorker(workerId, shutdown.signal);
await pool.end();
console.info(`[${workerId}] stopped`);
