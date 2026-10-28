import { pool } from "@vpp/core";
import { runDispatcher } from "./dispatcher.ts";

// AbortController is JS's standard cancellation primitive (≈ an asyncio Event
// that every awaiting call can observe). Signals abort it; the loop exits cleanly.
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown.abort());
}

console.info("[dispatcher] started");
await runDispatcher(shutdown.signal);
await pool.end();
console.info("[dispatcher] stopped");
