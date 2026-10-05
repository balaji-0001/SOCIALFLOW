import { index, mysqlTable, primaryKey, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { timestamptz, uuid, uuidPk } from "./_columns";
import { postsTable } from "./posts";
import { workspacesTable } from "./workspaces";

// Workspace-defined labels for organising posts (campaign, client, theme...).
export const tagsTable = mysqlTable(
  "socialflow_tags",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    color: varchar("color", { length: 32 }).notNull().default("#6366f1"),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("socialflow_tags_unique").on(table.workspaceId, table.name)],
);

export const postTagsTable = mysqlTable(
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
