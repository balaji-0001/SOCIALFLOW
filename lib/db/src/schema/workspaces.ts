import {
  index,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// A workspace owns connected social accounts. Which users can access a
// workspace is recorded in socialflow_workspace_members, not here;
// `ownerUserId` is a denormalized convenience pointer to the creator, kept
// nullable so a workspace can survive its owner's account being deleted.
export const workspacesTable = pgTable("socialflow_workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().default("My workspace"),
  ownerUserId: uuid("owner_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// An authenticated browser session. A session identifies a signed-in user;
// which workspace it currently acts on is resolved via
// socialflow_workspace_members (see api-server/src/lib/session.ts).
export const sessionsTable = pgTable(
  "socialflow_sessions",
  {
    id: serial("id").primaryKey(),
    // SHA-256 of the random token held in the signed, httpOnly cookie.
    tokenHash: text("token_hash").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // The workspace this session is currently working in, for users who belong to several. Null = their first.
    activeWorkspaceId: uuid("active_workspace_id").references(() => workspacesTable.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("socialflow_sessions_token_hash_idx").on(table.tokenHash),
    index("socialflow_sessions_user_idx").on(table.userId),
  ],
);

export type Workspace = typeof workspacesTable.$inferSelect;
export type Session = typeof sessionsTable.$inferSelect;
