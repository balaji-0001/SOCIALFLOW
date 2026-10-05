import { boolean, date, index, int, mediumtext, mysqlTable, smallint, varchar } from "drizzle-orm/mysql-core";
import { json, timestamptz, uuid, uuidPk } from "./_columns";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

export const recurrenceFrequencies = ["daily", "weekly", "monthly"] as const;
export type RecurrenceFrequency = (typeof recurrenceFrequencies)[number];

// A repeating post. The rule lives here; each occurrence is an ordinary post
// (posts.recurrence_id + occurrence_index) created ahead of time by the
// publisher's materializer, so it shows on the calendar and can be edited or
// deleted like any post. A unique index on (recurrence_id, occurrence_index)
// makes it impossible to create the same occurrence twice.
export const recurrencesTable = mysqlTable(
  "socialflow_recurrences",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    frequency: varchar("frequency", { length: 64 }).$type<RecurrenceFrequency>().notNull(),
    interval: smallint("interval").notNull().default(1),
    // Weekly: 0 = Sunday … 6 = Saturday.
    weekdays: json("weekdays").$type<number[]>().notNull().$defaultFn(() => []),
    // Monthly: 1–31; days past a month's end fall on its last day.
    dayOfMonth: smallint("day_of_month"),
    minuteOfDay: smallint("minute_of_day").notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }),
    maxOccurrences: int("max_occurrences"),
    occurrencesCreated: int("occurrences_created").notNull().default(0),
    nextRunAt: timestamptz("next_run_at"),
    paused: boolean("paused").notNull().default(false),
    // The template every occurrence is created from.
    content: mediumtext("content").notNull().default(""),
    firstComment: mediumtext("first_comment"),
    platformContent: json("platform_content").$type<Record<string, string>>().notNull().$defaultFn(() => ({})),
    connectedAccountIds: json("connected_account_ids").$type<string[]>().notNull().$defaultFn(() => []),
    mediaIds: json("media_ids").$type<string[]>().notNull().$defaultFn(() => []),
    tagIds: json("tag_ids").$type<string[]>().notNull().$defaultFn(() => []),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
    updatedAt: timestamptz("updated_at").notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
  },
  (table) => [index("socialflow_recurrences_workspace_idx").on(table.workspaceId)],
);

export type Recurrence = typeof recurrencesTable.$inferSelect;
