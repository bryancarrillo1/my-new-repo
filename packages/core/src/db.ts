import pg from "pg";
import { config } from "./config.ts";

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

// Anything that can run a query: the pool itself or a client inside a transaction.
// Repository functions accept this so callers decide the transaction boundary.
export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * Run `fn` inside BEGIN/COMMIT, rolling back if it throws.
 * Python analogue: `with conn.transaction(): ...`
 */
export async function withTransaction<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
