import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";

export const connectionStatuses = [
  "active",
  "expired",
  "revoked",
  "missing_permissions",
  "error",
] as const;
export type ConnectionStatus = (typeof connectionStatuses)[number];

export const connectedAccountsTable = pgTable(
  "socialflow_connected_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    // e.g. facebook_page, instagram_business, linkedin_member,
    // linkedin_organization, youtube_channel
    accountType: text("account_type").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    displayName: text("display_name").notNull(),
    username: text("username"),
    avatarUrl: text("avatar_url"),
    // Tokens are AES-256-GCM encrypted (see api-server/src/lib/crypto.ts)
    // and are never returned by the API.
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text("status").$type<ConnectionStatus>().notNull().default("active"),
    statusDetail: text("status_detail"),
    // The provider-side user who granted access (e.g. the Facebook user who
    // manages the Page).
    authorizedByExternalUserId: text("authorized_by_external_user_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
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
