import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { postsTable } from "./posts";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

export const approvalStatuses = ["pending", "approved", "rejected", "changes_requested", "withdrawn"] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];

// Per-workspace switch: when `required`, a post is only published once it has an approved approval.
export const approvalSettingsTable = pgTable("socialflow_approval_settings", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspacesTable.id, { onDelete: "cascade" }),
  required: boolean("required").notNull().default(false),
  updatedBy: uuid("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One approval row per post; asking again after a decision moves the same row back to pending.
export const postApprovalsTable = pgTable(
  "socialflow_post_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id").notNull().references(() => postsTable.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    requestedBy: uuid("requested_by").references(() => usersTable.id, { onDelete: "set null" }),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid("decided_by").references(() => usersTable.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    note: text("note"),
  },
  (table) => [
    uniqueIndex("socialflow_post_approvals_post_idx").on(table.postId),
    index("socialflow_post_approvals_ws_status_idx").on(table.workspaceId, table.status),
  ],
);

export const postApprovalCommentsTable = pgTable(
  "socialflow_post_approval_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    approvalId: uuid("approval_id").notNull().references(() => postApprovalsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("socialflow_post_approval_comments_idx").on(table.approvalId, table.createdAt)],
);

export type PostApproval = typeof postApprovalsTable.$inferSelect;
