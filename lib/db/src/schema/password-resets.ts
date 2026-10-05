import { index, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { timestamptz, uuid, uuidPk } from "./_columns";
import { usersTable } from "./users";

// One row per password-reset link that was emailed. Only the SHA-256 hash of
// the token is stored, so a database leak can't be used to reset accounts. A
// link works once (usedAt) and until expiresAt.
export const passwordResetsTable = mysqlTable(
  "socialflow_password_resets",
  {
    id: uuidPk("id"),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
    expiresAt: timestamptz("expires_at").notNull(),
    usedAt: timestamptz("used_at"),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("socialflow_password_resets_user_idx").on(table.userId)],
);

export type PasswordReset = typeof passwordResetsTable.$inferSelect;
