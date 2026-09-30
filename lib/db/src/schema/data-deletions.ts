import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// One row per deletion request received from Meta's data deletion callback. Holds no personal data beyond the
// network's own user id, which is needed to answer "did my request complete?" on the status page.
export const dataDeletionsTable = pgTable(
  "socialflow_data_deletions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    confirmationCode: text("confirmation_code").notNull().unique(),
    platform: text("platform").notNull(),
    externalUserId: text("external_user_id").notNull(),
    accountsRemoved: integer("accounts_removed").notNull().default(0),
    status: text("status").notNull().default("completed"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("socialflow_data_deletions_user_idx").on(table.platform, table.externalUserId)],
);

export type DataDeletion = typeof dataDeletionsTable.$inferSelect;
