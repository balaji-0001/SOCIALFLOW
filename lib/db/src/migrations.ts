/*
 * Schema changes made after the MySQL baseline (baseline.ts), applied in order by `runMigrations()`
 * (lib/db/src/migrate.ts) when the API starts and before the test suite runs. Each entry runs once per database;
 * applied names are recorded in `socialflow_migrations`.
 *
 * Rules: additive only (new tables, new nullable columns, new indexes). Never drop or rewrite existing data.
 * The Drizzle schema files in ./schema describe the same tables for the ORM; keep the two in step.
 *
 * Write each migration as a list of single statements, in the order they must run. MySQL commits a schema statement
 * as soon as it has run, so nothing is rolled back if a later statement fails; the runner applies the migration
 * again at the next start and skips the statements whose table, column, index or constraint already exists.
 * Use the types the baseline uses: varchar(36) for ids, datetime(3) for instants, json for lists and objects, and
 * `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin` on every new table. Example:
 *
 *   {
 *     name: "0002_post_notes",
 *     statements: [
 *       `CREATE TABLE socialflow_post_notes (
 *          id varchar(36) NOT NULL DEFAULT (uuid()),
 *          post_id varchar(36) NOT NULL,
 *          body mediumtext NOT NULL,
 *          created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 *          PRIMARY KEY (id),
 *          KEY socialflow_post_notes_post_idx (post_id),
 *          CONSTRAINT socialflow_post_notes_post_id_fkey FOREIGN KEY (post_id) REFERENCES socialflow_posts (id) ON DELETE CASCADE
 *        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
 *       `ALTER TABLE socialflow_posts ADD COLUMN note_count int NOT NULL DEFAULT 0`,
 *     ],
 *   },
 */
export const migrations: Array<{ name: string; statements: string[] }> = [];
