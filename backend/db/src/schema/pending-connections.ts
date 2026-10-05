import { index, mediumtext, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { json, timestamptz, uuid, uuidPk } from "./_columns";
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
export const pendingConnectionsTable = mysqlTable(
  "socialflow_pending_connections",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 64 }).notNull(),
    payloadEncrypted: mediumtext("payload_encrypted").notNull(),
    candidates: json("candidates").$type<PendingCandidateSummary[]>().notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("socialflow_pending_connections_workspace_idx").on(table.workspaceId),
  ],
);

export type PendingConnection = typeof pendingConnectionsTable.$inferSelect;
