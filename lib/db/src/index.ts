import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

/*
 * Hosted Postgres (Supabase, Render, Neon, ...) only accepts encrypted connections. SSL is switched on when
 * DATABASE_SSL=true, or automatically for a Supabase address; DATABASE_SSL=false forces it off. The connection is
 * always encrypted; the server certificate itself isn't verified (these providers use their own CA), which is why
 * this is a setting and not the default for local databases.
 */
function sslOption(url: string): pg.PoolConfig["ssl"] {
  const setting = process.env.DATABASE_SSL?.trim().toLowerCase();
  if (setting === "false" || setting === "0") return undefined;
  if (setting === "true" || setting === "1" || /\.supabase\.(co|com)\b/i.test(url)) return { rejectUnauthorized: false };
  return undefined;
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: sslOption(process.env.DATABASE_URL) });
export const db = drizzle(pool, { schema });

export * from "./schema";
export { runMigrations } from "./migrate";
