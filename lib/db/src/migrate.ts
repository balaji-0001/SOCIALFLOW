import type { Pool } from "pg";
import { migrations } from "./migrations";

/**
 * Applies any migrations this database hasn't seen yet, in order, each in its own transaction. Safe to call from
 * several processes at once: a Postgres advisory lock serialises them, and the second one finds nothing to do.
 * Returns the names that were applied.
 */
export async function runMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock(7241001)");
    await client.query(`create table if not exists socialflow_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query<{ name: string }>("select name from socialflow_migrations")).rows.map((row) => row.name));
    for (const migration of migrations) {
      if (done.has(migration.name)) continue;
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query("insert into socialflow_migrations (name) values ($1)", [migration.name]);
        await client.query("commit");
        applied.push(migration.name);
      } catch (error) {
        await client.query("rollback");
        throw new Error(`Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(7241001)").catch(() => {});
    client.release();
  }
  return applied;
}
