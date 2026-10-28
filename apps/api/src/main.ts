import { config, pool } from "@vpp/core";
import { buildApp } from "./server.ts";

const app = buildApp({ logger: true });

// Graceful shutdown: stop accepting requests, let in-flight ones finish, then
// close the DB pool. Same idea as handling SIGTERM in a Python service.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: config.API_PORT, host: "0.0.0.0" });
