import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { connectedAccountsTable } from "./connected-accounts";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

// A recurring emailed analytics report (PDF attached). The scheduler claims rows whose next_run_at has passed.
export const reportSchedulesTable = pgTable(
  "socialflow_report_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    frequency: text("frequency").$type<"weekly" | "monthly">().notNull(),
    weekday: integer("weekday"),
    dayOfMonth: integer("day_of_month"),
    hour: integer("hour").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    rangeKey: text("range_key").$type<"7d" | "30d" | "90d">().notNull().default("7d"),
    platform: text("platform"),
    accountId: uuid("account_id").references(() => connectedAccountsTable.id, { onDelete: "cascade" }),
    recipients: text("recipients").array().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("socialflow_report_schedules_workspace_idx").on(table.workspaceId), index("socialflow_report_schedules_due_idx").on(table.nextRunAt)],
);

// One row per attempt to send a schedule's report.
export const reportRunsTable = pgTable(
  "socialflow_report_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduleId: uuid("schedule_id").notNull().references(() => reportSchedulesTable.id, { onDelete: "cascade" }),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").$type<"sent" | "failed">().notNull(),
    error: text("error"),
    recipientCount: integer("recipient_count").notNull().default(0),
  },
  (table) => [index("socialflow_report_runs_schedule_idx").on(table.scheduleId, table.ranAt)],
);
