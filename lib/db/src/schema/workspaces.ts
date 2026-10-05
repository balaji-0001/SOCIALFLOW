import { index, int, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { timestamptz, uuid, uuidPk } from "./_columns";
import { usersTable } from "./users";

// A workspace owns connected social accounts. Which users can access a
// workspace is recorded in socialflow_workspace_members, not here;
// `ownerUserId` is a denormalized convenience pointer to the creator, kept
// nullable so a workspace can survive its owner's account being deleted.
export const workspacesTable = mysqlTable("socialflow_workspaces", {
  id: uuidPk("id"),
  name: varchar("name", { length: 255 }).notNull().default("My workspace"),
  ownerUserId: uuid("owner_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamptz("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
});

// An authenticated browser session. A session identifies a signed-in user;
// which workspace it currently acts on is resolved via
// socialflow_workspace_members (see api-server/src/lib/session.ts).
export const sessionsTable = mysqlTable(
  "socialflow_sessions",
  {
    id: int("id").autoincrement().primaryKey(),
    // SHA-256 of the random token held in the signed, httpOnly cookie.
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // The workspace this session is currently working in, for users who belong to several. Null = their first.
    activeWorkspaceId: uuid("active_workspace_id").references(() => workspacesTable.id, { onDelete: "set null" }),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("socialflow_sessions_token_hash_idx").on(table.tokenHash),
    index("socialflow_sessions_user_idx").on(table.userId),
  ],
);

export type Workspace = typeof workspacesTable.$inferSelect;
export type Session = typeof sessionsTable.$inferSelect;
