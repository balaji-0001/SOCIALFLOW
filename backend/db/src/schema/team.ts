import { index, mediumtext, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { json, timestamptz, uuid, uuidPk } from "./_columns";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

// A pending invitation to join a workspace. Only the SHA-256 hash of the emailed token is stored.
export const invitationsTable = mysqlTable(
  "socialflow_invitations",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    email: mediumtext("email").notNull(),
    role: varchar("role", { length: 64 }).notNull(),
    invitedByUserId: uuid("invited_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    acceptedAt: timestamptz("accepted_at"),
    revokedAt: timestamptz("revoked_at"),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("socialflow_invitations_token_idx").on(table.tokenHash),
    index("socialflow_invitations_workspace_idx").on(table.workspaceId),
  ],
);

// What happened in a workspace: who did what to what, and when. Written by the routes that change access or accounts.
export const auditLogTable = mysqlTable(
  "socialflow_audit_log",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    action: mediumtext("action").notNull(),
    target: mediumtext("target"),
    detail: json("detail").$type<Record<string, unknown>>().notNull().$defaultFn(() => ({})),
    createdAt: timestamptz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("socialflow_audit_workspace_idx").on(table.workspaceId, table.createdAt)],
);

export type Invitation = typeof invitationsTable.$inferSelect;
export type AuditEntry = typeof auditLogTable.$inferSelect;
