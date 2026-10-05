/*
 * Copies every row of a SocialFlow PostgreSQL database into a MySQL database, once, when moving to MySQL.
 *
 *   SOURCE_DATABASE_URL=postgresql://user:password@host:5432/socialflow \
 *   DATABASE_URL=mysql://user:password@host:3306/socialflow \
 *   pnpm --filter @workspace/scripts run copy-postgres-to-mysql
 *
 * What it does:
 *   - only reads from PostgreSQL (one read-only transaction, so the copy is a consistent snapshot);
 *   - creates the MySQL tables first if they are not there yet (the same migrations the API runs at start);
 *   - refuses to write into a MySQL database that already holds any SocialFlow rows, so it can never mix or
 *     overwrite data (--dry-run checks and counts without copying a row; it still creates the empty tables);
 *   - copies the tables parents-first in one MySQL transaction: either everything arrives or nothing does;
 *   - checks afterwards that every table has the same number of rows on both sides.
 * Never prints any value from the rows (tokens, password hashes and emails stay where they are).
 */
import pg from "pg";
import { pool, runMigrations } from "@workspace/db";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";

const dryRun = process.argv.includes("--dry-run");
const BATCH = 500;

// PostgreSQL's date type stays the plain text "2026-03-15"; turned into a Date it would shift by the local time zone.
pg.types.setTypeParser(1082, (value: string) => value);
// int8 comes back as text; MySQL reads it as the number it is.

type Column = { name: string; type: string; generated: boolean };

async function mysqlColumns(connection: PoolConnection): Promise<Map<string, Column[]>> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `select table_name as t, column_name as c, data_type as type, extra as extra from information_schema.columns
     where table_schema = database() and table_name like 'socialflow\\_%' and table_name <> 'socialflow_migrations'
     order by table_name, ordinal_position`,
  );
  const tables = new Map<string, Column[]>();
  for (const row of rows) {
    const list = tables.get(row.t as string) ?? [];
    list.push({ name: row.c as string, type: String(row.type).toLowerCase(), generated: /\b(STORED|VIRTUAL) GENERATED\b/i.test(String(row.extra)) });
    tables.set(row.t as string, list);
  }
  return tables;
}

/** Tables ordered so every table comes after the tables it points to. */
async function parentsFirst(connection: PoolConnection, tables: string[]): Promise<string[]> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `select table_name as child, referenced_table_name as parent from information_schema.key_column_usage
     where table_schema = database() and referenced_table_name is not null`,
  );
  const parents = new Map(tables.map((table) => [table, new Set<string>()]));
  for (const row of rows) if (row.child !== row.parent) parents.get(row.child as string)?.add(row.parent as string);
  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ordered.length < tables.length) {
    const ready = tables.filter((table) => !placed.has(table) && [...parents.get(table)!].every((parent) => placed.has(parent) || !parents.has(parent)));
    if (ready.length === 0) throw new Error(`The tables point at each other in a circle: ${tables.filter((t) => !placed.has(t)).join(", ")}`);
    for (const table of ready.sort()) { ordered.push(table); placed.add(table); }
  }
  return ordered;
}

/** One PostgreSQL value as MySQL should receive it. */
function convert(value: unknown, column: Column): unknown {
  if (value === null || value === undefined) return null;
  if (column.type === "json") return JSON.stringify(value);
  if (column.type === "datetime" || column.type === "timestamp") {
    const date = value instanceof Date ? value : new Date(String(value));
    return date.toISOString().replace("T", " ").replace("Z", "");
  }
  if (column.type === "tinyint") return value === true || value === "t" || value === 1 ? 1 : 0;
  return value;
}

async function main(): Promise<void> {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  if (!sourceUrl || !/^postgres(ql)?:\/\//.test(sourceUrl)) throw new Error("Set SOURCE_DATABASE_URL to the PostgreSQL database to copy from (postgresql://...).");
  const sourceSsl = /\.supabase\.(co|com)\b/i.test(sourceUrl) || process.env.SOURCE_DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined;
  const source = new pg.Client({ connectionString: sourceUrl, ssl: sourceSsl });
  await source.connect();

  const applied = await runMigrations(pool);
  if (applied.length) console.log(`MySQL tables created: ${applied.join(", ")}`);
  const target = await pool.getConnection();
  try {
    const columns = await mysqlColumns(target);
    const sourceTables = (await source.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name like 'socialflow\\_%' and table_name <> 'socialflow_migrations'",
    )).rows.map((row) => row.table_name);
    const onlyInSource = sourceTables.filter((table) => !columns.has(table));
    if (onlyInSource.length) throw new Error(`These PostgreSQL tables have no MySQL counterpart: ${onlyInSource.join(", ")}`);

    // Never write into a database that already holds SocialFlow data.
    const occupied: string[] = [];
    for (const table of columns.keys()) {
      const [[row]] = await target.query<RowDataPacket[]>(`select count(*) as n from \`${table}\``);
      if (Number(row!.n) > 0) occupied.push(`${table} (${row!.n})`);
    }
    if (occupied.length) throw new Error(`The MySQL database already has rows, so nothing was copied: ${occupied.join(", ")}`);

    const order = await parentsFirst(target, [...columns.keys()]);
    await source.query("begin transaction isolation level repeatable read read only");
    const counts: Array<{ table: string; rows: number; skipped: string[]; missing: string[] }> = [];
    if (!dryRun) await target.beginTransaction();
    try {
      for (const table of order) {
        if (!sourceTables.includes(table)) { counts.push({ table, rows: 0, skipped: [], missing: ["(table not in PostgreSQL)"] }); continue; }
        const sourceColumns = new Set((await source.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [table])).rows.map((row) => row.column_name));
        const writable = columns.get(table)!.filter((column) => !column.generated && sourceColumns.has(column.name));
        const missing = columns.get(table)!.filter((column) => !column.generated && !sourceColumns.has(column.name)).map((column) => column.name);
        const skipped = [...sourceColumns].filter((name) => !columns.get(table)!.some((column) => column.name === name));
        const { rows } = await source.query(`select ${writable.map((column) => `"${column.name}"`).join(", ")} from "${table}"`);
        if (!dryRun) {
          for (let start = 0; start < rows.length; start += BATCH) {
            const batch = rows.slice(start, start + BATCH).map((row: Record<string, unknown>) => writable.map((column) => convert(row[column.name], column)));
            await target.query(`insert into \`${table}\` (${writable.map((column) => `\`${column.name}\``).join(", ")}) values ?`, [batch]);
          }
        }
        counts.push({ table, rows: rows.length, skipped, missing });
      }
      if (!dryRun) {
        // Same number of rows on both sides before anything is committed.
        for (const entry of counts) {
          const [[row]] = await target.query<RowDataPacket[]>(`select count(*) as n from \`${entry.table}\``);
          if (Number(row!.n) !== entry.rows) throw new Error(`${entry.table}: ${entry.rows} rows read but ${row!.n} written`);
        }
        await target.commit();
      }
    } catch (error) {
      if (!dryRun) await target.rollback();
      throw error;
    } finally {
      await source.query("rollback");
    }

    for (const entry of counts) {
      const notes = [entry.skipped.length ? `not copied: ${entry.skipped.join(", ")}` : "", entry.missing.length ? `left to MySQL defaults: ${entry.missing.join(", ")}` : ""].filter(Boolean).join("; ");
      console.log(`${entry.table.padEnd(40)} ${String(entry.rows).padStart(7)}${notes ? `   ${notes}` : ""}`);
    }
    const total = counts.reduce((sum, entry) => sum + entry.rows, 0);
    console.log(dryRun ? `\nDry run: ${total} rows would be copied. Nothing was written.` : `\nCopied ${total} rows into MySQL; every table's count matches.`);
  } finally {
    target.release();
    await source.end();
    await pool.end();
  }
}

main().catch(async (error) => {
  // A database error can quote the offending value (MySQL's "Duplicate entry '...'"); keep values out of the output.
  const message = (error instanceof Error ? error.message : String(error)).replace(/entry '.*?' for key/g, "entry (value hidden) for key");
  console.error(`Copy failed: ${message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
