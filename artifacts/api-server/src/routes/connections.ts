import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, gt, lt } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CancelPendingConnectionParams,
  CompletePendingConnectionBody,
  CompletePendingConnectionParams,
  CompletePendingConnectionResponse,
  DisconnectAccountParams,
  GetPendingConnectionParams,
  GetPendingConnectionResponse,
  ListConnectedAccountsResponse,
  ListConnectionProvidersResponse,
  VerifyConnectedAccountParams,
  VerifyConnectedAccountResponse,
} from "@workspace/api-zod";
import {
  connectedAccountsTable,
  db,
  oauthStatesTable,
  pendingConnectionsTable,
  type PendingCandidateSummary,
} from "@workspace/db";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "../lib/crypto";
import { jsonError } from "../lib/http-errors";
import {
  findAccount,
  saveConnectedAccount,
  serializeAccount,
  verifyConnectedAccount,
} from "../lib/oauth/accounts";
import {
  PENDING_TTL_MS,
  SIGNIN_PATH,
  STATE_TTL_MS,
  WORKSPACE_PATH,
  getCallbackUrl,
} from "../lib/oauth/config";
import { OAuthError, type OAuthErrorCode } from "../lib/oauth/errors";
import {
  getAdapter,
  listProviderDefinitions,
  missingConfiguration,
} from "../lib/oauth/registry";
import { isPlatform, type AccountCandidate, type Platform } from "../lib/oauth/types";
import { requireAccess } from "../lib/access";
import { recordAudit } from "../lib/audit";
import { can } from "../lib/permissions";
import { resolveUser, resolveWorkspace, type WorkspaceContext } from "../lib/session";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workspaceRedirect(res: Response, params: Record<string, string>): void {
  res.redirect(302, `${WORKSPACE_PATH}?${new URLSearchParams(params).toString()}`);
}

function redirectWithError(res: Response, platform: string, error: OAuthError | OAuthErrorCode): void {
  const oauthError = typeof error === "string" ? new OAuthError(error) : error;
  const params: Record<string, string> = { connection_error: oauthError.code, platform };
  if (oauthError.details.missingScopes?.length) {
    params.missing = oauthError.details.missingScopes.join(",");
  }
  workspaceRedirect(res, params);
}

function queryString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length < 4096 ? value : null;
}

/** Resolves the signed-in user's workspace, or writes a 401 and returns null. */
async function requireWorkspace(req: Request, res: Response): Promise<WorkspaceContext | null> {
  return requireAccess(req, res, req.method === "GET" ? "accounts:read" : "accounts:manage");
}

type PendingPayload = {
  externalUserId: string;
  candidates: Array<Omit<AccountCandidate, "tokenExpiresAt" | "refreshTokenExpiresAt"> & {
    tokenExpiresAt: string | null;
    refreshTokenExpiresAt: string | null;
  }>;
};

const pendingAad = (id: string, workspaceId: string) => `pending-connection:${id}:${workspaceId}`;

function decodePendingCandidates(payload: PendingPayload): AccountCandidate[] {
  return payload.candidates.map((c) => ({
    ...c,
    tokenExpiresAt: c.tokenExpiresAt ? new Date(c.tokenExpiresAt) : null,
    refreshTokenExpiresAt: c.refreshTokenExpiresAt ? new Date(c.refreshTokenExpiresAt) : null,
  }));
}

async function purgeExpired(): Promise<void> {
  const now = new Date();
  await db.delete(oauthStatesTable).where(lt(oauthStatesTable.expiresAt, now));
  await db.delete(pendingConnectionsTable).where(lt(pendingConnectionsTable.expiresAt, now));
}

// ---------------------------------------------------------------------------
// Provider setup status
// ---------------------------------------------------------------------------

router.get("/connections/providers", (_req, res): void => {
  const providers = listProviderDefinitions().map((definition) => {
    const missing = definition.implemented ? missingConfiguration(definition.platform) : [];
    return {
      platform: definition.platform,
      name: definition.displayName,
      implemented: definition.implemented,
      configured: definition.implemented && missing.length === 0,
      missingConfiguration: missing,
      requiredScopes: definition.requiredScopes,
      optionalScopes: definition.optionalScopes,
      callbackUrl: getCallbackUrl(definition.platform),
    };
  });
  res.json(ListConnectionProvidersResponse.parse({ providers }));
});

// ---------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------

router.get("/connections", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const rows = await db
    .select()
    .from(connectedAccountsTable)
    .where(eq(connectedAccountsTable.workspaceId, ctx.workspaceId))
    .orderBy(asc(connectedAccountsTable.platform), asc(connectedAccountsTable.createdAt));
  res.json(ListConnectedAccountsResponse.parse({ accounts: rows.map(serializeAccount) }));
});

// ---------------------------------------------------------------------------
// Pending connections (account selection after the OAuth callback).
// Registered before /connections/:platform/* so "pending" isn't read as a platform.
// ---------------------------------------------------------------------------

async function loadPending(req: Request, res: Response, pendingId: string) {
  const ctx = await resolveWorkspace(req, res);
  if (!ctx || !can(ctx.role, "accounts:manage")) return null;
  const [pending] = await db
    .select()
    .from(pendingConnectionsTable)
    .where(
      and(
        eq(pendingConnectionsTable.id, pendingId),
        eq(pendingConnectionsTable.workspaceId, ctx.workspaceId),
        gt(pendingConnectionsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return pending ? { ctx, pending } : null;
}

router.get("/connections/pending/:pendingId", async (req, res): Promise<void> => {
  const params = GetPendingConnectionParams.safeParse(req.params);
  if (!params.success) return jsonError(res, 404, "not_found", "Pending connection not found.");
  const authed = await resolveUser(req);
  if (!authed) return jsonError(res, 401, "unauthorized", "Sign in to continue.");
  const loaded = await loadPending(req, res, params.data.pendingId);
  if (!loaded) return jsonError(res, 404, "not_found", "This selection expired. Start the connection again.");

  const { ctx, pending } = loaded;
  const existing = await db
    .select({ externalAccountId: connectedAccountsTable.externalAccountId })
    .from(connectedAccountsTable)
    .where(
      and(
        eq(connectedAccountsTable.workspaceId, ctx.workspaceId),
        eq(connectedAccountsTable.platform, pending.platform),
      ),
    );
  const connectedIds = new Set(existing.map((row) => row.externalAccountId));
  res.json(
    GetPendingConnectionResponse.parse({
      id: pending.id,
      platform: pending.platform,
      expiresAt: pending.expiresAt,
      candidates: pending.candidates.map((c) => ({ ...c, alreadyConnected: connectedIds.has(c.externalAccountId) })),
    }),
  );
});

router.post("/connections/pending/:pendingId/complete", async (req, res): Promise<void> => {
  const params = CompletePendingConnectionParams.safeParse(req.params);
  if (!params.success) return jsonError(res, 404, "not_found", "Pending connection not found.");
  const body = CompletePendingConnectionBody.safeParse(req.body);
  if (!body.success) return jsonError(res, 400, "invalid_selection", "Select at least one account.");
  const authed = await resolveUser(req);
  if (!authed) return jsonError(res, 401, "unauthorized", "Sign in to continue.");

  const loaded = await loadPending(req, res, params.data.pendingId);
  if (!loaded) return jsonError(res, 404, "not_found", "This selection expired. Start the connection again.");
  const { ctx, pending } = loaded;

  const payload = JSON.parse(
    decryptSecret(pending.payloadEncrypted, pendingAad(pending.id, ctx.workspaceId)),
  ) as PendingPayload;
  const candidates = decodePendingCandidates(payload);
  const selectedIds = [...new Set(body.data.externalAccountIds)];
  const selected = selectedIds.map((id) => candidates.find((c) => c.externalAccountId === id));
  if (selected.some((c) => !c || !c.selectable)) {
    return jsonError(res, 400, "invalid_selection", "One or more selected accounts can't be connected.");
  }

  const platform = pending.platform as Platform;
  const saved = await db.transaction(async (tx) => {
    const rows = [];
    for (const candidate of selected as AccountCandidate[]) {
      rows.push(await saveConnectedAccount(tx, ctx.workspaceId, platform, candidate, payload.externalUserId));
    }
    await tx.delete(pendingConnectionsTable).where(eq(pendingConnectionsTable.id, pending.id));
    return rows;
  });

  req.log.info({ platform, count: saved.length }, "Connected social accounts");
  res.json(CompletePendingConnectionResponse.parse({ accounts: saved.map(serializeAccount) }));
});

router.delete("/connections/pending/:pendingId", async (req, res): Promise<void> => {
  const params = CancelPendingConnectionParams.safeParse(req.params);
  const ctx = await resolveWorkspace(req, res);
  if (params.success && ctx) {
    await db
      .delete(pendingConnectionsTable)
      .where(
        and(
          eq(pendingConnectionsTable.id, params.data.pendingId),
          eq(pendingConnectionsTable.workspaceId, ctx.workspaceId),
        ),
      );
  }
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// OAuth start / callback (browser navigations)
// ---------------------------------------------------------------------------

router.get("/connections/:platform/start", async (req, res): Promise<void> => {
  const platform = req.params.platform;
  if (!isPlatform(platform)) return jsonError(res, 404, "not_found", "Unknown platform.");

  let adapter;
  try {
    adapter = getAdapter(platform);
  } catch (error) {
    req.log.warn({ platform, reason: (error as Error).message }, "OAuth start refused: not configured");
    return redirectWithError(res, platform, "not_configured");
  }

  const ctx = await resolveWorkspace(req, res);
  if (!ctx) {
    // Not signed in: send the browser to sign-in, remembering this exact
    // start URL so the connect flow resumes automatically after login.
    const next = `/api/connections/${platform}/start${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
    res.redirect(302, `${SIGNIN_PATH}?${new URLSearchParams({ next }).toString()}`);
    return;
  }
  if (!can(ctx.role, "accounts:manage")) {
    workspaceRedirect(res, { error: "forbidden", platform });
    return;
  }

  let reconnectAccountId: string | null = null;
  const reconnect = queryString(req.query.reconnect);
  if (reconnect) {
    const account = /^[0-9a-f-]{36}$/i.test(reconnect) ? await findAccount(ctx.workspaceId, reconnect) : null;
    if (!account || account.platform !== platform) {
      return redirectWithError(res, platform, "invalid_callback");
    }
    reconnectAccountId = account.id;
  }

  const state = randomToken(32);
  const stateHash = sha256(state);
  let codeChallenge: string | undefined;
  let codeVerifierEncrypted: string | null = null;
  if (adapter.usesPkce) {
    const verifier = randomBytes(48).toString("base64url");
    codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    codeVerifierEncrypted = encryptSecret(verifier, `oauth-state:${stateHash}`);
  }

  await purgeExpired();
  await db.insert(oauthStatesTable).values({
    stateHash,
    sessionId: ctx.sessionId,
    workspaceId: ctx.workspaceId,
    platform,
    reconnectAccountId,
    codeVerifierEncrypted,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });

  res.redirect(
    302,
    adapter.buildAuthorizationUrl({
      state,
      redirectUri: getCallbackUrl(platform)!,
      codeChallenge,
      reconnect: reconnectAccountId !== null,
    }),
  );
});

router.get("/connections/:platform/callback", async (req, res): Promise<void> => {
  const platform = req.params.platform;
  if (!isPlatform(platform)) return jsonError(res, 404, "not_found", "Unknown platform.");

  const state = queryString(req.query.state);
  const code = queryString(req.query.code);
  const providerError = queryString(req.query.error);

  try {
    // Consume the state first (single use), even if the provider reports an error.
    const [oauthState] = state
      ? await db
          .delete(oauthStatesTable)
          .where(
            and(
              eq(oauthStatesTable.stateHash, sha256(state)),
              eq(oauthStatesTable.platform, platform),
              gt(oauthStatesTable.expiresAt, new Date()),
            ),
          )
          .returning()
      : [];

    if (providerError) {
      req.log.info(
        { platform, error: providerError, reason: queryString(req.query.error_reason) },
        "Provider returned an OAuth error",
      );
      throw new OAuthError(providerError === "access_denied" ? "access_denied" : "provider_error");
    }
    if (!oauthState) throw new OAuthError("invalid_state");

    // The state must belong to the same browser session that started the flow.
    const ctx = await resolveWorkspace(req, res);
    if (!ctx || ctx.sessionId !== oauthState.sessionId || ctx.workspaceId !== oauthState.workspaceId) {
      throw new OAuthError("invalid_state");
    }
    if (!code) throw new OAuthError("invalid_callback");

    const adapter = getAdapter(platform);
    const codeVerifier = oauthState.codeVerifierEncrypted
      ? decryptSecret(oauthState.codeVerifierEncrypted, `oauth-state:${oauthState.stateHash}`)
      : undefined;
    const result = await adapter.handleCallback({
      code,
      redirectUri: getCallbackUrl(platform)!,
      codeVerifier,
    });

    // Reconnect: refresh the tokens of the existing account directly.
    if (oauthState.reconnectAccountId) {
      const existing = await findAccount(ctx.workspaceId, oauthState.reconnectAccountId);
      if (existing) {
        const candidate = result.candidates.find((c) => c.externalAccountId === existing.externalAccountId);
        if (!candidate) throw new OAuthError("account_not_granted");
        await saveConnectedAccount(db, ctx.workspaceId, platform, candidate, result.externalUserId);
        req.log.info({ platform }, "Reconnected social account");
        return workspaceRedirect(res, { connected: platform, reconnected: "1" });
      }
    }

    const pendingId = randomUUID();
    const payload: PendingPayload = {
      externalUserId: result.externalUserId,
      candidates: result.candidates.map((c) => ({
        ...c,
        tokenExpiresAt: c.tokenExpiresAt?.toISOString() ?? null,
        refreshTokenExpiresAt: c.refreshTokenExpiresAt?.toISOString() ?? null,
      })),
    };
    const summaries: PendingCandidateSummary[] = result.candidates.map((c) => ({
      externalAccountId: c.externalAccountId,
      accountType: c.accountType,
      displayName: c.displayName,
      username: c.username,
      avatarUrl: c.avatarUrl,
      selectable: c.selectable,
      warnings: c.warnings,
    }));
    await db.insert(pendingConnectionsTable).values({
      id: pendingId,
      workspaceId: ctx.workspaceId,
      platform,
      payloadEncrypted: encryptSecret(JSON.stringify(payload), pendingAad(pendingId, ctx.workspaceId)),
      candidates: summaries,
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    });
    workspaceRedirect(res, { pending: pendingId, platform });
  } catch (error) {
    if (error instanceof OAuthError) {
      req.log.warn(
        { platform, code: error.code, providerMessage: error.details.providerMessage },
        "OAuth callback failed",
      );
      return redirectWithError(res, platform, error);
    }
    req.log.error({ platform, err: error }, "Unexpected OAuth callback failure");
    redirectWithError(res, platform, "provider_error");
  }
});

// ---------------------------------------------------------------------------
// Verify / disconnect
// ---------------------------------------------------------------------------

router.post("/connections/:accountId/verify", async (req, res): Promise<void> => {
  const params = VerifyConnectedAccountParams.safeParse(req.params);
  if (!params.success) return jsonError(res, 404, "not_found", "Account not found.");
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const account = await findAccount(ctx.workspaceId, params.data.accountId);
  if (!account) return jsonError(res, 404, "not_found", "Account not found.");

  let adapter;
  try {
    adapter = getAdapter(account.platform as Platform);
  } catch (error) {
    return jsonError(res, 503, "not_configured", (error as Error).message);
  }
  const updated = await verifyConnectedAccount(account, adapter);
  res.json(VerifyConnectedAccountResponse.parse(serializeAccount(updated)));
});

router.delete("/connections/:accountId", async (req, res): Promise<void> => {
  const params = DisconnectAccountParams.safeParse(req.params);
  if (!params.success) return jsonError(res, 404, "not_found", "Account not found.");
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;

  // Deleting the row removes the encrypted tokens. We intentionally don't call
  // the provider's revoke endpoint: for Meta that revokes the app for the
  // whole Facebook user, which would break their other connected Pages.
  const deleted = await db
    .delete(connectedAccountsTable)
    .where(
      and(
        eq(connectedAccountsTable.id, params.data.accountId),
        eq(connectedAccountsTable.workspaceId, ctx.workspaceId),
      ),
    )
    .returning({ id: connectedAccountsTable.id, platform: connectedAccountsTable.platform });
  if (deleted.length === 0) return jsonError(res, 404, "not_found", "Account not found.");
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "account.disconnected", target: deleted[0]!.platform });
  req.log.info({ platform: deleted[0]!.platform }, "Disconnected social account");
  res.sendStatus(204);
});

export default router;
