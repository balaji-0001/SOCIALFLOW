import { mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { json, timestamptz, uuid, uuidPk } from "./_columns";
import { workspacesTable } from "./workspaces";

// Named sets of @handles the composer can insert in one click.
export const mentionGroupsTable = mysqlTable(
  "socialflow_mention_groups",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    handles: json("handles").$type<string[]>().notNull().$defaultFn(() => []),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("socialflow_mention_groups_unique").on(table.workspaceId, table.name)],
);

export type MentionGroup = typeof mentionGroupsTable.$inferSelect;
