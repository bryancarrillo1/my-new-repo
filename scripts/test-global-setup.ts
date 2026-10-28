import { ensureBucket, migrate, pool } from "@vpp/core";

export async function setup(): Promise<void> {
  await migrate();
  await ensureBucket();
  await pool.end();
}
