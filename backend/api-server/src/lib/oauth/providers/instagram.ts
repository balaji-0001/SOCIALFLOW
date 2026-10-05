import { logger } from "../../logger";
import { analyticsScopesEnabled, commentScopesEnabled, messagingScopesEnabled } from "../config";
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
  MetricsResult,
  PostMetricValues,
  PublishCommentInput,
  PublishCommentResult,
  PublishInput,
  PublishMedia,
  PublishResult,
  RefreshedTokens,
  StoredAccountCredentials,
  VerificationResult,
} from "../types";

// Instagram API with Instagram Login. This is a separate product from
// Facebook Login: it authenticates a single Instagram professional (Business
// or Creator) account directly, with no linked Facebook Page required.
// Docs:
//   https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
//   https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login/get-started
//
// Endpoints and parameter names below were confirmed against current Meta
// documentation. Where the docs did not confirm a detail (e.g. whether
// reconnect can force Instagram to re-prompt for declined permissions, or
// whether a permissions-listing endpoint exists for this product), the code
// does not guess: it omits the feature rather than assume Facebook's Graph
// API behavior carries over.

export const INSTAGRAM_REQUIRED_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
];
// instagram_business_manage_comments lets the account reply under its own posts (first comment). Requested only
// when COMMENT_SCOPES_ENABLED=true.
export const INSTAGRAM_OPTIONAL_SCOPES: string[] = [];
export const INSTAGRAM_COMMENT_SCOPE = "instagram_business_manage_comments";
// Reach, saves, shares and views need this. Requested only when ANALYTICS_SCOPES_ENABLED=true.
export const INSTAGRAM_INSIGHTS_SCOPE = "instagram_business_manage_insights";
// Direct messages. Requested only when MESSAGING_SCOPES_ENABLED=true (needs Meta app review).
export const INSTAGRAM_MESSAGING_SCOPE = "instagram_business_manage_messages";

const AUTH_URL = "https://www.instagram.com/oauth/authorize";
const SHORT_LIVED_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH_HOST = "https://graph.instagram.com";

// Instagram professional account types. PERSONAL accounts cannot use this
// API at all; the Instagram professional-account requirement is enforced by
// checking this field after fetching the profile.
const PROFESSIONAL_ACCOUNT_TYPES = new Set(["BUSINESS", "CREATOR", "MEDIA_CREATOR"]);

// Instagram returns `user_id` as a bare JSON number (both from the token
// exchange and from /me), and Instagram-scoped user IDs are commonly 17
// digits — past Number.MAX_SAFE_INTEGER (16 digits). JSON.parse silently
// rounds such numbers to the nearest representable double, which would
// corrupt the ID rather than just fail to read it. Quoting the value before
// parsing makes it round-trip as an exact string instead.
function preserveUserId(text: string): string {
  return text.replace(/"user_id"\s*:\s*(\d+)/g, '"user_id":"$1"');
}

type GraphError = { code?: number; error_subcode?: number; message?: string; type?: string; error_type?: string };

/** Instagram's two token endpoints use two different error shapes for the
 * same underlying failures: `api.instagram.com/oauth/access_token` (short-
 * lived exchange) returns a flat `{error_type, code, error_message}` body,
 * while `graph.instagram.com/*` (long-lived exchange, refresh, /me) returns
 * Facebook Graph API's nested `{error: {message, type, code}}` shape. Both
 * are normalized here so no caller has to know which endpoint it came from. */
function graphError(body: unknown): GraphError | null {
  const nested = field<GraphError>(body, "error");
  if (nested && typeof nested === "object") return nested;

  const flatMessage = stringField(body, "error_message");
  const flatType = stringField(body, "error_type");
  const flatCode = numberField(body, "code");
  if (flatMessage || flatType || flatCode !== null) {
    return { message: flatMessage ?? undefined, type: flatType ?? undefined, code: flatCode ?? undefined };
  }

  // Unrecognized shape (or a non-JSON body wrapped as {raw: "..."} by
  // requestJson): surface whatever text is there rather than silently
  // dropping it, so failures are diagnosable from the server logs.
  const raw = stringField(body, "raw");
  return raw ? { message: raw } : null;
}

/** Maps an Instagram Graph API error to an OAuthError. Instagram reuses the
 * same OAuthException error family as the Facebook Graph API (code 190). */
export function mapInstagramError(error: unknown, fallback: OAuthError["code"] = "provider_error"): OAuthError {
  if (error instanceof OAuthError) return error;
  const body = error instanceof ProviderHttpError ? error.body : null;
  const g = graphError(body);
  // If the request never got an HTTP response at all (DNS, TLS, timeout,
  // connection reset), fall back to the raw fetch error so a failure still
  // logs *something* diagnosable instead of an empty providerMessage.
  const networkMessage =
    !(error instanceof ProviderHttpError) && error instanceof Error
      ? `${error.name}: ${error.message}${error.cause instanceof Error ? ` (${error.cause.message})` : ""}`
      : undefined;
  const providerMessage = g?.message ?? networkMessage;
  if (g?.code === 190) {
    return new OAuthError(g.error_subcode === 463 ? "token_expired" : "token_revoked", undefined, { providerMessage });
  }
  if (g?.code !== undefined && g.code >= 200 && g.code < 300) {
    return new OAuthError("insufficient_permissions", undefined, { providerMessage });
  }
  if (g?.code !== undefined && [4, 17, 32, 613].includes(g.code)) {
    return new OAuthError("rate_limited", undefined, { providerMessage });
  }
  return new OAuthError(fallback, undefined, { providerMessage });
}

export function createInstagramAdapter(credentials: ProviderCredentials): OAuthProviderAdapter {
  async function exchangeShortLived(code: string, redirectUri: string): Promise<{ accessToken: string; userId: string; permissions: string[] }> {
    const body = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    });
    let response: unknown;
    try {
      response = await requestJson(
        SHORT_LIVED_TOKEN_URL,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        },
        { preprocessRawText: preserveUserId },
      );
    } catch (error) {
      // Logs the complete raw failure (status, body, or the underlying
      // network error) regardless of how it maps to an OAuthError, so a
      // failure is diagnosable from the server log instead of a bare
      // "token_exchange_failed" with no detail.
      logger.warn(
        {
          isProviderHttpError: error instanceof ProviderHttpError,
          status: error instanceof ProviderHttpError ? error.status : undefined,
          body: error instanceof ProviderHttpError ? error.body : undefined,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
          cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
        },
        "Instagram short-lived token exchange failed",
      );
      throw mapInstagramError(error, "token_exchange_failed");
    }
    const accessToken = stringField(response, "access_token");
    const userId = stringField(response, "user_id");
    if (!accessToken || !userId) {
      // The request succeeded (HTTP 2xx, no exception) but the body doesn't
      // have the fields expected. Log the actual shape Instagram sent back
      // instead of failing silently.
      logger.warn({ response }, "Instagram short-lived token exchange returned 200 but with an unexpected body shape");
      const g = graphError(response);
      throw new OAuthError("token_exchange_failed", undefined, { providerMessage: g?.message });
    }
    const permissions = field<string[]>(response, "permissions") ?? [];
    return { accessToken, userId, permissions };
  }

  async function exchangeForLongLived(shortLived: string): Promise<{ accessToken: string; expiresAt: Date }> {
    const url = new URL(`${GRAPH_HOST}/access_token`);
    url.searchParams.set("grant_type", "ig_exchange_token");
    url.searchParams.set("client_secret", credentials.clientSecret);
    url.searchParams.set("access_token", shortLived);
    let body: unknown;
    try {
      body = await requestJson(url);
    } catch (error) {
      throw mapInstagramError(error, "token_exchange_failed");
    }
    const accessToken = stringField(body, "access_token");
    const expiresIn = numberField(body, "expires_in");
    if (!accessToken || !expiresIn) throw new OAuthError("token_exchange_failed");
    return { accessToken, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async function fetchProfile(accessToken: string): Promise<{
    userId: string;
    username: string;
    name: string | null;
    accountType: string | null;
    avatarUrl: string | null;
  }> {
    const url = new URL(`${GRAPH_HOST}/me`);
    url.searchParams.set("fields", "user_id,username,name,account_type,profile_picture_url");
    url.searchParams.set("access_token", accessToken);
    const body = await requestJson(url, {}, { preprocessRawText: preserveUserId });
    const userId = stringField(body, "user_id");
    const username = stringField(body, "username");
    if (!userId || !username) throw new OAuthError("invalid_callback");
    return {
      userId,
      username,
      name: stringField(body, "name"),
      accountType: stringField(body, "account_type"),
      avatarUrl: stringField(body, "profile_picture_url"),
    };
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // Stays under the publisher's 10 minute "interrupted" cutoff, so a slow video fails cleanly instead of being marked interrupted.
  const PROCESSING_DEADLINE_MS = 7 * 60_000;
  const POLL_MS = Number(process.env.INSTAGRAM_POLL_INTERVAL_MS) > 0 ? Number(process.env.INSTAGRAM_POLL_INTERVAL_MS) : 3_000;

  async function graphPost(path: string, accessToken: string, params: Record<string, string>): Promise<unknown> {
    try {
      return await requestJson(`${GRAPH_HOST}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, access_token: accessToken }),
      });
    } catch (error) {
      throw mapInstagramError(error, "publish_failed");
    }
  }

  /** Instagram fetches the file itself and processes it; the container is publishable only once it reports FINISHED. */
  async function waitUntilFinished(containerId: string, accessToken: string, deadline: number): Promise<void> {
    for (;;) {
      const url = new URL(`${GRAPH_HOST}/${containerId}`);
      url.searchParams.set("fields", "status_code,status");
      url.searchParams.set("access_token", accessToken);
      let body: unknown;
      try {
        body = await requestJson(url);
      } catch (error) {
        throw mapInstagramError(error, "publish_failed");
      }
      const code = stringField(body, "status_code");
      if (code === "FINISHED" || code === "PUBLISHED") return;
      if (code === "ERROR" || code === "EXPIRED") {
        const detail = stringField(body, "status");
        throw new OAuthError("publish_failed", undefined, { providerMessage: `Instagram couldn't process the media${detail ? `: ${detail}` : "."}` });
      }
      if (Date.now() + POLL_MS > deadline) {
        throw new OAuthError("publish_failed", undefined, { providerMessage: "Instagram is still processing the media. It was not published; try again in a few minutes." });
      }
      await sleep(POLL_MS);
    }
  }

  function mediaUrl(item: PublishMedia): string {
    if (!item.publicUrl) {
      throw new OAuthError("publish_failed", undefined, { providerMessage: "Instagram downloads media from a public https address, and this app doesn't have one configured (set OAUTH_REDIRECT_BASE_URL to your public https URL)." });
    }
    return item.publicUrl;
  }

  return {
    platform: "instagram",
    displayName: "Instagram",
    requiredEnv: ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"],
    requiredScopes: INSTAGRAM_REQUIRED_SCOPES,
    optionalScopes: INSTAGRAM_OPTIONAL_SCOPES,
    usesPkce: false,

    buildAuthorizationUrl({ state, redirectUri }) {
      const url = new URL(AUTH_URL);
      url.searchParams.set("client_id", credentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", [...INSTAGRAM_REQUIRED_SCOPES, ...INSTAGRAM_OPTIONAL_SCOPES, ...(commentScopesEnabled() ? [INSTAGRAM_COMMENT_SCOPE] : []), ...(analyticsScopesEnabled() ? [INSTAGRAM_INSIGHTS_SCOPE] : []), ...(messagingScopesEnabled() ? [INSTAGRAM_MESSAGING_SCOPE] : [])].join(","));
      url.searchParams.set("state", state);
      return url.toString();
    },

    async handleCallback({ code, redirectUri }) {
      const shortLived = await exchangeShortLived(code, redirectUri);

      const missing = INSTAGRAM_REQUIRED_SCOPES.filter((s) => !shortLived.permissions.includes(s));
      if (missing.length > 0) {
        throw new OAuthError(
          "missing_scopes",
          `Missing required Instagram permissions: ${missing.join(", ")}`,
          { missingScopes: missing },
        );
      }

      try {
        const longLived = await exchangeForLongLived(shortLived.accessToken);
        const profile = await fetchProfile(longLived.accessToken);

        if (!profile.accountType || !PROFESSIONAL_ACCOUNT_TYPES.has(profile.accountType)) {
          throw new OAuthError(
            "no_accounts",
            "This Instagram account isn't a Business or Creator account. Switch to a professional account in the Instagram app (Settings → Account type) and reconnect.",
          );
        }

        const candidate: AccountCandidate = {
          externalAccountId: profile.userId,
          accountType: profile.accountType === "CREATOR" || profile.accountType === "MEDIA_CREATOR" ? "instagram_creator" : "instagram_business",
          displayName: profile.name ?? profile.username,
          username: profile.username,
          avatarUrl: profile.avatarUrl,
          accessToken: longLived.accessToken,
          // Instagram has no separate refresh token: the long-lived access
          // token itself is refreshed in place via ig_refresh_token. Storing
          // it here too lets the shared ensureFreshToken() logic trigger a
          // refresh before expiry without any change to the shared code.
          refreshToken: longLived.accessToken,
          tokenExpiresAt: longLived.expiresAt,
          refreshTokenExpiresAt: null,
          scopes: shortLived.permissions,
          metadata: { accountType: profile.accountType },
          selectable: true,
          warnings: [],
        };

        return { externalUserId: profile.userId, grantedScopes: shortLived.permissions, candidates: [candidate] };
      } catch (error) {
        throw mapInstagramError(error);
      }
    },

    /**
     * Publishes via the Instagram content-publishing flow: create a media container per file (or one carousel
     * container over several), wait for Instagram to finish processing, then publish the container. A single video
     * is published as a Reel; images must be JPEG. Instagram has no text-only posts and no clickable link in a
     * caption, so a post with a link and no attached photo or video uses the link's own preview picture as the
     * post's image instead — Instagram fetches it itself from the URL, the same way it fetches our uploads, so it
     * doesn't need to be downloaded and re-hosted first. There is no card, just a photo; the caption (and the link
     * itself, as unclickable text if the user included it) is unchanged.
     */
    async publishPost(account: StoredAccountCredentials, input: PublishInput): Promise<PublishResult> {
      const media = input.media ?? [];
      const linkImageUrl = media.length === 0 ? input.link?.imageUrl ?? null : null;
      if (media.length === 0 && !linkImageUrl) throw new OAuthError("publish_failed", undefined, { providerMessage: "Instagram posts need an image or video." });
      const token = account.accessToken;
      const igId = encodeURIComponent(account.externalAccountId);
      const deadline = Date.now() + PROCESSING_DEADLINE_MS;

      const create = async (params: Record<string, string>): Promise<string> => {
        const id = stringField(await graphPost(`${igId}/media`, token, params), "id");
        if (!id) throw new OAuthError("publish_failed", undefined, { providerMessage: "Instagram accepted the media but returned no container ID." });
        return id;
      };

      let containerId: string;
      let notice: string | undefined;
      if (media.length === 0) {
        containerId = await create({ image_url: linkImageUrl!, caption: input.text });
        notice = "Instagram can't show a clickable link, so the link's preview picture was posted as the photo instead.";
      } else if (media.length === 1) {
        const item = media[0]!;
        containerId = await create(item.kind === "video"
          ? { media_type: "REELS", video_url: mediaUrl(item), caption: input.text }
          : { image_url: mediaUrl(item), caption: input.text });
      } else {
        const children: string[] = [];
        for (const item of media) {
          children.push(await create(item.kind === "video"
            ? { media_type: "VIDEO", video_url: mediaUrl(item), is_carousel_item: "true" }
            : { image_url: mediaUrl(item), is_carousel_item: "true" }));
        }
        for (const child of children) await waitUntilFinished(child, token, deadline);
        containerId = await create({ media_type: "CAROUSEL", children: children.join(","), caption: input.text });
      }
      await waitUntilFinished(containerId, token, deadline);
      const externalPostId = stringField(await graphPost(`${igId}/media_publish`, token, { creation_id: containerId }), "id");
      if (!externalPostId) throw new OAuthError("publish_failed", undefined, { providerMessage: "Instagram accepted the post but returned no media ID." });
      return notice ? { externalPostId, notice } : { externalPostId };
    },

    /** Followers and media count, plus likes and comments per post (basic permission). Reach, saves, shares and views need the insights permission. */
    async collectMetrics(account: StoredAccountCredentials, input: { postIds: string[] }): Promise<MetricsResult> {
      const result: MetricsResult = { account: {}, posts: {}, notes: [] };
      const withInsights = (account.scopes ?? []).includes(INSTAGRAM_INSIGHTS_SCOPE);
      try {
        const url = new URL(`${GRAPH_HOST}/me`);
        url.searchParams.set("fields", "followers_count,media_count");
        url.searchParams.set("access_token", account.accessToken);
        const profile = await requestJson(url);
        result.account.followers = numberField(profile, "followers_count");
        result.account.mediaCount = numberField(profile, "media_count");
      } catch (error) {
        const mapped = mapInstagramError(error);
        if (mapped.code === "token_revoked" || mapped.code === "token_expired") throw mapped;
        result.notes.push({ code: "followers_unavailable", message: "Instagram didn't return the follower count." });
      }
      let missing = 0;
      for (let i = 0; i < input.postIds.length; i += 5) {
        await Promise.all(input.postIds.slice(i, i + 5).map(async (mediaId) => {
          try {
            const url = new URL(`${GRAPH_HOST}/${encodeURIComponent(mediaId)}`);
            url.searchParams.set("fields", "like_count,comments_count");
            url.searchParams.set("access_token", account.accessToken);
            const body = await requestJson(url);
            const values: PostMetricValues = { likes: numberField(body, "like_count"), comments: numberField(body, "comments_count") };
            if (withInsights) {
              try {
                const insightsUrl = new URL(`${GRAPH_HOST}/${encodeURIComponent(mediaId)}/insights`);
                insightsUrl.searchParams.set("metric", "reach,saved,shares,views");
                insightsUrl.searchParams.set("access_token", account.accessToken);
                for (const item of field<Array<Record<string, unknown>>>(await requestJson(insightsUrl), "data") ?? []) {
                  const value = numberField((field<unknown[]>(item, "values") ?? [])[0], "value") ?? numberField(field(item, "total_value"), "value");
                  if (item.name === "reach") values.reach = value;
                  if (item.name === "saved") values.saves = value;
                  if (item.name === "shares") values.shares = value;
                  if (item.name === "views") values.views = value;
                }
              } catch {
                /* insights for this post aren't available; likes and comments still are */
              }
            }
            result.posts[mediaId] = values;
          } catch {
            missing += 1;
          }
        }));
      }
      if (missing > 0) result.notes.push({ code: "posts_unavailable", message: `Instagram didn't return numbers for ${missing} ${missing === 1 ? "post" : "posts"}.` });
      if (!withInsights) result.notes.push({ code: "insights_permission", message: "Reach, saves, shares and views need the instagram_business_manage_insights permission. Enable it on the Meta app, set ANALYTICS_SCOPES_ENABLED=true and reconnect this account." });
      return result;
    },

    commentScope: INSTAGRAM_COMMENT_SCOPE,
    async publishComment(account: StoredAccountCredentials, input: PublishCommentInput): Promise<PublishCommentResult> {
      const response = await graphPost(`${encodeURIComponent(input.externalPostId)}/comments`, account.accessToken, { message: input.text });
      const externalCommentId = stringField(response, "id");
      if (!externalCommentId) throw new OAuthError("publish_failed", undefined, { providerMessage: "Instagram accepted the comment but returned no ID." });
      return { externalCommentId };
    },

    async refreshAccessToken(refreshToken: string): Promise<RefreshedTokens> {
      const url = new URL(`${GRAPH_HOST}/refresh_access_token`);
      url.searchParams.set("grant_type", "ig_refresh_token");
      url.searchParams.set("access_token", refreshToken);
      let body: unknown;
      try {
        body = await requestJson(url);
      } catch (error) {
        throw mapInstagramError(error);
      }
      const accessToken = stringField(body, "access_token");
      const expiresIn = numberField(body, "expires_in");
      if (!accessToken || !expiresIn) throw new OAuthError("provider_error");
      const expiresAt = new Date(Date.now() + expiresIn * 1000);
      return {
        accessToken,
        refreshToken: accessToken,
        tokenExpiresAt: expiresAt,
        refreshTokenExpiresAt: null,
      };
    },

    async verifyAccount(account: StoredAccountCredentials): Promise<VerificationResult> {
      // Instagram's Instagram-Login product does not expose a documented
      // permissions-listing endpoint equivalent to Facebook's
      // /me/permissions, so verification here only re-checks token validity
      // and refreshes profile data. Granted scopes are not re-derived; they
      // stay as recorded when the account was connected.
      try {
        const profile = await fetchProfile(account.accessToken);
        return {
          status: "active",
          detail: null,
          displayName: profile.name ?? profile.username,
          avatarUrl: profile.avatarUrl,
        };
      } catch (error) {
        const mapped = mapInstagramError(error);
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

export const instagramProvider: ProviderDefinition = {
  platform: "instagram",
  displayName: "Instagram",
  requiredEnv: ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"],
  requiredScopes: INSTAGRAM_REQUIRED_SCOPES,
  optionalScopes: INSTAGRAM_OPTIONAL_SCOPES,
  implemented: true,
  create: createInstagramAdapter,
};
