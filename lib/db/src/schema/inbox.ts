import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid, integer } from "drizzle-orm/pg-core";
import { connectedAccountsTable } from "./connected-accounts";
import { postTargetsTable } from "./posts";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

export const inboxStatuses = ["open", "resolved"] as const;
export type InboxStatus = (typeof inboxStatuses)[number];
export const inboxKinds = ["comment", "message", "mention"] as const;
export type InboxKind = (typeof inboxKinds)[number];

// A comment left by someone else under one of the workspace's published posts, as read from the network.
export const inboxItemsTable = pgTable(
  "socialflow_inbox_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    connectedAccountId: uuid("connected_account_id").notNull().references(() => connectedAccountsTable.id, { onDelete: "cascade" }),
    postTargetId: uuid("post_target_id").references(() => postTargetsTable.id, { onDelete: "set null" }),
    platform: text("platform").notNull(),
    // The network's ID for the comment (unique per connected account) and for the post or video it is under.
    externalId: text("external_id").notNull(),
    externalPostId: text("external_post_id"),
    // Set when this comment is itself a reply to another comment.
    parentExternalId: text("parent_external_id"),
    authorName: text("author_name").notNull(),
    authorAvatar: text("author_avatar"),
    body: text("body").notNull(),
    createdAtNetwork: timestamp("created_at_network", { withTimezone: true }).notNull(),
    status: text("status").$type<InboxStatus>().notNull().default("open"),
    readAt: timestamp("read_at", { withTimezone: true }),
    assignedToUserId: uuid("assigned_to_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    replied: boolean("replied").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // comment (under a post), message (one direct message; rows of a conversation share thread_id) or mention (a post the account is tagged in).
    kind: text("kind").$type<InboxKind>().notNull().default("comment"),
    threadId: text("thread_id"),
    // Messages: the other person's ID on the network (needed to answer), and whether the account itself wrote the message.
    participantId: text("participant_id"),
    fromPage: boolean("from_page").notNull().default(false),
    permalink: text("permalink"),
  },
  (table) => [
    uniqueIndex("socialflow_inbox_items_external_idx").on(table.connectedAccountId, table.externalId),
    index("socialflow_inbox_items_kind_idx").on(table.workspaceId, table.kind, table.status, table.createdAtNetwork),
    index("socialflow_inbox_items_thread_idx").on(table.connectedAccountId, table.threadId, table.createdAtNetwork),
    index("socialflow_inbox_items_list_idx").on(table.workspaceId, table.status, table.createdAtNetwork),
  ],
);

export const inboxReplyStatuses = ["sent", "failed"] as const;
export type InboxReplyStatus = (typeof inboxReplyStatuses)[number];

// A reply written in the app and sent to the network (or the failed attempt, with the reason).
export const inboxRepliesTable = pgTable(
  "socialflow_inbox_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id").notNull().references(() => inboxItemsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    status: text("status").$type<InboxReplyStatus>().notNull(),
    error: text("error"),
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("socialflow_inbox_replies_item_idx").on(table.itemId, table.createdAt)],
);

// What the last collection of an account found, so the inbox can say why an account has nothing.
export const inboxSyncTable = pgTable("socialflow_inbox_sync", {
  connectedAccountId: uuid("connected_account_id").primaryKey().references(() => connectedAccountsTable.id, { onDelete: "cascade" }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastError: text("last_error"),
  postsRead: integer("posts_read").notNull().default(0),
  messagesError: text("messages_error"),
  mentionsError: text("mentions_error"),
  messagesSyncedAt: timestamp("messages_synced_at", { withTimezone: true }),
  mentionsSyncedAt: timestamp("mentions_synced_at", { withTimezone: true }),
});

export type InboxItem = typeof inboxItemsTable.$inferSelect;
export type InboxReply = typeof inboxRepliesTable.$inferSelect;
export type InboxSync = typeof inboxSyncTable.$inferSelect;
