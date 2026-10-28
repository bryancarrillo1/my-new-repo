// Idempotent: safe to run on every start. Applies DB migrations and creates the bucket.
import { ensureBucket, migrate, pool } from "@vpp/core";

const applied = await migrate();
console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Migrations up to date");
await ensureBucket();
console.log("Bucket ready");
await pool.end();
