import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { connectedAccountsTable } from "./connected-accounts";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

export const postStatuses = ["draft", "scheduled", "publishing", "published", "failed"] as const;
export type PostStatus = (typeof postStatuses)[number];

export const postsTable = pgTable(
  "socialflow_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    content: text("content").notNull().default(""),
    status: text("status").$type<PostStatus>().notNull().default("draft"),
    // UTC instant. Null for drafts.
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // Posted as a comment under the post right after it goes out, where the network allows it.
    firstComment: text("first_comment"),
    // A link attached as a preview card: a snapshot of what the composer showed (title and description may be edited).
    linkUrl: text("link_url"),
    linkTitle: text("link_title"),
    linkDescription: text("link_description"),
    linkImageUrl: text("link_image_url"),
    // Set when this post is one occurrence of a recurring post (see recurrences.ts).
    recurrenceId: uuid("recurrence_id"),
    occurrenceIndex: integer("occurrence_index"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("socialflow_posts_workspace_schedule_idx").on(table.workspaceId, table.scheduledAt),
    index("socialflow_posts_workspace_status_idx").on(table.workspaceId, table.status),
  ],
);

// One row per connected account a post is going to. Per-target status lets a
// multi-account post partially succeed.
export const postTargetsTable = pgTable(
  "socialflow_post_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => postsTable.id, { onDelete: "cascade" }),
    connectedAccountId: uuid("connected_account_id")
      .notNull()
      .references(() => connectedAccountsTable.id, { onDelete: "cascade" }),
    status: text("status").$type<PostStatus>().notNull().default("draft"),
    errorMessage: text("error_message"),
    externalPostId: text("external_post_id"),
    // null = no first comment for this target; otherwise published | failed | unsupported.
    firstCommentStatus: text("first_comment_status"),
    firstCommentError: text("first_comment_error"),
    firstCommentExternalId: text("first_comment_external_id"),
  },
  (table) => [
    uniqueIndex("socialflow_post_targets_unique_idx").on(table.postId, table.connectedAccountId),
    index("socialflow_post_targets_account_idx").on(table.connectedAccountId),
  ],
);

export type Post = typeof postsTable.$inferSelect;
export type PostTarget = typeof postTargetsTable.$inferSelect;
