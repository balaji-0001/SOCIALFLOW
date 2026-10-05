import { boolean, index, mysqlTable, smallint, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { timestamptz, uuid, uuidPk } from "./_columns";
import { connectedAccountsTable } from "./connected-accounts";

// A posting queue per connected account: the time zone the slots are expressed
// in, and whether "Add to queue" is currently taking new posts.
export const accountQueuesTable = mysqlTable("socialflow_account_queues", {
  connectedAccountId: uuid("connected_account_id")
    .primaryKey()
    .references(() => connectedAccountsTable.id, { onDelete: "cascade" }),
  timezone: varchar("timezone", { length: 64 }).notNull(),
  paused: boolean("paused").notNull().default(false),
  updatedAt: timestamptz("updated_at").notNull().$defaultFn(() => new Date()),
});

// One row per weekly posting slot, e.g. Monday 09:00 (weekday 1, minute 540).
export const queueSlotsTable = mysqlTable(
  "socialflow_queue_slots",
  {
    id: uuidPk("id"),
    connectedAccountId: uuid("connected_account_id")
      .notNull()
      .references(() => connectedAccountsTable.id, { onDelete: "cascade" }),
    weekday: smallint("weekday").notNull(),
    minuteOfDay: smallint("minute_of_day").notNull(),
  },
  (table) => [
    uniqueIndex("socialflow_queue_slots_unique").on(table.connectedAccountId, table.weekday, table.minuteOfDay),
    index("socialflow_queue_slots_account_idx").on(table.connectedAccountId),
  ],
);

export type AccountQueue = typeof accountQueuesTable.$inferSelect;
export type QueueSlot = typeof queueSlotsTable.$inferSelect;
