import { and, eq } from "drizzle-orm";
import {
  connectedAccountsTable,
  db,
  type ConnectedAccount,
  type ConnectionStatus,
} from "@workspace/db";
import { decryptSecret, encryptSecret } from "../crypto";
import { OAuthError } from "./errors";
import { firstCommentSupport } from "../publisher";
import { getProviderDefinition } from "./registry";
import type {
  AccountCandidate,
  OAuthProviderAdapter,
  Platform,
  StoredAccountCredentials,
} from "./types";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// AAD binds each ciphertext to the account it belongs to.
function tokenAad(workspaceId: string, platform: string, externalAccountId: string, kind: "access" | "refresh") {
  return `connected-account:${workspaceId}:${platform}:${externalAccountId}:${kind}`;
}

/** Inserts a new connected account, or refreshes tokens if it already exists. */
export async function saveConnectedAccount(
  executor: Db | Tx,
  workspaceId: string,
  platform: Platform,
  candidate: AccountCandidate,
  authorizedByExternalUserId: string,
): Promise<ConnectedAccount> {
  const aad = (kind: "access" | "refresh") =>
    tokenAad(workspaceId, platform, candidate.externalAccountId, kind);
  const values = {
    workspaceId,
    platform,
    accountType: candidate.accountType,
    externalAccountId: candidate.externalAccountId,
    displayName: candidate.displayName,
    username: candidate.username,
    avatarUrl: candidate.avatarUrl,
    accessTokenEncrypted: encryptSecret(candidate.accessToken, aad("access")),
    refreshTokenEncrypted: candidate.refreshToken ? encryptSecret(candidate.refreshToken, aad("refresh")) : null,
    tokenExpiresAt: candidate.tokenExpiresAt,
    refreshTokenExpiresAt: candidate.refreshTokenExpiresAt,
    scopes: candidate.scopes,
    status: "active" as const,
    statusDetail: null,
    authorizedByExternalUserId,
    metadata: candidate.metadata,
    lastVerifiedAt: new Date(),
  };
  const { workspaceId: _w, platform: _p, externalAccountId: _e, ...updates } = values;
  const [row] = await executor
    .insert(connectedAccountsTable)
    .values(values)
    .onConflictDoUpdate({
      target: [
        connectedAccountsTable.workspaceId,
        connectedAccountsTable.platform,
        connectedAccountsTable.externalAccountId,
      ],
      set: { ...updates, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

export function readCredentials(account: ConnectedAccount): StoredAccountCredentials {
  const aad = (kind: "access" | "refresh") =>
    tokenAad(account.workspaceId, account.platform, account.externalAccountId, kind);
  return {
    externalAccountId: account.externalAccountId,
    accessToken: decryptSecret(account.accessTokenEncrypted, aad("access")),
    refreshToken: account.refreshTokenEncrypted ? decryptSecret(account.refreshTokenEncrypted, aad("refresh")) : null,
    tokenExpiresAt: account.tokenExpiresAt,
    accountType: account.accountType,
    scopes: account.scopes,
  };
}

export async function findAccount(workspaceId: string, accountId: string): Promise<ConnectedAccount | null> {
  const [row] = await db
    .select()
    .from(connectedAccountsTable)
    .where(and(eq(connectedAccountsTable.id, accountId), eq(connectedAccountsTable.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

async function updateAccount(account: ConnectedAccount, set: Partial<typeof connectedAccountsTable.$inferInsert>) {
  const [row] = await db
    .update(connectedAccountsTable)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(connectedAccountsTable.id, account.id))
    .returning();
  return row!;
}

/** Records that a provider call showed the account can't be used (revoked, expired, missing permission). */
export async function markAccountStatus(accountId: string, status: ConnectionStatus, detail: string | null): Promise<void> {
  await db
    .update(connectedAccountsTable)
    .set({ status, statusDetail: detail, updatedAt: new Date() })
    .where(eq(connectedAccountsTable.id, accountId));
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Refreshes the access token if it is about to expire and the provider
 * supports refresh tokens. Facebook Page tokens don't expire, so this is a
 * no-op for Facebook; LinkedIn and Google adapters will use it.
 */
export async function ensureFreshToken(
  account: ConnectedAccount,
  adapter: OAuthProviderAdapter,
): Promise<ConnectedAccount> {
  const expiresSoon =
    account.tokenExpiresAt !== null && account.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
  if (!expiresSoon || !adapter.refreshAccessToken || !account.refreshTokenEncrypted) return account;

  const { refreshToken } = readCredentials(account);
  try {
    const refreshed = await adapter.refreshAccessToken(refreshToken!);
    const aad = (kind: "access" | "refresh") =>
      tokenAad(account.workspaceId, account.platform, account.externalAccountId, kind);
    return await updateAccount(account, {
      accessTokenEncrypted: encryptSecret(refreshed.accessToken, aad("access")),
      refreshTokenEncrypted: refreshed.refreshToken
        ? encryptSecret(refreshed.refreshToken, aad("refresh"))
        : account.refreshTokenEncrypted,
      tokenExpiresAt: refreshed.tokenExpiresAt,
      refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt ?? account.refreshTokenExpiresAt,
      status: "active",
      statusDetail: null,
    });
  } catch (error) {
    const oauthError = error instanceof OAuthError ? error : new OAuthError("provider_error");
    // Only a definitive answer from the provider changes the account's status. A timeout, 5xx or rate
    // limit while refreshing says nothing about the credentials, and marking the account expired would
    // wrongly demand a reconnect (and make scheduled posts skip it). The next attempt simply retries.
    if (oauthError.code !== "token_revoked" && oauthError.code !== "token_expired") return account;
    const status: ConnectionStatus = oauthError.code === "token_revoked" ? "revoked" : "expired";
    return updateAccount(account, { status, statusDetail: oauthError.message });
  }
}

/** Refreshes if needed, then asks the provider whether the token is still valid. */
export async function verifyConnectedAccount(
  account: ConnectedAccount,
  adapter: OAuthProviderAdapter,
): Promise<ConnectedAccount> {
  const fresh = await ensureFreshToken(account, adapter);
  if (fresh.status === "expired" || fresh.status === "revoked") {
    return updateAccount(fresh, { lastVerifiedAt: new Date() });
  }
  const result = await adapter.verifyAccount(readCredentials(fresh));
  return updateAccount(fresh, {
    status: result.status,
    statusDetail: result.detail,
    lastVerifiedAt: new Date(),
    ...(result.scopes ? { scopes: result.scopes } : {}),
    ...(result.tokenExpiresAt !== undefined ? { tokenExpiresAt: result.tokenExpiresAt } : {}),
    ...(result.displayName ? { displayName: result.displayName } : {}),
    ...(result.avatarUrl !== undefined ? { avatarUrl: result.avatarUrl } : {}),
  });
}

/** The status shown to the user, accounting for tokens that expired since the last check. */
export function effectiveStatus(account: ConnectedAccount, now = new Date()): ConnectionStatus {
  if (
    account.status === "active" &&
    account.tokenExpiresAt !== null &&
    account.tokenExpiresAt <= now &&
    !account.refreshTokenEncrypted
  ) {
    return "expired";
  }
  return account.status;
}

/** API representation. Never includes tokens. */
export function serializeAccount(account: ConnectedAccount) {
  const platform = account.platform as Platform;
  const required = getProviderDefinition(platform)?.requiredScopes ?? [];
  const status = effectiveStatus(account);
  return {
    id: account.id,
    platform,
    accountType: account.accountType,
    externalAccountId: account.externalAccountId,
    displayName: account.displayName,
    username: account.username,
    avatarUrl: account.avatarUrl,
    status,
    statusDetail: status === "expired" && account.status === "active" ? "The access token has expired." : account.statusDetail,
    scopes: account.scopes,
    missingScopes: required.filter((scope) => !account.scopes.includes(scope)),
    firstComment: firstCommentSupport(platform, account.scopes).state,
    tokenExpiresAt: account.tokenExpiresAt,
    lastVerifiedAt: account.lastVerifiedAt,
    connectedAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
