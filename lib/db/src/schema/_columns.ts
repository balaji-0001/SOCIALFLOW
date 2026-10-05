import { randomUUID } from "node:crypto";
import { customType, datetime, varchar } from "drizzle-orm/mysql-core";

/*
 * Column types shared by every table. MySQL has no uuid or timestamptz type, so the two are spelled out once here
 * (see baseline.ts for the matching DDL).
 */

/** A reference to another row's id: the 36-character text form of a UUID. */
export const uuid = (name: string) => varchar(name, { length: 36 });

/**
 * A row's own id. It is made here, not by the database, so that an insert knows the id of the row it has just
 * written (MySQL has no INSERT ... RETURNING; see compat.ts).
 */
export const uuidPk = (name = "id") => varchar(name, { length: 36 }).primaryKey().$defaultFn(() => randomUUID());

/** An instant, held in UTC to the millisecond. Every connection's time zone is +00:00 (index.ts). */
export const timestamptz = (name: string) => datetime(name, { mode: "date", fsp: 3 });

const jsonColumn = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "json",
  toDriver: (value) => JSON.stringify(value),
  // MySQL's driver hands a JSON column over already parsed; MariaDB stores JSON as text and hands over the text.
  fromDriver: (value) => (typeof value === "string" ? JSON.parse(value) : value),
});

/** A JSON document: an object or a list (what PostgreSQL held as jsonb or as an array column). Never a bare string. */
export const json = (name: string) => jsonColumn(name);
