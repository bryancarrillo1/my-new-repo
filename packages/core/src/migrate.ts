import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pool, withTransaction } from "./db.ts";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../../migrations");

/** Apply every migrations/*.sql file not yet recorded, in filename order. */
export async function migrate(): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];

  for (const name of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
    const didApply = await withTransaction(async (tx) => {
      // The lock serialises concurrent migrators (e.g. two test processes).
      await tx.query("LOCK TABLE schema_migrations IN EXCLUSIVE MODE");
      const { rowCount } = await tx.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
      if (rowCount) return false;
      await tx.query(sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      return true;
    });
    if (didApply) applied.push(name);
  }
  return applied;
}
