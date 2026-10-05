import { and, eq, getTableColumns, inArray, or, sql, type ExtractTablesWithRelations, type SQL } from "drizzle-orm";
import {
  getTableConfig,
  type MySqlColumn,
  type MySqlDatabase,
  type MySqlInsertValue,
  type MySqlTable,
  type MySqlUpdateSetSource,
} from "drizzle-orm/mysql-core";
import type { MySql2PreparedQueryHKT, MySql2QueryResultHKT } from "drizzle-orm/mysql2";
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types";
import type { FieldPacket, ResultSetHeader } from "mysql2/promise";
import type * as schema from "./schema";

/*
 * What MySQL does not have, and how it is made up for here so the rest of the code can keep saying what it means:
 *
 *   .returning()             MySQL cannot hand back the rows a statement wrote. Inserts know their ids before they
 *                            run (see uuidPk in schema/_columns.ts), so the rows are read back by id. An update or
 *                            delete first locks the rows it is about to touch (SELECT ... FOR UPDATE), writes, and
 *                            reads them back. Each of these runs inside one transaction, so the answer is exactly
 *                            what the statement wrote; nothing another request does can slip in between.
 *   .onConflictDoNothing()   INSERT ... ON DUPLICATE KEY UPDATE that changes nothing. (INSERT IGNORE is not used: it
 *   .onConflictDoUpdate()    also hides errors that are not duplicates, such as a missing parent row.) In a `set`,
 *                            excluded(column) is the value the insert tried to write.
 *   .execute(sql)            Answers { rows, rowCount }, with dates as Date and yes/no columns as boolean.
 *
 * Everything else (select, joins, $count, ...) is Drizzle's own MySQL builder, untouched.
 */

type Schema = typeof schema;
type Inner = MySqlDatabase<MySql2QueryResultHKT, MySql2PreparedQueryHKT, Schema, ExtractTablesWithRelations<Schema>>;
type Fields = Record<string, MySqlColumn | SQL | SQL.Aliased>;
type Row = Record<string, unknown>;
type ConflictTarget = MySqlColumn | MySqlColumn[];

export interface WriteResult {
  /** Rows the statement wrote (for an update: rows it matched). */
  rowCount: number;
}
export interface ExecuteResult<T = Row> {
  rows: T[];
  rowCount: number;
}

/** A statement that runs when it is awaited, like Drizzle's own builders. */
abstract class Statement<T> implements PromiseLike<T> {
  protected abstract run(): Promise<T>;
  then<A = T, B = never>(onFulfilled?: ((value: T) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.run().then(onFulfilled, onRejected);
  }
  catch<B = never>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<T | B> {
    return this.run().catch(onRejected);
  }
  finally(onFinally?: (() => void) | null): Promise<T> {
    return this.run().finally(onFinally);
  }
}

/* ---------------------------------------------------------------------------------------------- errors, retries */

/** MySQL's error number for a failed statement, however deep Drizzle wrapped it. */
export function mysqlErrno(error: unknown): number | null {
  for (let current = error as { errno?: unknown; cause?: unknown } | undefined, depth = 0; current && depth < 5; current = current.cause as typeof current, depth += 1) {
    if (typeof current.errno === "number") return current.errno;
  }
  return null;
}

/** True when a write was refused because a unique key (or the primary key) already holds that value. */
export const isUniqueViolation = (error: unknown): boolean => mysqlErrno(error) === 1062;

const DEADLOCK = 1213;
const LOCK_WAIT_TIMEOUT = 1205;

/*
 * InnoDB settles a deadlock by rolling one side back and asking it to try again. A single statement (or one of the
 * small transactions made here) can simply be run again; a transaction the caller wrote is never retried here, since
 * only the caller knows whether its steps may run twice.
 */
async function retrying<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const errno = mysqlErrno(error);
      if ((errno !== DEADLOCK && errno !== LOCK_WAIT_TIMEOUT) || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * attempt + Math.random() * 25));
    }
  }
}

/* ---------------------------------------------------------------------------------------------- table knowledge */

interface KeyInfo {
  /** Property names on the Drizzle table, in key order. */
  keys: string[];
  columns: MySqlColumn[];
}

const primaryKeys = new WeakMap<MySqlTable, KeyInfo>();

function keyInfo(table: MySqlTable, columns: MySqlColumn[]): KeyInfo {
  const byColumn = new Map(Object.entries(getTableColumns(table)).map(([key, column]) => [column.name, key]));
  return { columns, keys: columns.map((column) => byColumn.get(column.name)!) };
}

function primaryKeyOf(table: MySqlTable): KeyInfo {
  let info = primaryKeys.get(table);
  if (!info) {
    const config = getTableConfig(table);
    const single = config.columns.filter((column) => column.primary);
    const columns = single.length > 0 ? single : (config.primaryKeys[0]?.columns ?? []);
    if (columns.length === 0) throw new Error(`Table ${config.name} has no primary key.`);
    info = keyInfo(table, columns as MySqlColumn[]);
    primaryKeys.set(table, info);
  }
  return info;
}

/** The rows whose key columns equal one of the given value lists. */
function matching(key: KeyInfo, tuples: unknown[][]): SQL {
  if (key.columns.length === 1) return inArray(key.columns[0]!, tuples.map((tuple) => tuple[0]));
  return or(...tuples.map((tuple) => and(...key.columns.map((column, index) => eq(column, tuple[index])))))!;
}

const keySelection = (key: KeyInfo): Fields => Object.fromEntries(key.columns.map((column, index) => [`k${index}`, column]));
const tupleOf = (key: KeyInfo, row: Row): unknown[] => key.columns.map((_, index) => row[`k${index}`]);
const fingerprint = (tuple: unknown[]): string => JSON.stringify(tuple.map((value) => (value instanceof Date ? value.toISOString() : value)));

/** In onConflictDoUpdate's `set`: the value the insert tried to write for this column (PostgreSQL's "excluded"). */
export function excluded(column: MySqlColumn): SQL {
  return sql`values(${sql.identifier(column.name)})`;
}

/*
 * ORDER BY helpers. MySQL puts NULL first when sorting ascending and last when descending; PostgreSQL did the
 * opposite, and the lists were built around that. Put one of these in front of the column:
 *   .orderBy(nullsLast(posts.scheduledAt), asc(posts.scheduledAt))
 */
export const nullsLast = (column: MySqlColumn): SQL => sql`${column} is null`;
export const nullsFirst = (column: MySqlColumn): SQL => sql`${column} is not null`;

/**
 * ORDER BY for names people read: alphabetical whatever the case or accents ("apple", "Banana", "cherry"). The
 * columns themselves compare exactly (utf8mb4_bin), which on its own would sort every capital before every small letter.
 */
export const alphabetical = (column: MySqlColumn): SQL => sql`${column} collate utf8mb4_unicode_ci`;

/** A column set to itself: an update that changes nothing. */
const unchanged = (column: MySqlColumn): SQL => sql`${sql.identifier(column.name)}`;

/* ---------------------------------------------------------------------------------------------- the statements */

interface Runner {
  inner: Inner;
  inTransaction: boolean;
}

/** Runs `work` as one unit: on the caller's transaction if there is one, otherwise in a transaction of its own. */
function atomic<T>(runner: Runner, work: (db: Inner) => Promise<T>): Promise<T> {
  if (runner.inTransaction) return work(runner.inner);
  return retrying(() => runner.inner.transaction((tx) => work(tx as unknown as Inner)));
}

/** One statement: run again if InnoDB picked it as the deadlock victim, unless it is part of the caller's transaction. */
function single<T>(runner: Runner, work: () => Promise<T>): Promise<T> {
  return runner.inTransaction ? work() : retrying(work);
}

const header = (result: unknown): ResultSetHeader => (Array.isArray(result) ? result[0] : result) as ResultSetHeader;

type Conflict = { kind: "nothing" } | { kind: "update"; target: MySqlColumn[]; set: Row };

class InsertStatement<T extends MySqlTable> extends Statement<WriteResult> {
  private conflict: Conflict | undefined;

  constructor(private readonly runner: Runner, private readonly table: T, private readonly rows: Row[]) {
    super();
  }

  /** Leaves an existing row exactly as it is when a unique key already holds these values. */
  onConflictDoNothing(_config?: { target?: ConflictTarget }): this {
    this.conflict = { kind: "nothing" };
    return this;
  }

  /** Updates the existing row instead when `target` (a unique key) already holds these values. */
  onConflictDoUpdate(config: { target: ConflictTarget; set: MySqlUpdateSetSource<T> }): this {
    this.conflict = { kind: "update", target: Array.isArray(config.target) ? config.target : [config.target], set: config.set as Row };
    return this;
  }

  private write(db: Inner, rows: Row[]) {
    const insert = db.insert(this.table).values(rows as MySqlInsertValue<T>[]);
    if (!this.conflict) return insert;
    if (this.conflict.kind === "update") return insert.onDuplicateKeyUpdate({ set: this.conflict.set as MySqlUpdateSetSource<T> });
    // Nothing may change, including the columns Drizzle would refresh on any update (updated_at).
    const key = primaryKeyOf(this.table);
    const set: Row = { [key.keys[0]!]: unchanged(key.columns[0]!) };
    for (const [name, column] of Object.entries(getTableColumns(this.table))) if (column.onUpdateFn) set[name] = unchanged(column as MySqlColumn);
    return insert.onDuplicateKeyUpdate({ set: set as MySqlUpdateSetSource<T> });
  }

  /*
   * Fills in what the database used to: one "now" for every created_at / updated_at the statement writes (rows of
   * one insert share their time, as they did with PostgreSQL's now()), and the ids, so the rows can be found again.
   */
  private prepared(): Row[] {
    const columns = getTableColumns(this.table) as Record<string, MySqlColumn>;
    const primary = primaryKeyOf(this.table);
    const now = new Date();
    return this.rows.map((row) => {
      const copy = { ...row };
      for (const [name, column] of Object.entries(columns)) {
        if (copy[name] !== undefined || !column.defaultFn) continue;
        if (column.dataType === "date") copy[name] = now;
        else if (primary.keys.includes(name)) copy[name] = column.defaultFn();
      }
      return copy;
    });
  }

  protected run(): Promise<WriteResult> {
    const rows = this.prepared();
    return single(this.runner, async () => ({ rowCount: header(await this.write(this.runner.inner, rows)).affectedRows }));
  }

  /** The rows as they are stored after the insert, in the order they were given. A row left alone by onConflictDoNothing is not included. */
  returning(): Promise<T["$inferSelect"][]>;
  returning<F extends Fields>(fields: F): Promise<SelectResultFields<F>[]>;
  returning(fields?: Fields): Promise<unknown[]> {
    const table = this.table;
    const columns = getTableColumns(table) as Record<string, MySqlColumn>;
    const primary = primaryKeyOf(table);
    if (this.conflict?.kind === "nothing" && !primary.columns.every((column) => column.defaultFn)) {
      // Only an id made here tells a row this insert wrote from one that was already there.
      throw new Error(`onConflictDoNothing().returning() needs ids made by the application on ${getTableConfig(table).name}.`);
    }
    const rows = this.prepared();
    return atomic(this.runner, async (db) => {
      const result = header(await this.write(db, rows));
      // After "update on conflict" the row is the one the unique key names, whichever of the two happened.
      const key = this.conflict?.kind === "update" ? keyInfo(table, this.conflict.target) : primary;
      const tuples = rows.map((row, index) => key.keys.map((name) => {
        if (row[name] !== undefined) return row[name];
        if (key === primary && key.columns.length === 1 && (key.columns[0] as MySqlColumn & { autoIncrement?: boolean }).autoIncrement && !this.conflict) return result.insertId + index;
        throw new Error(`returning() needs a value for ${getTableConfig(table).name}.${name} to find the row it wrote.`);
      }));
      const found = await db.select({ row: fields ?? columns, key: keySelection(key) }).from(table).where(matching(key, tuples)) as { row: unknown; key: Row }[];
      if (rows.length === 1) return found.map((item) => item.row);
      const byKey = new Map(found.map((item) => [fingerprint(tupleOf(key, item.key)), item.row]));
      return tuples.map((tuple) => byKey.get(fingerprint(tuple))).filter((row) => row !== undefined);
    });
  }
}

class UpdateStatement<T extends MySqlTable> extends Statement<WriteResult> {
  private condition: SQL | undefined;

  constructor(private readonly runner: Runner, private readonly table: T, private readonly values: MySqlUpdateSetSource<T>) {
    super();
  }

  where(condition: SQL | undefined): this {
    this.condition = condition;
    return this;
  }

  protected run(): Promise<WriteResult> {
    return single(this.runner, async () => ({ rowCount: header(await this.runner.inner.update(this.table).set(this.values).where(this.condition)).affectedRows }));
  }

  /** The rows this update changed, as they are afterwards. */
  returning(): Promise<T["$inferSelect"][]>;
  returning<F extends Fields>(fields: F): Promise<SelectResultFields<F>[]>;
  returning(fields?: Fields): Promise<unknown[]> {
    const table = this.table;
    const key = primaryKeyOf(table);
    return atomic(this.runner, async (db) => {
      // Lock the rows first. A second request with the same condition waits here, then sees the changed row and
      // matches nothing, which is how "update ... where status = 'scheduled' returning" claims a row exactly once.
      const locked = await db.select(keySelection(key)).from(table).where(this.condition).for("update") as Row[];
      if (locked.length === 0) return [];
      const rows = matching(key, locked.map((row) => tupleOf(key, row)));
      await db.update(table).set(this.values).where(rows);
      return db.select(fields ?? getTableColumns(table)).from(table).where(rows);
    });
  }
}

class DeleteStatement<T extends MySqlTable> extends Statement<WriteResult> {
  private condition: SQL | undefined;

  constructor(private readonly runner: Runner, private readonly table: T) {
    super();
  }

  where(condition: SQL | undefined): this {
    this.condition = condition;
    return this;
  }

  protected run(): Promise<WriteResult> {
    return single(this.runner, async () => ({ rowCount: header(await this.runner.inner.delete(this.table).where(this.condition)).affectedRows }));
  }

  /** The rows this delete removed, as they were. */
  returning(): Promise<T["$inferSelect"][]>;
  returning<F extends Fields>(fields: F): Promise<SelectResultFields<F>[]>;
  returning(fields?: Fields): Promise<unknown[]> {
    const table = this.table;
    const key = primaryKeyOf(table);
    return atomic(this.runner, async (db) => {
      const doomed = await db.select({ row: fields ?? getTableColumns(table), key: keySelection(key) }).from(table).where(this.condition).for("update") as { row: unknown; key: Row }[];
      if (doomed.length === 0) return [];
      await db.delete(table).where(matching(key, doomed.map((item) => tupleOf(key, item.key))));
      return doomed.map((item) => item.row);
    });
  }
}

/* ---------------------------------------------------------------------------------------------- raw statements */

// mysql2's column type codes.
const TINY = 1;
const TIMESTAMP = 7;
const DATETIME = 12;

/** Drizzle asks the driver for dates as text; raw results get them back as Date here, and tinyint(1) as boolean. */
function convertRows(rows: Row[], fields: FieldPacket[] | undefined): Row[] {
  const changes = (fields ?? []).flatMap((field) => {
    const type = field.columnType ?? field.type;
    if (type === DATETIME || type === TIMESTAMP) return [{ name: field.name, convert: (value: unknown) => (typeof value === "string" ? new Date(`${value.replace(" ", "T")}Z`) : value) }];
    if (type === TINY && field.columnLength === 1) return [{ name: field.name, convert: (value: unknown) => (typeof value === "number" ? value !== 0 : value) }];
    return [];
  });
  if (changes.length === 0) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const change of changes) if (out[change.name] !== null && out[change.name] !== undefined) out[change.name] = change.convert(out[change.name]);
    return out;
  });
}

/* ---------------------------------------------------------------------------------------------- the database */

export type Database = Omit<Inner, "insert" | "update" | "delete" | "execute" | "transaction"> & {
  insert<T extends MySqlTable>(table: T): { values(values: MySqlInsertValue<T> | MySqlInsertValue<T>[]): InsertStatement<T> };
  update<T extends MySqlTable>(table: T): { set(values: MySqlUpdateSetSource<T>): UpdateStatement<T> };
  delete<T extends MySqlTable>(table: T): DeleteStatement<T>;
  /** Runs hand-written SQL. A statement that returns no rows answers `rows: []` and the number of rows it wrote. */
  execute<T = Row>(query: SQL): Promise<ExecuteResult<T>>;
  /** Everything `work` does through `tx` is committed together, or not at all if it throws. */
  transaction<T>(work: (tx: Database) => Promise<T>): Promise<T>;
};

export function wrapDatabase(inner: Inner, inTransaction = false): Database {
  const runner: Runner = { inner, inTransaction };
  const own = {
    insert: <T extends MySqlTable>(table: T) => ({
      values: (values: MySqlInsertValue<T> | MySqlInsertValue<T>[]) => {
        const rows = (Array.isArray(values) ? values : [values]) as Row[];
        if (rows.length === 0) throw new Error("values() must be called with at least one value");
        return new InsertStatement(runner, table, rows);
      },
    }),
    update: <T extends MySqlTable>(table: T) => ({ set: (values: MySqlUpdateSetSource<T>) => new UpdateStatement(runner, table, values) }),
    delete: <T extends MySqlTable>(table: T) => new DeleteStatement(runner, table),
    execute: <T = Row>(query: SQL): Promise<ExecuteResult<T>> =>
      single(runner, async () => {
        const [result, fields] = (await inner.execute(query)) as unknown as [Row[] | ResultSetHeader, FieldPacket[] | undefined];
        if (!Array.isArray(result)) return { rows: [], rowCount: result.affectedRows ?? 0 };
        return { rows: convertRows(result, fields) as T[], rowCount: result.length };
      }),
    transaction: <T>(work: (tx: Database) => Promise<T>): Promise<T> => inner.transaction((tx) => work(wrapDatabase(tx as unknown as Inner, true))),
  };
  return new Proxy(inner, {
    get(target, property) {
      if (Object.hasOwn(own, property)) return own[property as keyof typeof own];
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Database;
}
