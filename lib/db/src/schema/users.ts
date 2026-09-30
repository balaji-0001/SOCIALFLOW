import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// A registered Socialflow user. Email is stored lowercase; uniqueness is
// enforced case-insensitively by normalizing before every write and read.
export const usersTable = pgTable(
  "socialflow_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    // scrypt password hash, see api-server/src/lib/password.ts. Never a
    // plaintext password, and never logged.
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("socialflow_users_email_idx").on(table.email)],
);

export type User = typeof usersTable.$inferSelect;
