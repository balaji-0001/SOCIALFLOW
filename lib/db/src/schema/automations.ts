import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { postsTable } from "./posts";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

export const automationKinds = ["wordpress", "rss"] as const;
export type AutomationKind = (typeof automationKinds)[number];
export type AutomationStatus = "active" | "paused" | "error";
export type AutomationMode = "publish" | "queue" | "draft";

export type AutomationConfig = {
  connectedAccountIds: string[];
  mode: AutomationMode;
  template: string;
  includeImage: boolean;
  maxPostsPerRun: number;
  postExistingOnFirstRun: boolean;
};

// A watched source (a WordPress site or an RSS/Atom feed) that turns new items into posts. The poller claims rows
// whose next_run_at has passed (lib/automations.ts). baseline_at is set once the first fetch has recorded what was
// already there, so turning an automation on never floods the accounts with old items.
export const automationsTable = pgTable(
  "socialflow_automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AutomationKind>().notNull(),
    name: text("name").notNull(),
    sourceUrl: text("source_url").notNull(),
    status: text("status").$type<AutomationStatus>().notNull().default("active"),
    config: jsonb("config").$type<AutomationConfig>().notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    baselineAt: timestamp("baseline_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [index("socialflow_automations_workspace_idx").on(table.workspaceId), index("socialflow_automations_due_idx").on(table.status, table.nextRunAt)],
);

export type AutomationItemStatus = "pending" | "posted" | "skipped" | "failed" | "seen";

// One row per feed item the automation has seen. UNIQUE (automation_id, item_key) is what stops an item becoming two posts.
export const automationItemsTable = pgTable(
  "socialflow_automation_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automationId: uuid("automation_id").notNull().references(() => automationsTable.id, { onDelete: "cascade" }),
    itemKey: text("item_key").notNull(),
    title: text("title"),
    url: text("url"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    status: text("status").$type<AutomationItemStatus>().notNull(),
    postId: uuid("post_id").references(() => postsTable.id, { onDelete: "set null" }),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [unique("socialflow_automation_items_automation_id_item_key_key").on(table.automationId, table.itemKey), index("socialflow_automation_items_recent_idx").on(table.automationId, table.createdAt)],
);

export type AutomationRunStatus = "success" | "no_new" | "partial" | "failed";

export const automationRunsTable = pgTable(
  "socialflow_automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automationId: uuid("automation_id").notNull().references(() => automationsTable.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").$type<AutomationRunStatus>().notNull(),
    itemsFound: integer("items_found").notNull().default(0),
    itemsNew: integer("items_new").notNull().default(0),
    postsCreated: integer("posts_created").notNull().default(0),
    error: text("error"),
  },
  (table) => [index("socialflow_automation_runs_idx").on(table.automationId, table.startedAt)],
);

export type BulkImportStatus = "completed" | "partial" | "failed";
export type BulkImportRowError = { row: number; message: string };

// A record of each CSV import: counts and the per-row reasons rows were not imported.
export const bulkImportsTable = pgTable(
  "socialflow_bulk_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    fileName: text("file_name").notNull(),
    totalRows: integer("total_rows").notNull().default(0),
    createdCount: integer("created_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    status: text("status").$type<BulkImportStatus>().notNull(),
    mode: text("mode").notNull(),
    errors: jsonb("errors").$type<BulkImportRowError[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("socialflow_bulk_imports_workspace_idx").on(table.workspaceId, table.createdAt)],
);

export type Automation = typeof automationsTable.$inferSelect;
export type AutomationItem = typeof automationItemsTable.$inferSelect;
export type AutomationRun = typeof automationRunsTable.$inferSelect;
export type BulkImport = typeof bulkImportsTable.$inferSelect;
