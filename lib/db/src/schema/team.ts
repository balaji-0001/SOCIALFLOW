import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { workspacesTable } from "./workspaces";

// A pending invitation to join a workspace. Only the SHA-256 hash of the emailed token is stored.
export const invitationsTable = pgTable(
  "socialflow_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    invitedByUserId: uuid("invited_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("socialflow_invitations_token_idx").on(table.tokenHash),
    index("socialflow_invitations_workspace_idx").on(table.workspaceId),
  ],
);

// What happened in a workspace: who did what to what, and when. Written by the routes that change access or accounts.
export const auditLogTable = pgTable(
  "socialflow_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    target: text("target"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("socialflow_audit_workspace_idx").on(table.workspaceId, table.createdAt)],
);

export type Invitation = typeof invitationsTable.$inferSelect;
export type AuditEntry = typeof auditLogTable.$inferSelect;
