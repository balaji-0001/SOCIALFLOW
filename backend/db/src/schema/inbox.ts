import { boolean, index, int, mediumtext, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { timestamptz, uuid, uuidPk } from "./_columns";
import { connectedAccountsTable } from "./connected-accounts";
import { postTargetsTable } from "./posts";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

export const inboxStatuses = ["open", "resolved"] as const;
export type InboxStatus = (typeof inboxStatuses)[number];
export const inboxKinds = ["comment", "message", "mention"] as const;
export type InboxKind = (typeof inboxKinds)[number];

// A comment left by someone else under one of the workspace's published posts, as read from the network.
export const inboxItemsTable = mysqlTable(
  "socialflow_inbox_items",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    connectedAccountId: uuid("connected_account_id").notNull().references(() => connectedAccountsTable.id, { onDelete: "cascade" }),
    postTargetId: uuid("post_target_id").references(() => postTargetsTable.id, { onDelete: "set null" }),
    platform: varchar("platform", { length: 64 }).notNull(),
    // The network's ID for the comment (unique per connected account) and for the post or video it is under.
    externalId: varchar("external_id", { length: 255 }).notNull(),
    externalPostId: mediumtext("external_post_id"),
    // Set when this comment is itself a reply to another comment.
    parentExternalId: mediumtext("parent_external_id"),
    authorName: mediumtext("author_name").notNull(),
    authorAvatar: mediumtext("author_avatar"),
    body: mediumtext("body").notNull(),
    createdAtNetwork: timestamptz("created_at_network").notNull(),
    status: varchar("status", { length: 64 }).$type<InboxStatus>().notNull().default("open"),
    readAt: timestamptz("read_at"),
    assignedToUserId: uuid("assigned_to_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    replied: boolean("replied").notNull().default(false),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
    // comment (under a post), message (one direct message; rows of a conversation share thread_id) or mention (a post the account is tagged in).
    kind: varchar("kind", { length: 64 }).$type<InboxKind>().notNull().default("comment"),
    threadId: varchar("thread_id", { length: 255 }),
    // Messages: the other person's ID on the network (needed to answer), and whether the account itself wrote the message.
    participantId: mediumtext("participant_id"),
    fromPage: boolean("from_page").notNull().default(false),
    permalink: mediumtext("permalink"),
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
export const inboxRepliesTable = mysqlTable(
  "socialflow_inbox_replies",
  {
    id: uuidPk("id"),
    itemId: uuid("item_id").notNull().references(() => inboxItemsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    body: mediumtext("body").notNull(),
    status: varchar("status", { length: 64 }).$type<InboxReplyStatus>().notNull(),
    error: mediumtext("error"),
    externalId: mediumtext("external_id"),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("socialflow_inbox_replies_item_idx").on(table.itemId, table.createdAt)],
);

// What the last collection of an account found, so the inbox can say why an account has nothing.
export const inboxSyncTable = mysqlTable("socialflow_inbox_sync", {
  connectedAccountId: uuid("connected_account_id").primaryKey().references(() => connectedAccountsTable.id, { onDelete: "cascade" }),
  lastSyncedAt: timestamptz("last_synced_at"),
  lastError: mediumtext("last_error"),
  postsRead: int("posts_read").notNull().default(0),
  messagesError: mediumtext("messages_error"),
  mentionsError: mediumtext("mentions_error"),
  messagesSyncedAt: timestamptz("messages_synced_at"),
  mentionsSyncedAt: timestamptz("mentions_synced_at"),
});

export type InboxItem = typeof inboxItemsTable.$inferSelect;
export type InboxReply = typeof inboxRepliesTable.$inferSelect;
export type InboxSync = typeof inboxSyncTable.$inferSelect;
