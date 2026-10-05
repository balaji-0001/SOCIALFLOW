import { index, int, mediumtext, mysqlTable, unique, varchar } from "drizzle-orm/mysql-core";
import { json, timestamptz, uuid, uuidPk } from "./_columns";
import { postsTable } from "./posts";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

// "wordpress" and "rss" are polled (lib/automations.ts). "wordpress_plugin" is never polled: the SocialFlow plugin on
// the site sends each post as it is published (lib/wordpress-plugin.ts).
export const automationKinds = ["wordpress", "rss", "wordpress_plugin"] as const;
export type AutomationKind = (typeof automationKinds)[number];
export type PolledAutomationKind = Exclude<AutomationKind, "wordpress_plugin">;
export const isPolledKind = (kind: AutomationKind): kind is PolledAutomationKind => kind !== "wordpress_plugin";
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
export const automationsTable = mysqlTable(
  "socialflow_automations",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 64 }).$type<AutomationKind>().notNull(),
    name: mediumtext("name").notNull(),
    sourceUrl: mediumtext("source_url").notNull(),
    status: varchar("status", { length: 64 }).$type<AutomationStatus>().notNull().default("active"),
    config: json("config").$type<AutomationConfig>().notNull(),
    lastRunAt: timestamptz("last_run_at"),
    nextRunAt: timestamptz("next_run_at"),
    lastStatus: varchar("last_status", { length: 64 }),
    lastError: mediumtext("last_error"),
    consecutiveFailures: int("consecutive_failures").notNull().default(0),
    baselineAt: timestamptz("baseline_at"),
    createdByUserId: uuid("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
    updatedAt: timestamptz("updated_at").notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
  },
  (table) => [index("socialflow_automations_workspace_idx").on(table.workspaceId), index("socialflow_automations_due_idx").on(table.status, table.nextRunAt)],
);

export type AutomationItemStatus = "pending" | "posted" | "skipped" | "failed" | "seen";

// One row per feed item the automation has seen. UNIQUE (automation_id, item_key) is what stops an item becoming two posts.
export const automationItemsTable = mysqlTable(
  "socialflow_automation_items",
  {
    id: uuidPk("id"),
    automationId: uuid("automation_id").notNull().references(() => automationsTable.id, { onDelete: "cascade" }),
    itemKey: varchar("item_key", { length: 500 }).notNull(),
    title: mediumtext("title"),
    url: mediumtext("url"),
    publishedAt: timestamptz("published_at"),
    status: varchar("status", { length: 64 }).$type<AutomationItemStatus>().notNull(),
    postId: uuid("post_id").references(() => postsTable.id, { onDelete: "set null" }),
    attempts: int("attempts").notNull().default(0),
    error: mediumtext("error"),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
    updatedAt: timestamptz("updated_at").notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
  },
  (table) => [unique("socialflow_automation_items_automation_id_item_key_key").on(table.automationId, table.itemKey), index("socialflow_automation_items_recent_idx").on(table.automationId, table.createdAt)],
);

export type AutomationRunStatus = "success" | "no_new" | "partial" | "failed";

export const automationRunsTable = mysqlTable(
  "socialflow_automation_runs",
  {
    id: uuidPk("id"),
    automationId: uuid("automation_id").notNull().references(() => automationsTable.id, { onDelete: "cascade" }),
    startedAt: timestamptz("started_at").notNull().$defaultFn(() => new Date()),
    finishedAt: timestamptz("finished_at"),
    status: varchar("status", { length: 64 }).$type<AutomationRunStatus>().notNull(),
    itemsFound: int("items_found").notNull().default(0),
    itemsNew: int("items_new").notNull().default(0),
    postsCreated: int("posts_created").notNull().default(0),
    error: mediumtext("error"),
  },
  (table) => [index("socialflow_automation_runs_idx").on(table.automationId, table.startedAt)],
);

export type WordPressConnectionStatus = "pending" | "connected" | "disconnected";

// The plugin side of a "wordpress_plugin" automation: the key that signs the plugin's requests (the secret is stored
// encrypted, see lib/crypto.ts) and what the plugin last reported about its site. pending = key issued, plugin not
// connected yet; disconnected = the WordPress admin disconnected it.
export const wordpressConnectionsTable = mysqlTable(
  "socialflow_wordpress_connections",
  {
    id: uuidPk("id"),
    automationId: uuid("automation_id").notNull().unique().references(() => automationsTable.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    keyId: varchar("key_id", { length: 64 }).notNull().unique(),
    secretEncrypted: mediumtext("secret_encrypted").notNull(),
    status: varchar("status", { length: 64 }).$type<WordPressConnectionStatus>().notNull().default("pending"),
    siteUrl: mediumtext("site_url"),
    siteName: mediumtext("site_name"),
    wpVersion: mediumtext("wp_version"),
    pluginVersion: mediumtext("plugin_version"),
    connectedAt: timestamptz("connected_at"),
    lastSeenAt: timestamptz("last_seen_at"),
    lastPostAt: timestamptz("last_post_at"),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
    updatedAt: timestamptz("updated_at").notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
  },
  (table) => [index("socialflow_wordpress_connections_workspace_idx").on(table.workspaceId)],
);

export type BulkImportStatus = "completed" | "partial" | "failed";
export type BulkImportRowError = { row: number; message: string };

// A record of each CSV import: counts and the per-row reasons rows were not imported.
export const bulkImportsTable = mysqlTable(
  "socialflow_bulk_imports",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    fileName: mediumtext("file_name").notNull(),
    totalRows: int("total_rows").notNull().default(0),
    createdCount: int("created_count").notNull().default(0),
    failedCount: int("failed_count").notNull().default(0),
    status: varchar("status", { length: 64 }).$type<BulkImportStatus>().notNull(),
    mode: varchar("mode", { length: 64 }).notNull(),
    errors: json("errors").$type<BulkImportRowError[]>().notNull().$defaultFn(() => []),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("socialflow_bulk_imports_workspace_idx").on(table.workspaceId, table.createdAt)],
);

export type Automation = typeof automationsTable.$inferSelect;
export type AutomationItem = typeof automationItemsTable.$inferSelect;
export type AutomationRun = typeof automationRunsTable.$inferSelect;
export type WordPressConnection = typeof wordpressConnectionsTable.$inferSelect;
export type BulkImport = typeof bulkImportsTable.$inferSelect;
