import { index, int, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { timestamptz, uuidPk } from "./_columns";

// One row per deletion request received from Meta's data deletion callback. Holds no personal data beyond the
// network's own user id, which is needed to answer "did my request complete?" on the status page.
export const dataDeletionsTable = mysqlTable(
  "socialflow_data_deletions",
  {
    id: uuidPk("id"),
    confirmationCode: varchar("confirmation_code", { length: 128 }).notNull().unique(),
    platform: varchar("platform", { length: 64 }).notNull(),
    externalUserId: varchar("external_user_id", { length: 255 }).notNull(),
    accountsRemoved: int("accounts_removed").notNull().default(0),
    status: varchar("status", { length: 64 }).notNull().default("completed"),
    requestedAt: timestamptz("requested_at").notNull().$defaultFn(() => new Date()),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [index("socialflow_data_deletions_user_idx").on(table.platform, table.externalUserId)],
);

export type DataDeletion = typeof dataDeletionsTable.$inferSelect;
