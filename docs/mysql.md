# MySQL

SocialFlow ran on PostgreSQL until October 2026 and now runs on MySQL 8. This page explains what the move changed, what the code expects of the server, how to write queries now, and how to move an existing PostgreSQL installation.

## What the server must be
- MySQL **8.0.19 or later** (developed and tested on 8.4.6). InnoDB tables, `utf8mb4` text.
- The API sets each connection up itself (`lib/db/src/index.ts`): time zone `+00:00`, `READ COMMITTED` isolation, strict `sql_mode`. Nothing needs configuring on the server.
- Used features: `FOR UPDATE SKIP LOCKED`, `GET_LOCK`, JSON columns and `JSON_CONTAINS`, expression defaults (`DEFAULT (uuid())`), check constraints, a stored generated column.
- MariaDB was kept in mind (no `OF` in locking clauses, `VALUES()` in upserts, JSON read back either way) but has **not been tested**. TiDB and PlanetScale have not been tested either.

## How the tables changed
`lib/db/src/baseline.ts` creates every table, translated from the PostgreSQL catalog as of migration `0020`:

| PostgreSQL | MySQL |
|---|---|
| `uuid` | `varchar(36)`; ids are made by the application (`uuidPk` in `schema/_columns.ts`) |
| `timestamptz` | `datetime(3)` holding UTC (`timestamptz()` in `_columns.ts`) |
| `text` | `varchar(n)` when indexed, defaulted or a fixed set of values; otherwise `mediumtext` |
| `jsonb`, `text[]`, `uuid[]`, `smallint[]` | `json` (an array column is a JSON list) |
| `serial` | `int AUTO_INCREMENT` |
| unique index on `lower(name)` (library folders) | stored generated column `name_key` with a unique key |
| partial indexes | plain indexes (a unique key allows any number of NULLs, so the rules are the same) |

Text uses the `utf8mb4_bin` collation, so equality and unique keys are exact, as they were. Bounded `varchar` columns are at least as long as anything the API accepts, and strict mode turns a too-long value into an error instead of cutting it short.

## Writing queries
Use Drizzle as before. `lib/db/src/compat.ts` wraps the MySQL driver so these keep their PostgreSQL meaning:

- `insert(...).values(...).returning()`, `update(...).returning()`, `delete(...).returning()`: the rows written, read back inside one transaction (updates and deletes lock their rows first, so a conditional update still claims a row exactly once).
- `onConflictDoNothing()`, `onConflictDoUpdate({ target, set })`: `INSERT ... ON DUPLICATE KEY UPDATE`. In `set`, write `excluded(table.column)` for the value the insert tried to write (PostgreSQL's `excluded.column`).
- `db.execute(sql\`...\`)` answers `{ rows, rowCount }`, with dates as `Date` and yes/no columns as booleans.
- `isUniqueViolation(error)` instead of checking for code `23505`.

What to write differently from PostgreSQL:

| Instead of | Write |
|---|---|
| `ilike` | `lower(col) like lower(${pattern})` |
| `count(*)::int`, `x::timestamptz`, `x::uuid` | `count(*)`; pass a `Date` or a string as it is |
| `count(*) filter (where c)` | `count(case when c then 1 end)` |
| `x = any(arrayColumn)` | `json_contains(arrayColumn, json_quote(x))` |
| `distinct on` | join each key to its newest row (see `lib/analytics-report.ts`) |
| `now()` | `now(3)` (milliseconds) |
| `interval '1 minute'` | `interval 1 minute` |
| `order by col` on a nullable column | MySQL sorts NULL first when ascending: `.orderBy(nullsLast(col), asc(col))` |
| `order by name` for people to read | `.orderBy(alphabetical(col), asc(col))` (otherwise capitals sort before small letters) |
| `sql\`max(${col})\`` returning a date | add `.mapWith(col)`, or it comes back as text |
| a subquery reading the table being deleted from | wrap it in a derived table: `in (select id from (select ...) kept)` |

`JSON_TABLE` was tried for the library's label filter and returned nothing when the query also had a join (MySQL 8.4); `JSON_CONTAINS` is used instead.

Schema changes go in `lib/db/src/migrations.ts` as lists of single statements. MySQL commits each schema statement on its own, so the runner re-applies a half-finished migration and skips what already exists. Never use `drizzle-kit push`.

## Local setup (Windows)
- `local-mysql\server\` is the MySQL 8.4 Windows ZIP unpacked, `local-mysql\data\` its data (both ignored by git). `run-dev.ps1` starts it on port 3307.
- Databases `socialflow` (your data) and `socialflow_test` (tests), user `root` without a password, reachable from this machine only.
- `.env`: `DATABASE_URL=mysql://root@127.0.0.1:3307/socialflow`.

## Moving an existing PostgreSQL installation
`scripts/src/copy-postgres-to-mysql.ts` copies every row once:

```bash
SOURCE_DATABASE_URL=postgresql://... DATABASE_URL=mysql://... pnpm --filter @workspace/scripts run copy-postgres-to-mysql -- --dry-run
SOURCE_DATABASE_URL=postgresql://... DATABASE_URL=mysql://... pnpm --filter @workspace/scripts run copy-postgres-to-mysql
```

It only reads from PostgreSQL (one consistent snapshot), creates the MySQL tables if needed, refuses to write into a MySQL database that already has SocialFlow rows, copies parents before children in one transaction, and compares row counts before committing. It never prints row values. The PostgreSQL database is left as it was; keep it until the MySQL one has been in use for a while.

For production: stop the API (so nothing changes during the copy), run the copy from the PostgreSQL database to the new MySQL one, set `DATABASE_URL` on the API to the MySQL address, deploy the MySQL version, and check sign-in, the connected accounts, the calendar and a scheduled post. `TOKEN_ENCRYPTION_KEY` must stay the same: the stored social tokens are copied encrypted.

## Choosing a production host
Any managed MySQL 8 with backups works. Supabase (the current host) offers only PostgreSQL. Options to compare (check current prices and limits before choosing):
- **Aiven for MySQL**: real MySQL 8 with a free plan for small projects; paid plans add backups and more space.
- **DigitalOcean Managed MySQL**, **AWS RDS / Aurora MySQL**, **Google Cloud SQL**, **Azure Database for MySQL**: paid, with backups and point-in-time recovery.
- **Railway** (MySQL template): simple, usage-based. (Render itself offers no MySQL.)

Pick a region close to the API (Render `singapore`). Use the address the provider prints with `?ssl-mode=REQUIRED`, or set `DATABASE_SSL=true`.
