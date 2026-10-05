import { boolean, index, mediumtext, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { timestamptz, uuid, uuidPk } from "./_columns";
import { postsTable } from "./posts";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

export const approvalStatuses = ["pending", "approved", "rejected", "changes_requested", "withdrawn"] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];

// Per-workspace switch: when `required`, a post is only published once it has an approved approval.
export const approvalSettingsTable = mysqlTable("socialflow_approval_settings", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspacesTable.id, { onDelete: "cascade" }),
  required: boolean("required").notNull().default(false),
  updatedBy: uuid("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedAt: timestamptz("updated_at").notNull().$defaultFn(() => new Date()),
});

// One approval row per post; asking again after a decision moves the same row back to pending.
export const postApprovalsTable = mysqlTable(
  "socialflow_post_approvals",
  {
    id: uuidPk("id"),
    postId: uuid("post_id").notNull().references(() => postsTable.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 64 }).$type<ApprovalStatus>().notNull().default("pending"),
    requestedBy: uuid("requested_by").references(() => usersTable.id, { onDelete: "set null" }),
    requestedAt: timestamptz("requested_at").notNull().$defaultFn(() => new Date()),
    decidedBy: uuid("decided_by").references(() => usersTable.id, { onDelete: "set null" }),
    decidedAt: timestamptz("decided_at"),
    note: mediumtext("note"),
  },
  (table) => [
    uniqueIndex("socialflow_post_approvals_post_idx").on(table.postId),
    index("socialflow_post_approvals_ws_status_idx").on(table.workspaceId, table.status),
  ],
);

export const postApprovalCommentsTable = mysqlTable(
  "socialflow_post_approval_comments",
  {
    id: uuidPk("id"),
    approvalId: uuid("approval_id").notNull().references(() => postApprovalsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    body: mediumtext("body").notNull(),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("socialflow_post_approval_comments_idx").on(table.approvalId, table.createdAt)],
);

export type PostApproval = typeof postApprovalsTable.$inferSelect;
