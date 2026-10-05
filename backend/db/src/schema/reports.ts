import { boolean, index, int, mediumtext, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { json, timestamptz, uuid, uuidPk } from "./_columns";
import { connectedAccountsTable } from "./connected-accounts";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

// A recurring emailed analytics report (PDF attached). The scheduler claims rows whose next_run_at has passed.
export const reportSchedulesTable = mysqlTable(
  "socialflow_report_schedules",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    name: mediumtext("name").notNull(),
    frequency: varchar("frequency", { length: 64 }).$type<"weekly" | "monthly">().notNull(),
    weekday: int("weekday"),
    dayOfMonth: int("day_of_month"),
    hour: int("hour").notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
    rangeKey: varchar("range_key", { length: 64 }).$type<"7d" | "30d" | "90d">().notNull().default("7d"),
    platform: varchar("platform", { length: 64 }),
    accountId: uuid("account_id").references(() => connectedAccountsTable.id, { onDelete: "cascade" }),
    recipients: json("recipients").$type<string[]>().notNull().$defaultFn(() => []),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamptz("last_run_at"),
    lastStatus: varchar("last_status", { length: 64 }),
    lastError: mediumtext("last_error"),
    nextRunAt: timestamptz("next_run_at"),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("socialflow_report_schedules_workspace_idx").on(table.workspaceId), index("socialflow_report_schedules_due_idx").on(table.nextRunAt)],
);

// One row per attempt to send a schedule's report.
export const reportRunsTable = mysqlTable(
  "socialflow_report_runs",
  {
    id: uuidPk("id"),
    scheduleId: uuid("schedule_id").notNull().references(() => reportSchedulesTable.id, { onDelete: "cascade" }),
    ranAt: timestamptz("ran_at").notNull().$defaultFn(() => new Date()),
    status: varchar("status", { length: 64 }).$type<"sent" | "failed">().notNull(),
    error: mediumtext("error"),
    recipientCount: int("recipient_count").notNull().default(0),
  },
  (table) => [index("socialflow_report_runs_schedule_idx").on(table.scheduleId, table.ranAt)],
);
