import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { baselineName, baselineStatements } from "./baseline";
import { migrations } from "./migrations";

/*
 * MySQL commits every schema statement by itself, so a migration that stops halfway cannot be rolled back. Instead a
 * migration is a list of single statements and running it again is safe: a statement whose table, column, index or
 * constraint is already there is skipped. These are the error numbers MySQL (and MariaDB, which reports a duplicate
 * foreign key differently) gives for "already there".
 */
const ALREADY_THERE = new Set([
  1050, // table already exists
  1060, // duplicate column name
  1061, // duplicate key (index) name
  1826, // duplicate foreign key constraint name
  3822, // duplicate check constraint name
]);
const alreadyThere = (error: unknown): boolean => {
  const { errno, message } = error as { errno?: number; message?: string };
  return (errno !== undefined && ALREADY_THERE.has(errno)) || (errno === 1005 && /errno: 121\b/.test(message ?? ""));
};

async function runStatements(connection: PoolConnection, statements: string[]): Promise<void> {
  for (const statement of statements) {
    try {
      await connection.query(statement);
    } catch (error) {
      if (!alreadyThere(error)) throw error;
    }
  }
}

/**
 * Applies any migrations this database hasn't seen yet, in order. Safe to call from several processes at once: a
 * named lock (one per database) serialises them, and the second one finds nothing to do. Returns the names that
 * were applied.
 */
export async function runMigrations(pool: Pool): Promise<string[]> {
  const connection = await pool.getConnection();
  const applied: string[] = [];
  let locked = false;
  try {
    const [[lock]] = await connection.query<RowDataPacket[]>("select get_lock(concat('socialflow_migrations:', database()), 120) as acquired");
    if (Number(lock?.acquired) !== 1) throw new Error("Another process has been applying database migrations for two minutes; giving up.");
    locked = true;
    await connection.query(
      "create table if not exists socialflow_migrations (name varchar(191) not null, applied_at datetime(3) not null default current_timestamp(3), primary key (name)) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin",
    );
    const [rows] = await connection.query<RowDataPacket[]>("select name from socialflow_migrations");
    const done = new Set(rows.map((row) => row.name as string));

    // A database that has never been set up gets every table from the baseline; the migrations below only extend it.
    const pending = [{ name: baselineName, statements: baselineStatements }, ...migrations].filter((migration) => !done.has(migration.name));
    for (const migration of pending) {
      try {
        await runStatements(connection, migration.statements);
        await connection.query("insert into socialflow_migrations (name) values (?)", [migration.name]);
        applied.push(migration.name);
      } catch (error) {
        throw new Error(`Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    if (locked) await connection.query("select release_lock(concat('socialflow_migrations:', database()))").catch(() => {});
    connection.release();
  }
  return applied;
}
