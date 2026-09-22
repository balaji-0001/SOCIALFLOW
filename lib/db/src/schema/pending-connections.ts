import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";

export type PendingCandidateSummary = {
  externalAccountId: string;
  accountType: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  selectable: boolean;
  warnings: string[];
};

// Holds the result of a successful OAuth callback while the user picks which
// Pages / organizations / channels to connect. The full candidate list
// (including tokens) is encrypted; `candidates` holds a token-free summary.
export const pendingConnectionsTable = pgTable(
  "socialflow_pending_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    payloadEncrypted: text("payload_encrypted").notNull(),
    candidates: jsonb("candidates").$type<PendingCandidateSummary[]>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("socialflow_pending_connections_workspace_idx").on(table.workspaceId),
  ],
);

export type PendingConnection = typeof pendingConnectionsTable.$inferSelect;
