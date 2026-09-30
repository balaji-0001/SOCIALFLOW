import { boolean, index, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { connectedAccountsTable } from "./connected-accounts";

// A posting queue per connected account: the time zone the slots are expressed
// in, and whether "Add to queue" is currently taking new posts.
export const accountQueuesTable = pgTable("socialflow_account_queues", {
  connectedAccountId: uuid("connected_account_id")
    .primaryKey()
    .references(() => connectedAccountsTable.id, { onDelete: "cascade" }),
  timezone: text("timezone").notNull(),
  paused: boolean("paused").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per weekly posting slot, e.g. Monday 09:00 (weekday 1, minute 540).
export const queueSlotsTable = pgTable(
  "socialflow_queue_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
