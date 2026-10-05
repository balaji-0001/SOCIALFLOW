import { index, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { timestamptz, uuid, uuidPk } from "./_columns";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

// Roles, from most to least access. What each may do is defined in api-server/src/lib/permissions.ts.
export const workspaceRoles = ["owner", "admin", "editor", "approver", "viewer"] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];

// Which users can access which workspaces. A workspace can have more than
// one member in the future (team invites); today exactly one "owner" row is
// created per user at sign-up. Every workspace-scoped route resolves the
// caller's workspace through this table, never by workspace ID alone, so one
// user can never read or modify another user's connections.
export const workspaceMembersTable = mysqlTable(
  "socialflow_workspace_members",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 64 }).$type<WorkspaceRole>().notNull().default("owner"),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("socialflow_workspace_members_unique_idx").on(table.workspaceId, table.userId),
    index("socialflow_workspace_members_user_idx").on(table.userId),
  ],
);

export type WorkspaceMember = typeof workspaceMembersTable.$inferSelect;
