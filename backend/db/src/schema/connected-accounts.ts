import { index, mediumtext, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { json, timestamptz, uuid, uuidPk } from "./_columns";
import { workspacesTable } from "./workspaces";

export const connectionStatuses = [
  "active",
  "expired",
  "revoked",
  "missing_permissions",
  "error",
] as const;
export type ConnectionStatus = (typeof connectionStatuses)[number];

export const connectedAccountsTable = mysqlTable(
  "socialflow_connected_accounts",
  {
    id: uuidPk("id"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 64 }).notNull(),
    // e.g. facebook_page, instagram_business, linkedin_member,
    // linkedin_organization, youtube_channel
    accountType: varchar("account_type", { length: 64 }).notNull(),
    externalAccountId: varchar("external_account_id", { length: 255 }).notNull(),
    displayName: mediumtext("display_name").notNull(),
    username: mediumtext("username"),
    avatarUrl: mediumtext("avatar_url"),
    // Tokens are AES-256-GCM encrypted (see api-server/src/lib/crypto.ts)
    // and are never returned by the API.
    accessTokenEncrypted: mediumtext("access_token_encrypted").notNull(),
    refreshTokenEncrypted: mediumtext("refresh_token_encrypted"),
    tokenExpiresAt: timestamptz("token_expires_at"),
    refreshTokenExpiresAt: timestamptz("refresh_token_expires_at"),
    scopes: json("scopes").$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    status: varchar("status", { length: 64 }).$type<ConnectionStatus>().notNull().default("active"),
    statusDetail: mediumtext("status_detail"),
    // The provider-side user who granted access (e.g. the Facebook user who
    // manages the Page).
    authorizedByExternalUserId: mediumtext("authorized_by_external_user_id"),
    metadata: json("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
    lastVerifiedAt: timestamptz("last_verified_at"),
    createdAt: timestamptz("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("socialflow_connected_accounts_unique_idx").on(
      table.workspaceId,
      table.platform,
      table.externalAccountId,
    ),
    index("socialflow_connected_accounts_workspace_idx").on(table.workspaceId),
  ],
);

export type ConnectedAccount = typeof connectedAccountsTable.$inferSelect;
export type InsertConnectedAccount = typeof connectedAccountsTable.$inferInsert;
