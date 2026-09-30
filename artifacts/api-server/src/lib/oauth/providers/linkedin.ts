import { openAsBlob } from "node:fs";
import { fetchPublicImage } from "../../link-preview";
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
  PublishCommentInput,
  PublishCommentResult,
  PublishInput,
  PublishResult,
  RefreshedTokens,
  StoredAccountCredentials,
  VerificationResult,
} from "../types";

// LinkedIn OAuth 2.0 (3-legged, confidential client — no PKCE) + the
// LinkedIn REST API. Docs:
//   https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
//   https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
//   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role
//   https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens

export const LINKEDIN_REQUIRED_SCOPES = ["openid", "profile", "w_member_social"];
// Organization scopes require LinkedIn's Community Management API, which is
// granted only after a separate access request and review. They are only
// added to the authorization request when LINKEDIN_ORG_ENABLED is set, so an
// app without that access never asks for permissions it can't use.
export const LINKEDIN_ORG_SCOPES = ["r_organization_social", "w_organization_social", "rw_organization_admin"];
export const LINKEDIN_OPTIONAL_SCOPES = LINKEDIN_ORG_SCOPES;

const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const REST_HOST = "https://api.linkedin.com/rest";
const UGC_POSTS_URL = "https://api.linkedin.com/v2/ugcPosts";
const REGISTER_UPLOAD_URL = "https://api.linkedin.com/v2/assets?action=registerUpload";
const IMAGES_INIT_URL = `${REST_HOST}/images?action=initializeUpload`;
const POSTS_URL = `${REST_HOST}/posts`;
const UPLOAD_TIMEOUT_MS = 8 * 60_000;
const LINK_THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;

function orgDiscoveryEnabled(): boolean {
  return /^(1|true)$/i.test(process.env.LINKEDIN_ORG_ENABLED?.trim() ?? "");
}

/** LinkedIn-Version header for the versioned /rest/ API (YYYYMM). Required
 * only for organization endpoints; the member flow (userinfo, token
 * exchange) doesn't use it. Not hardcoded, since LinkedIn's valid version
 * values change over time and must match what the app was reviewed against. */
function linkedinApiVersion(): string | null {
  const version = process.env.LINKEDIN_API_VERSION?.trim();
  return version && /^\d{6}$/.test(version) ? version : null;
}

type LinkedInError = { message?: string; status?: number; serviceErrorCode?: number };

function linkedinError(body: unknown): LinkedInError | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.error === "string") {
    return { message: (b.error_description as string) ?? (b.error as string) };
  }
  if (typeof b.message === "string") {
    return { message: b.message, status: b.status as number | undefined, serviceErrorCode: b.serviceErrorCode as number | undefined };
  }
  return null;
}

export function mapLinkedInError(error: unknown, fallback: OAuthError["code"] = "provider_error"): OAuthError {
  if (error instanceof OAuthError) return error;
  const body = error instanceof ProviderHttpError ? error.body : null;
  const status = error instanceof ProviderHttpError ? error.status : undefined;
  const le = linkedinError(body);
  const providerMessage = le?.message;
  // serviceErrorCode 65601 = the access token has expired; anything else on a 401 means it is invalid/revoked.
  if (status === 401) return new OAuthError(le?.serviceErrorCode === 65601 ? "token_expired" : "token_revoked", undefined, { providerMessage });
  if (status === 403) return new OAuthError("insufficient_permissions", undefined, { providerMessage });
  if (status === 429) return new OAuthError("rate_limited", undefined, { providerMessage });
  return new OAuthError(fallback, undefined, { providerMessage });
}

function restHeaders(accessToken: string, version: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "x-restli-protocol-version": "2.0.0",
    "linkedin-version": version,
  };
}

/**
 * Uploads image bytes through the versioned Images API and returns the resulting `urn:li:image:...`. This is the
 * only LinkedIn API where a client can supply the picture for a link (article) share's card — see the comment on
 * the ARTICLE branch of publishPost for why the older UGC Posts API can't do this.
 */
async function uploadLinkedInImage(accessToken: string, version: string, owner: string, bytes: Buffer, mimeType: string): Promise<string> {
  const registered = await requestJson(IMAGES_INIT_URL, {
    method: "POST",
    headers: { ...restHeaders(accessToken, version), "content-type": "application/json" },
    body: JSON.stringify({ initializeUploadRequest: { owner } }),
  });
  const value = field(registered, "value");
  const uploadUrl = stringField(value, "uploadUrl");
  const image = stringField(value, "image");
  if (!uploadUrl || !image) throw new Error("LinkedIn didn't return an upload address for the image.");
  await requestJson(uploadUrl, {
    method: "PUT",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": mimeType },
    body: new Blob([new Uint8Array(bytes)], { type: mimeType }),
  }, { timeoutMs: UPLOAD_TIMEOUT_MS });
  return image;
}

/**
 * POSTs to the versioned Posts API. Unlike the older `/v2/ugcPosts`, a successful `/rest/posts` call returns an
 * empty body — the new post's id comes back in the `x-restli-id` response header — so this can't go through
 * requestJson (which only ever returns the parsed body).
 */
async function postVersioned(accessToken: string, version: string, body: unknown): Promise<string> {
  const response = await fetch(POSTS_URL, {
    method: "POST",
    headers: { ...restHeaders(accessToken, version), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 500) }; }
    throw new ProviderHttpError(response.status, parsed);
  }
  const id = response.headers.get("x-restli-id");
  if (!id) throw new Error("LinkedIn accepted the request but returned no post ID.");
  return id;
}

export function createLinkedInAdapter(credentials: ProviderCredentials): OAuthProviderAdapter {
  const orgEnabled = orgDiscoveryEnabled();

  async function exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; expiresAt: Date; refreshToken: string | null; refreshExpiresAt: Date | null; scope: string[] }> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    });
    let response: unknown;
    try {
      response = await requestJson(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    } catch (error) {
      throw mapLinkedInError(error, "token_exchange_failed");
    }
    const accessToken = stringField(response, "access_token");
    const expiresIn = numberField(response, "expires_in");
    if (!accessToken || !expiresIn) throw new OAuthError("token_exchange_failed");
    const refreshToken = stringField(response, "refresh_token");
    const refreshExpiresIn = numberField(response, "refresh_token_expires_in");
    const scopeRaw = stringField(response, "scope") ?? "";
    return {
      accessToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      refreshToken,
      refreshExpiresAt: refreshToken && refreshExpiresIn ? new Date(Date.now() + refreshExpiresIn * 1000) : null,
      scope: scopeRaw.split(/[\s,]+/).filter(Boolean),
    };
  }

  async function fetchUserinfo(accessToken: string): Promise<{ sub: string; name: string | null; picture: string | null }> {
    const body = await requestJson(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    const sub = stringField(body, "sub");
    if (!sub) throw new OAuthError("invalid_callback");
    return { sub, name: stringField(body, "name"), picture: stringField(body, "picture") };
  }

  /** Organizations the member administers. Best-effort: if the app doesn't
   * actually have Community Management API access, LinkedIn returns 403 and
   * this returns an empty list rather than failing the whole connection. */
  async function discoverAdministeredOrganizations(accessToken: string): Promise<AccountCandidate[]> {
    const version = linkedinApiVersion();
    if (!version) return [];
    try {
      const url = new URL(`${REST_HOST}/organizationAcls`);
      url.searchParams.set("q", "roleAssignee");
      url.searchParams.set("role", "ADMINISTRATOR");
      url.searchParams.set("state", "APPROVED");
      const body = await requestJson(url, { headers: restHeaders(accessToken, version) });
      const elements = field<Array<{ organization?: string }>>(body, "elements") ?? [];
      const candidates: AccountCandidate[] = [];
      for (const el of elements) {
        const urn = el.organization;
        const id = urn?.match(/urn:li:organization:(\d+)/)?.[1];
        if (!id) continue;
        let displayName = `Organization ${id}`;
        try {
          const orgUrl = new URL(`${REST_HOST}/organizations/${id}`);
          orgUrl.searchParams.set("fields", "localizedName,vanityName");
          const org = await requestJson(orgUrl, { headers: restHeaders(accessToken, version) });
          displayName = stringField(org, "localizedName") ?? stringField(org, "vanityName") ?? displayName;
        } catch {
          // Name lookup is best-effort; the organization is still connectable by ID.
        }
        candidates.push({
          externalAccountId: id,
          accountType: "linkedin_organization",
          displayName,
          username: null,
          avatarUrl: null,
          accessToken,
          refreshToken: null,
          tokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          scopes: LINKEDIN_ORG_SCOPES,
          metadata: { organizationUrn: urn },
          selectable: true,
          warnings: [],
        });
      }
      return candidates;
    } catch {
      // No Community Management API access (or a transient error): the
      // member connection still works, just without organization pages.
      return [];
    }
  }

  return {
    platform: "linkedin",
    displayName: "LinkedIn",
    requiredEnv: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    requiredScopes: LINKEDIN_REQUIRED_SCOPES,
    optionalScopes: LINKEDIN_OPTIONAL_SCOPES,
    usesPkce: false,

    buildAuthorizationUrl({ state, redirectUri }) {
      const scopes = orgEnabled ? [...LINKEDIN_REQUIRED_SCOPES, ...LINKEDIN_ORG_SCOPES] : LINKEDIN_REQUIRED_SCOPES;
      const url = new URL(AUTH_URL);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", credentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("scope", scopes.join(" "));
      return url.toString();
    },

    async handleCallback({ code, redirectUri }) {
      const token = await exchangeCode(code, redirectUri);

      const missing = LINKEDIN_REQUIRED_SCOPES.filter((s) => !token.scope.includes(s));
      if (missing.length > 0) {
        throw new OAuthError("missing_scopes", `Missing required LinkedIn permissions: ${missing.join(", ")}`, { missingScopes: missing });
      }

      try {
        const profile = await fetchUserinfo(token.accessToken);
        const memberCandidate: AccountCandidate = {
          externalAccountId: profile.sub,
          accountType: "linkedin_member",
          displayName: profile.name ?? "LinkedIn member",
          username: null,
          avatarUrl: profile.picture,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          tokenExpiresAt: token.expiresAt,
          refreshTokenExpiresAt: token.refreshExpiresAt,
          scopes: token.scope,
          metadata: {},
          selectable: true,
          warnings: [],
        };

        const orgCandidates =
          orgEnabled && LINKEDIN_ORG_SCOPES.some((s) => token.scope.includes(s))
            ? await discoverAdministeredOrganizations(token.accessToken)
            : [];

        return { externalUserId: profile.sub, grantedScopes: token.scope, candidates: [memberCandidate, ...orgCandidates] };
      } catch (error) {
        throw mapLinkedInError(error);
      }
    },

    async refreshAccessToken(refreshToken: string): Promise<RefreshedTokens> {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      });
      let response: unknown;
      try {
        response = await requestJson(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
      } catch (error) {
        throw mapLinkedInError(error);
      }
      const accessToken = stringField(response, "access_token");
      const expiresIn = numberField(response, "expires_in");
      if (!accessToken || !expiresIn) throw new OAuthError("provider_error");
      const newRefreshToken = stringField(response, "refresh_token") ?? refreshToken;
      const refreshExpiresIn = numberField(response, "refresh_token_expires_in");
      return {
        accessToken,
        refreshToken: newRefreshToken,
        tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        refreshTokenExpiresAt: refreshExpiresIn ? new Date(Date.now() + refreshExpiresIn * 1000) : null,
      };
    },

    /**
     * Publishes a public text post as the member, or as the organization for
     * an organization account. Uses the UGC Posts API that Share on LinkedIn
     * grants (w_member_social); organizations additionally need
     * w_organization_social (Community Management API access).
     */
    async publishPost(account: StoredAccountCredentials, input: PublishInput): Promise<PublishResult> {
      const author = account.accountType === "linkedin_organization"
        ? `urn:li:organization:${account.externalAccountId}`
        : `urn:li:person:${account.externalAccountId}`;
      const files = input.media ?? [];
      const isVideo = files.some((item) => item.kind === "video");
      const jsonHeaders = { authorization: `Bearer ${account.accessToken}`, "content-type": "application/json", "x-restli-protocol-version": "2.0.0" };

      // Media goes up in two steps per file: register an upload (LinkedIn returns an upload URL and an asset ID),
      // then send the bytes to that URL. The post then references the asset IDs.
      const assets: string[] = [];
      try {
        for (const item of files) {
          const registered = await requestJson(REGISTER_UPLOAD_URL, {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({
              registerUploadRequest: {
                recipes: [item.kind === "video" ? "urn:li:digitalmediaRecipe:feedshare-video" : "urn:li:digitalmediaRecipe:feedshare-image"],
                owner: author,
                serviceRelationships: [{ relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" }],
              },
            }),
          });
          const value = field(registered, "value");
          const uploadUrl = stringField(field(field(value, "uploadMechanism"), "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"), "uploadUrl");
          const asset = stringField(value, "asset");
          if (!uploadUrl || !asset) throw new OAuthError("publish_failed", undefined, { providerMessage: "LinkedIn didn't return an upload address for the media." });
          await requestJson(uploadUrl, {
            method: "PUT",
            headers: { authorization: `Bearer ${account.accessToken}`, "content-type": item.mimeType },
            body: await openAsBlob(item.filePath, { type: item.mimeType }),
          }, { timeoutMs: UPLOAD_TIMEOUT_MS });
          assets.push(asset);
        }
      } catch (error) {
        throw mapLinkedInError(error, "publish_failed");
      }

      // A link with no media becomes an article share: LinkedIn shows a card that opens the link. The text is sent
      // exactly as written.
      const link = files.length === 0 ? input.link : null;
      const version = linkedinApiVersion();
      let notice: string | undefined;

      // The card's picture: only the versioned Posts API + Images API lets a client set it (content.article.thumbnail,
      // an uploaded urn:li:image:...). The older UGC Posts API used below as a fallback has no such field — a
      // "thumbnails" entry sent there is silently ignored, because it isn't a documented request field; LinkedIn
      // instead crawls `originalUrl` itself and can take a moment to fill the card in, same as Facebook.
      // LINKEDIN_API_VERSION opts an app into the versioned API, so this path only runs when it's configured.
      if (link && version) {
        try {
          let thumbnail: string | undefined;
          if (link.imageUrl) {
            try {
              const image = await fetchPublicImage(link.imageUrl, LINK_THUMBNAIL_MAX_BYTES);
              thumbnail = await uploadLinkedInImage(account.accessToken, version, author, image.bytes, image.mimeType);
            } catch (error) {
              if (error instanceof ProviderHttpError && [401, 403, 429].includes(error.status)) throw error;
              notice = "The link card was posted without its image (the picture couldn't be uploaded to LinkedIn).";
            }
          }
          const externalPostId = await postVersioned(account.accessToken, version, {
            author,
            commentary: input.text,
            visibility: "PUBLIC",
            distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
            content: {
              article: {
                source: link.url,
                ...(link.title ? { title: link.title } : {}),
                ...(link.description ? { description: link.description } : {}),
                ...(thumbnail ? { thumbnail } : {}),
              },
            },
            lifecycleState: "PUBLISHED",
            isReshareDisabledByAuthor: false,
          });
          return notice ? { externalPostId, notice } : { externalPostId };
        } catch (error) {
          // The versioned API call itself failed (not just the thumbnail upload): fall through to the classic
          // article share below, so a post still goes out rather than failing outright.
          if (error instanceof ProviderHttpError && [401, 403, 429].includes(error.status)) throw mapLinkedInError(error, "publish_failed");
          notice = "The link card was posted without its image.";
        }
      }

      const body = JSON.stringify({
        author,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: input.text },
            shareMediaCategory: link ? "ARTICLE" : assets.length === 0 ? "NONE" : isVideo ? "VIDEO" : "IMAGE",
            ...(link
              ? {
                  media: [{
                    status: "READY",
                    originalUrl: link.url,
                    ...(link.title ? { title: { text: link.title } } : {}),
                    ...(link.description ? { description: { text: link.description } } : {}),
                  }],
                }
              : assets.length > 0 ? { media: assets.map((asset) => ({ status: "READY", media: asset })) } : {}),
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      });
      let response: unknown;
      try {
        response = await requestJson(UGC_POSTS_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${account.accessToken}`,
            "content-type": "application/json",
            "x-restli-protocol-version": "2.0.0",
          },
          body,
        });
      } catch (error) {
        throw mapLinkedInError(error, "publish_failed");
      }
      const externalPostId = stringField(response, "id");
      if (!externalPostId) throw new OAuthError("publish_failed", undefined, { providerMessage: "LinkedIn accepted the request but returned no post ID." });
      return link && notice ? { externalPostId, notice } : { externalPostId };
    },

    /** Comments under the member's (or organization's) own post via the Social Actions API. */
    async publishComment(account: StoredAccountCredentials, input: PublishCommentInput): Promise<PublishCommentResult> {
      const actor = account.accountType === "linkedin_organization" ? `urn:li:organization:${account.externalAccountId}` : `urn:li:person:${account.externalAccountId}`;
      let response: unknown;
      try {
        response = await requestJson(`https://api.linkedin.com/v2/socialActions/${encodeURIComponent(input.externalPostId)}/comments`, {
          method: "POST",
          headers: { authorization: `Bearer ${account.accessToken}`, "content-type": "application/json", "x-restli-protocol-version": "2.0.0" },
          body: JSON.stringify({ actor, message: { text: input.text } }),
        });
      } catch (error) {
        throw mapLinkedInError(error, "publish_failed");
      }
      return { externalCommentId: stringField(response, "id") ?? stringField(response, "$URN") ?? "" };
    },

    async verifyAccount(account: StoredAccountCredentials): Promise<VerificationResult> {
      if (account.accountType === "linkedin_organization") {
        const version = linkedinApiVersion();
        if (!version) {
          return { status: "error", detail: "LINKEDIN_API_VERSION is not configured; organization access can't be re-checked." };
        }
        try {
          const url = new URL(`${REST_HOST}/organizationAcls`);
          url.searchParams.set("q", "organization");
          url.searchParams.set("organization", `urn:li:organization:${account.externalAccountId}`);
          url.searchParams.set("role", "ADMINISTRATOR");
          url.searchParams.set("state", "APPROVED");
          const body = await requestJson(url, { headers: restHeaders(account.accessToken, version) });
          const elements = field<unknown[]>(body, "elements") ?? [];
          if (elements.length === 0) {
            return { status: "missing_permissions", detail: "You're no longer an administrator of this LinkedIn organization." };
          }
          let displayName: string | undefined;
          try {
            const orgUrl = new URL(`${REST_HOST}/organizations/${account.externalAccountId}`);
            orgUrl.searchParams.set("fields", "localizedName,vanityName");
            const org = await requestJson(orgUrl, { headers: restHeaders(account.accessToken, version) });
            displayName = stringField(org, "localizedName") ?? stringField(org, "vanityName") ?? undefined;
          } catch {
            // Name refresh is best-effort; access is already confirmed above.
          }
          return { status: "active", detail: null, displayName };
        } catch (error) {
          const mapped = mapLinkedInError(error);
          const status =
            mapped.code === "token_revoked" ? "revoked"
            : mapped.code === "insufficient_permissions" ? "missing_permissions"
            : "error";
          return { status, detail: mapped.details.providerMessage ?? mapped.message };
        }
      }

      try {
        const profile = await fetchUserinfo(account.accessToken);
        return { status: "active", detail: null, displayName: profile.name ?? undefined, avatarUrl: profile.picture };
      } catch (error) {
        const mapped = mapLinkedInError(error);
        const status =
          mapped.code === "token_expired" ? "expired"
          : mapped.code === "token_revoked" ? "revoked"
          : mapped.code === "insufficient_permissions" ? "missing_permissions"
          : "error";
        return { status, detail: mapped.details.providerMessage ?? mapped.message };
      }
    },
  };
}

export const linkedinProvider: ProviderDefinition = {
  platform: "linkedin",
  displayName: "LinkedIn",
  requiredEnv: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
  requiredScopes: LINKEDIN_REQUIRED_SCOPES,
  optionalScopes: LINKEDIN_OPTIONAL_SCOPES,
  implemented: true,
  create: createLinkedInAdapter,
};
