import { createHmac } from "node:crypto";
import { OAuthError } from "../errors";
import {
  ProviderHttpError,
  field,
  numberField,
  requestJson,
  stringField,
} from "../http";
import type {
  AccountCandidate,
  OAuthProviderAdapter,
  ProviderCredentials,
  ProviderDefinition,
  StoredAccountCredentials,
  VerificationResult,
} from "../types";

// Facebook Login + Graph API, connecting Facebook Pages.
// Docs:
//   https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
//   https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
//   https://developers.facebook.com/docs/pages-api/getting-started
//   https://developers.facebook.com/docs/graph-api/securing-requests (appsecret_proof)
//   https://developers.facebook.com/docs/graph-api/guides/error-handling

export const FACEBOOK_REQUIRED_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
];
// Needed when Pages are owned through a Business Portfolio; without it
// /me/accounts can come back empty for those Pages.
export const FACEBOOK_OPTIONAL_SCOPES = ["business_management"];

// Page tasks that allow publishing content.
const PUBLISH_TASKS = ["CREATE_CONTENT", "MANAGE"];
const MAX_PAGE_REQUESTS = 20;

export function graphApiVersion(): string {
  const configured = process.env.FACEBOOK_GRAPH_API_VERSION?.trim();
  return configured && /^v\d+\.\d+$/.test(configured) ? configured : "v26.0";
}

type GraphError = { code?: number; error_subcode?: number; message?: string; type?: string };

function graphError(body: unknown): GraphError | null {
  const error = field<GraphError>(body, "error");
  return error && typeof error === "object" ? error : null;
}

/** Maps a Graph API error to an OAuthError. */
export function mapGraphError(error: unknown, fallback: OAuthError["code"] = "provider_error"): OAuthError {
  if (error instanceof OAuthError) return error;
  const body = error instanceof ProviderHttpError ? error.body : null;
  const g = graphError(body);
  const providerMessage = g?.message;
  if (g?.code === 190) {
    // 463 = expired; 458/460/467/492 etc. = revoked, password change, invalid.
    return new OAuthError(g.error_subcode === 463 ? "token_expired" : "token_revoked", undefined, { providerMessage });
  }
  if (g?.code === 10 || (g?.code !== undefined && g.code >= 200 && g.code < 300)) {
    return new OAuthError("insufficient_permissions", undefined, { providerMessage });
  }
  if (g?.code !== undefined && [4, 17, 32, 613].includes(g.code)) {
    return new OAuthError("rate_limited", undefined, { providerMessage });
  }
  return new OAuthError(fallback, undefined, { providerMessage });
}

export function createFacebookAdapter(credentials: ProviderCredentials): OAuthProviderAdapter {
  const version = graphApiVersion();
  const graph = `https://graph.facebook.com/${version}`;
  const loginConfigId = process.env.FACEBOOK_LOGIN_CONFIG_ID?.trim();

  const appSecretProof = (accessToken: string) =>
    createHmac("sha256", credentials.clientSecret).update(accessToken).digest("hex");

  function graphUrl(path: string, accessToken: string, params: Record<string, string> = {}): URL {
    const url = new URL(path.startsWith("http") ? path : `${graph}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("appsecret_proof", appSecretProof(accessToken));
    return url;
  }

  async function exchangeCode(code: string, redirectUri: string): Promise<string> {
    const url = new URL(`${graph}/oauth/access_token`);
    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("client_secret", credentials.clientSecret);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code", code);
    let body: unknown;
    try {
      body = await requestJson(url);
    } catch (error) {
      throw mapGraphError(error, "token_exchange_failed");
    }
    const token = stringField(body, "access_token");
    if (!token) throw new OAuthError("token_exchange_failed");
    return token;
  }

  async function exchangeForLongLived(shortLived: string): Promise<string> {
    const url = new URL(`${graph}/oauth/access_token`);
    url.searchParams.set("grant_type", "fb_exchange_token");
    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("client_secret", credentials.clientSecret);
    url.searchParams.set("fb_exchange_token", shortLived);
    let body: unknown;
    try {
      body = await requestJson(url);
    } catch (error) {
      throw mapGraphError(error, "token_exchange_failed");
    }
    const token = stringField(body, "access_token");
    if (!token) throw new OAuthError("token_exchange_failed");
    return token;
  }

  async function grantedPermissions(userToken: string): Promise<{ granted: string[]; declined: string[] }> {
    const body = await requestJson(graphUrl("/me/permissions", userToken));
    const data = field<Array<{ permission?: string; status?: string }>>(body, "data") ?? [];
    return {
      granted: data.filter((p) => p.status === "granted" && p.permission).map((p) => p.permission!),
      declined: data.filter((p) => p.status === "declined" && p.permission).map((p) => p.permission!),
    };
  }

  async function listPages(userToken: string): Promise<unknown[]> {
    const pages: unknown[] = [];
    let next: string | null = graphUrl("/me/accounts", userToken, {
      fields: "id,name,access_token,tasks,category,picture{url}",
      limit: "100",
    }).toString();
    for (let i = 0; next && i < MAX_PAGE_REQUESTS; i++) {
      const body = await requestJson(next);
      pages.push(...(field<unknown[]>(body, "data") ?? []));
      const nextUrl = stringField(field(body, "paging"), "next");
      // Paging URLs already carry the access token; re-sign to be safe.
      next = nextUrl ? graphUrl(nextUrl, userToken).toString() : null;
    }
    return pages;
  }

  return {
    platform: "facebook",
    displayName: "Facebook Pages",
    requiredEnv: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
    requiredScopes: FACEBOOK_REQUIRED_SCOPES,
    optionalScopes: FACEBOOK_OPTIONAL_SCOPES,
    usesPkce: false,

    buildAuthorizationUrl({ state, redirectUri, reconnect }) {
      const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
      url.searchParams.set("client_id", credentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("response_type", "code");
      if (loginConfigId) {
        // Facebook Login for Business: permissions come from the configuration.
        url.searchParams.set("config_id", loginConfigId);
      } else {
        url.searchParams.set("scope", [...FACEBOOK_REQUIRED_SCOPES, ...FACEBOOK_OPTIONAL_SCOPES].join(","));
      }
      // Re-prompt for permissions the user previously declined.
      if (reconnect) url.searchParams.set("auth_type", "rerequest");
      return url.toString();
    },

    async handleCallback({ code, redirectUri }) {
      const shortLived = await exchangeCode(code, redirectUri);
      // Page tokens derived from a long-lived user token do not expire.
      const userToken = await exchangeForLongLived(shortLived);

      try {
        const me = await requestJson(graphUrl("/me", userToken, { fields: "id,name" }));
        const externalUserId = stringField(me, "id");
        if (!externalUserId) throw new OAuthError("invalid_callback");

        const { granted } = await grantedPermissions(userToken);
        const missing = FACEBOOK_REQUIRED_SCOPES.filter((s) => !granted.includes(s));
        if (missing.length > 0) {
          throw new OAuthError(
            "missing_scopes",
            `Missing required Facebook permissions: ${missing.join(", ")}`,
            { missingScopes: missing },
          );
        }

        const pages = await listPages(userToken);
        const candidates: AccountCandidate[] = [];
        for (const page of pages) {
          const id = stringField(page, "id");
          const name = stringField(page, "name");
          const accessToken = stringField(page, "access_token");
          if (!id || !name || !accessToken) continue;
          const tasks = field<string[]>(page, "tasks");
          const canPublish = !Array.isArray(tasks) || tasks.some((t) => PUBLISH_TASKS.includes(t));
          candidates.push({
            externalAccountId: id,
            accountType: "facebook_page",
            displayName: name,
            username: null,
            avatarUrl: stringField(field(field(page, "picture"), "data"), "url"),
            accessToken,
            refreshToken: null,
            tokenExpiresAt: null,
            refreshTokenExpiresAt: null,
            scopes: granted,
            metadata: {
              category: stringField(page, "category"),
              tasks: Array.isArray(tasks) ? tasks : null,
            },
            selectable: canPublish,
            warnings: canPublish
              ? []
              : ["Your role on this Page doesn't allow creating content. Ask a Page admin for full control or content access."],
          });
        }

        if (candidates.length === 0) {
          throw new OAuthError(
            "no_accounts",
            "No Facebook Pages were shared with Socialflow. Make sure you manage at least one Page and selected it in the Facebook dialog.",
          );
        }
        return { externalUserId, grantedScopes: granted, candidates };
      } catch (error) {
        throw mapGraphError(error);
      }
    },

    async verifyAccount(account: StoredAccountCredentials): Promise<VerificationResult> {
      const debugUrl = new URL(`${graph}/debug_token`);
      debugUrl.searchParams.set("input_token", account.accessToken);
      debugUrl.searchParams.set("access_token", `${credentials.clientId}|${credentials.clientSecret}`);
      let data: unknown;
      try {
        data = field(await requestJson(debugUrl), "data");
      } catch (error) {
        const mapped = mapGraphError(error);
        return { status: "error", detail: mapped.message };
      }

      if (field(data, "is_valid") !== true) {
        const subcode = numberField(field(data, "error"), "subcode");
        const message = stringField(field(data, "error"), "message");
        return subcode === 463
          ? { status: "expired", detail: message ?? "The Page token has expired." }
          : { status: "revoked", detail: message ?? "The Page token is no longer valid." };
      }

      const scopes = field<string[]>(data, "scopes") ?? [];
      const expiresAt = numberField(data, "expires_at");
      const tokenExpiresAt = expiresAt ? new Date(expiresAt * 1000) : null;
      const missing = FACEBOOK_REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
      if (missing.length > 0) {
        return {
          status: "missing_permissions",
          detail: `Missing permissions: ${missing.join(", ")}`,
          scopes,
          tokenExpiresAt,
        };
      }

      try {
        const page = await requestJson(
          graphUrl(`/${encodeURIComponent(account.externalAccountId)}`, account.accessToken, {
            fields: "id,name,picture{url}",
          }),
        );
        return {
          status: "active",
          detail: null,
          scopes,
          tokenExpiresAt,
          displayName: stringField(page, "name") ?? undefined,
          avatarUrl: stringField(field(field(page, "picture"), "data"), "url"),
        };
      } catch (error) {
        const mapped = mapGraphError(error);
        const status =
          mapped.code === "token_expired" ? "expired"
          : mapped.code === "token_revoked" ? "revoked"
          : mapped.code === "insufficient_permissions" ? "missing_permissions"
          : "error";
        return { status, detail: mapped.details.providerMessage ?? mapped.message, scopes, tokenExpiresAt };
      }
    },
  };
}

export const facebookProvider: ProviderDefinition = {
  platform: "facebook",
  displayName: "Facebook Pages",
  requiredEnv: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
  requiredScopes: FACEBOOK_REQUIRED_SCOPES,
  optionalScopes: FACEBOOK_OPTIONAL_SCOPES,
  implemented: true,
  create: createFacebookAdapter,
};
