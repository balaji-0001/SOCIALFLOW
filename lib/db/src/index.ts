import { drizzle } from "drizzle-orm/mysql2";
import mysql, { type PoolOptions } from "mysql2/promise";
import { wrapDatabase } from "./compat";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

/*
 * Hosted MySQL usually only accepts encrypted connections. Encryption is switched on when DATABASE_SSL=true, or when
 * the address itself asks for it (?ssl-mode=REQUIRED, as providers print it); DATABASE_SSL=false forces it off.
 * With "true" the connection is encrypted but the server certificate isn't checked (many providers sign with their
 * own CA). DATABASE_SSL=verify checks it too, against the usual public CAs or the PEM text in DATABASE_SSL_CA.
 */
function sslOption(url: URL): PoolOptions["ssl"] {
  const setting = process.env.DATABASE_SSL?.trim().toLowerCase();
  const asked = (url.searchParams.get("ssl-mode") ?? url.searchParams.get("sslmode") ?? url.searchParams.get("ssl") ?? "").trim().toLowerCase();
  if (setting === "false" || setting === "0") return undefined;
  const ca = process.env.DATABASE_SSL_CA?.trim() ? process.env.DATABASE_SSL_CA.replace(/\\n/g, "\n") : undefined;
  if (setting === "verify" || asked.startsWith("verify")) return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
  if (setting === "true" || setting === "1" || asked === "required" || asked === "require" || asked === "true") return { rejectUnauthorized: false, ...(ca ? { ca } : {}) };
  return undefined;
}

function poolOptions(connectionString: string): PoolOptions {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL is not a valid address. Expected mysql://user:password@host:3306/database");
  }
  if (url.protocol !== "mysql:") {
    throw new Error(`DATABASE_URL must be a MySQL address (mysql://user:password@host:3306/database), not ${url.protocol}//`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error("DATABASE_URL must name a database: mysql://user:password@host:3306/database");
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl: sslOption(url),
    // Instants are stored as UTC in datetime(3) columns: a Date given to the driver is written in UTC.
    timezone: "Z",
    // Text literals compare exactly (case and accents matter), as the columns do (utf8mb4_bin).
    charset: "utf8mb4_bin",
    // sum() and avg() come back as numbers, not text.
    decimalNumbers: true,
    // An object given as a query value is never expanded into "key = value" SQL.
    stringifyObjects: true,
    connectionLimit: Number(process.env.DATABASE_POOL_SIZE) > 0 ? Number(process.env.DATABASE_POOL_SIZE) : 10,
    // Connections idle for a minute are closed, so one the server has already dropped is never reused.
    maxIdle: 2,
    idleTimeout: 60_000,
  };
}

export const pool = mysql.createPool(poolOptions(process.env.DATABASE_URL));

/*
 * Every new connection is set up before its first statement runs (the driver queues these ahead of it):
 *   time zone +00:00        now() and current_timestamp are UTC, like the dates the application writes.
 *   READ COMMITTED          each statement sees what is committed when it runs, as it did on PostgreSQL. (MySQL's
 *                           default, REPEATABLE READ, would also take gap locks that make ordinary inserts deadlock.)
 *   strict sql_mode         a value that does not fit a column is an error, never silently cut short.
 */
const SESSION_SETUP = [
  "SET time_zone = '+00:00'",
  "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED",
  "SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
];
// (pool.pool is the driver's own pool: its event hands over the plain connection, which queues these statements.)
pool.pool.on("connection", (connection) => {
  for (const statement of SESSION_SETUP) {
    connection.query(statement, (error) => {
      // A connection that could not be set up must not be used: it would read and write dates in the wrong zone.
      if (error) connection.destroy();
    });
  }
});

export const db = wrapDatabase(drizzle(pool, { schema, mode: "default" }));

/** Whether this database has the table (the test suite skips its database tests when the schema is not there). */
export async function tableExists(name: string): Promise<boolean> {
  const [rows] = await pool.query("select 1 from information_schema.tables where table_schema = database() and table_name = ? limit 1", [name]);
  return (rows as unknown[]).length > 0;
}

export * from "./schema";
export { alphabetical, excluded, isUniqueViolation, mysqlErrno, nullsFirst, nullsLast } from "./compat";
export type { Database, ExecuteResult, WriteResult } from "./compat";
export { runMigrations } from "./migrate";
