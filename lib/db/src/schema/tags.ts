import { index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { postsTable } from "./posts";
import { workspacesTable } from "./workspaces";

// Workspace-defined labels for organising posts (campaign, client, theme...).
export const tagsTable = pgTable(
  "socialflow_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#6366f1"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("socialflow_tags_unique").on(table.workspaceId, table.name)],
);

export const postTagsTable = pgTable(
  "socialflow_post_tags",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => postsTable.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tagsTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.postId, table.tagId] }), index("socialflow_post_tags_tag_idx").on(table.tagId)],
);

export type Tag = typeof tagsTable.$inferSelect;
