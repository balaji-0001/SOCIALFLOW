import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sessionsTable, workspacesTable } from "./workspaces";

// One row per in-flight authorization request. Rows are deleted atomically
// when the callback consumes them, so a state value can only be used once.
export const oauthStatesTable = pgTable(
  "socialflow_oauth_states",
  {
    id: serial("id").primaryKey(),
    stateHash: text("state_hash").notNull(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessionsTable.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    // Set when the flow re-authorizes an existing connected account.
    reconnectAccountId: uuid("reconnect_account_id"),
    // Encrypted PKCE verifier for providers that support PKCE.
    codeVerifierEncrypted: text("code_verifier_encrypted"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("socialflow_oauth_states_hash_idx").on(table.stateHash),
    index("socialflow_oauth_states_expires_idx").on(table.expiresAt),
  ],
);

export type OauthState = typeof oauthStatesTable.$inferSelect;
