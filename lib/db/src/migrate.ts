import type { Pool } from "pg";
import { baselineCoversMigrationsThrough, baselineSql } from "./baseline";
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

    // A brand-new database has no tables at all: the migrations below only extend tables that already exist, so
    // create the baseline first and record everything it covers as applied. Existing databases never take this path.
    if (done.size === 0) {
      const existing = await client.query<{ present: string | null }>("select to_regclass('public.socialflow_users') as present");
      if (!existing.rows[0]?.present) {
        const coveredThrough = migrations.findIndex((migration) => migration.name === baselineCoversMigrationsThrough);
        if (coveredThrough < 0) throw new Error(`Baseline covers unknown migration ${baselineCoversMigrationsThrough}.`);
        await client.query("begin");
        try {
          await client.query(baselineSql);
          for (const migration of migrations.slice(0, coveredThrough + 1)) {
            await client.query("insert into socialflow_migrations (name) values ($1) on conflict do nothing", [migration.name]);
            done.add(migration.name);
          }
          await client.query("commit");
          applied.push("baseline");
        } catch (error) {
          await client.query("rollback");
          throw new Error(`Creating the baseline schema failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

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
