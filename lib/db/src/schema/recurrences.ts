import { boolean, date, index, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

export const recurrenceFrequencies = ["daily", "weekly", "monthly"] as const;
export type RecurrenceFrequency = (typeof recurrenceFrequencies)[number];

// A repeating post. The rule lives here; each occurrence is an ordinary post
// (posts.recurrence_id + occurrence_index) created ahead of time by the
// publisher's materializer, so it shows on the calendar and can be edited or
// deleted like any post. A unique index on (recurrence_id, occurrence_index)
// makes it impossible to create the same occurrence twice.
export const recurrencesTable = pgTable(
  "socialflow_recurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    frequency: text("frequency").$type<RecurrenceFrequency>().notNull(),
    interval: smallint("interval").notNull().default(1),
    // Weekly: 0 = Sunday … 6 = Saturday.
    weekdays: smallint("weekdays").array().notNull().default([]),
    // Monthly: 1–31; days past a month's end fall on its last day.
    dayOfMonth: smallint("day_of_month"),
    minuteOfDay: smallint("minute_of_day").notNull(),
    timezone: text("timezone").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    maxOccurrences: integer("max_occurrences"),
    occurrencesCreated: integer("occurrences_created").notNull().default(0),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    paused: boolean("paused").notNull().default(false),
    // The template every occurrence is created from.
    content: text("content").notNull().default(""),
    firstComment: text("first_comment"),
    platformContent: jsonb("platform_content").$type<Record<string, string>>().notNull().default({}),
    connectedAccountIds: uuid("connected_account_ids").array().notNull().default([]),
    mediaIds: uuid("media_ids").array().notNull().default([]),
    tagIds: uuid("tag_ids").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [index("socialflow_recurrences_workspace_idx").on(table.workspaceId)],
);

export type Recurrence = typeof recurrencesTable.$inferSelect;
