/*
 * Creates the tables in an empty database, or brings an existing one up to date, without starting the API.
 *
 *   pnpm --filter @workspace/scripts run migrate
 *
 * Reads DATABASE_URL (and the DATABASE_SSL settings) from the environment or from the .env file at the repository
 * root. The API runs the same migrations every time it starts, so this is only needed to prepare a database ahead
 * of the first start, or to check that one is up to date. Safe to run any number of times.
 */
import { pool, runMigrations } from "@workspace/db";

try {
  const applied = await runMigrations(pool);
  const [rows] = await pool.query("select count(*) as tables from information_schema.tables where table_schema = database()");
  const tables = Number((rows as Array<{ tables: number }>)[0]?.tables ?? 0);
  console.log(applied.length > 0 ? `Applied: ${applied.join(", ")}` : "Nothing to apply: the database is up to date.");
  console.log(`The database has ${tables} tables.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
