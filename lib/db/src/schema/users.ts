import { mediumtext, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { timestamptz, uuidPk } from "./_columns";

// A registered Socialflow user. Email is stored lowercase; uniqueness is
// enforced case-insensitively by normalizing before every write and read.
export const usersTable = mysqlTable(
  "socialflow_users",
  {
    id: uuidPk("id"),
    email: varchar("email", { length: 320 }).notNull(),
    // scrypt password hash, see api-server/src/lib/password.ts. Never a
    // plaintext password, and never logged.
    passwordHash: mediumtext("password_hash").notNull(),
    displayName: mediumtext("display_name"),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("socialflow_users_email_idx").on(table.email)],
);

export type User = typeof usersTable.$inferSelect;
