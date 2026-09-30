import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";

// Named sets of @handles the composer can insert in one click.
export const mentionGroupsTable = pgTable(
  "socialflow_mention_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    handles: text("handles").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("socialflow_mention_groups_unique").on(table.workspaceId, table.name)],
);

export type MentionGroup = typeof mentionGroupsTable.$inferSelect;
