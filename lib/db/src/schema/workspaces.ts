import {
  index,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// A workspace owns connected social accounts. Until real user authentication
// exists, a workspace is created per browser session (see
// artifacts/api-server/src/lib/session.ts). `ownerUserId` is reserved for
// attaching workspaces to authenticated users later.
export const workspacesTable = pgTable("socialflow_workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().default("My workspace"),
  ownerUserId: text("owner_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const sessionsTable = pgTable(
  "socialflow_sessions",
  {
    id: serial("id").primaryKey(),
    // SHA-256 of the random token held in the signed, httpOnly cookie.
    tokenHash: text("token_hash").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("socialflow_sessions_token_hash_idx").on(table.tokenHash),
    index("socialflow_sessions_workspace_idx").on(table.workspaceId),
  ],
);

export type Workspace = typeof workspacesTable.$inferSelect;
export type Session = typeof sessionsTable.$inferSelect;
