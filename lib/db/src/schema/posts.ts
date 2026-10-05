import { index, int, mediumtext, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { timestamptz, uuid, uuidPk } from "./_columns";
import { connectedAccountsTable } from "./connected-accounts";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

export const postStatuses = ["draft", "scheduled", "publishing", "published", "failed"] as const;
export type PostStatus = (typeof postStatuses)[number];

export const postsTable = mysqlTable(
  "socialflow_posts",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    content: mediumtext("content").notNull().default(""),
    status: varchar("status", { length: 64 }).$type<PostStatus>().notNull().default("draft"),
    // UTC instant. Null for drafts.
    scheduledAt: timestamptz("scheduled_at"),
    publishedAt: timestamptz("published_at"),
    // Posted as a comment under the post right after it goes out, where the network allows it.
    firstComment: mediumtext("first_comment"),
    // A link attached as a preview card: a snapshot of what the composer showed (title and description may be edited).
    linkUrl: mediumtext("link_url"),
    linkTitle: mediumtext("link_title"),
    linkDescription: mediumtext("link_description"),
    linkImageUrl: mediumtext("link_image_url"),
    // Set when this post is one occurrence of a recurring post (see recurrences.ts).
    recurrenceId: uuid("recurrence_id"),
    occurrenceIndex: int("occurrence_index"),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("socialflow_posts_workspace_schedule_idx").on(table.workspaceId, table.scheduledAt),
    index("socialflow_posts_workspace_status_idx").on(table.workspaceId, table.status),
  ],
);

// One row per connected account a post is going to. Per-target status lets a
// multi-account post partially succeed.
export const postTargetsTable = mysqlTable(
  "socialflow_post_targets",
  {
    id: uuidPk("id"),
    postId: uuid("post_id")
      .notNull()
      .references(() => postsTable.id, { onDelete: "cascade" }),
    connectedAccountId: uuid("connected_account_id")
      .notNull()
      .references(() => connectedAccountsTable.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 64 }).$type<PostStatus>().notNull().default("draft"),
    errorMessage: mediumtext("error_message"),
    externalPostId: mediumtext("external_post_id"),
    // null = no first comment for this target; otherwise published | failed | unsupported.
    firstCommentStatus: varchar("first_comment_status", { length: 64 }),
    firstCommentError: mediumtext("first_comment_error"),
    firstCommentExternalId: mediumtext("first_comment_external_id"),
  },
  (table) => [
    uniqueIndex("socialflow_post_targets_unique_idx").on(table.postId, table.connectedAccountId),
    index("socialflow_post_targets_account_idx").on(table.connectedAccountId),
  ],
);

export type Post = typeof postsTable.$inferSelect;
export type PostTarget = typeof postTargetsTable.$inferSelect;
