import pg from "pg";
import { TEST_ENV } from "./test-env.ts";

export async function setup(): Promise<void> {
  // Create the test database if needed (CREATE DATABASE can't use IF NOT EXISTS).
  const admin = new pg.Client({ connectionString: TEST_ENV.DATABASE_URL.replace(/\/vpp_test$/, "/vpp") });
  await admin.connect();
  const { rowCount } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'vpp_test'`);
  if (!rowCount) await admin.query(`CREATE DATABASE vpp_test`);
  await admin.end();

  // @vpp/core reads config at import time, so set the env before importing it.
  Object.assign(process.env, TEST_ENV);
  const core = await import("@vpp/core");
  await core.migrate();
  await core.ensureBucket();
  await core.purgeQueue();
  // Leftover unsent outbox rows from earlier runs would otherwise be dispatched now.
  await core.pool.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
  await core.pool.end();
}
