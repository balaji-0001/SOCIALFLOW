import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// One row per password-reset link that was emailed. Only the SHA-256 hash of
// the token is stored, so a database leak can't be used to reset accounts. A
// link works once (usedAt) and until expiresAt.
export const passwordResetsTable = pgTable(
  "socialflow_password_resets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("socialflow_password_resets_user_idx").on(table.userId)],
);

export type PasswordReset = typeof passwordResetsTable.$inferSelect;
