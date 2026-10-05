import { index, int, mediumtext, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { timestamptz, uuid } from "./_columns";
import { sessionsTable, workspacesTable } from "./workspaces";

// One row per in-flight authorization request. Rows are deleted atomically
// when the callback consumes them, so a state value can only be used once.
export const oauthStatesTable = mysqlTable(
  "socialflow_oauth_states",
  {
    id: int("id").autoincrement().primaryKey(),
    stateHash: varchar("state_hash", { length: 128 }).notNull(),
    sessionId: int("session_id")
      .notNull()
      .references(() => sessionsTable.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 64 }).notNull(),
    // Set when the flow re-authorizes an existing connected account.
    reconnectAccountId: uuid("reconnect_account_id"),
    // Encrypted PKCE verifier for providers that support PKCE.
    codeVerifierEncrypted: mediumtext("code_verifier_encrypted"),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("socialflow_oauth_states_hash_idx").on(table.stateHash),
    index("socialflow_oauth_states_expires_idx").on(table.expiresAt),
  ],
);

export type OauthState = typeof oauthStatesTable.$inferSelect;
