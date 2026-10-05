import { openAsBlob } from "node:fs";
import { twitterAnalyticsEnabled } from "../config";
import { OAuthError } from "../errors";
import { ProviderHttpError, field, numberField, requestJson, stringField } from "../http";
import { TWITTER_CHAR_LIMIT, twitterLength } from "../../twitter-text";
import type {
  MetricsResult,
  OAuthProviderAdapter,
  ProviderCredentials,
  ProviderDefinition,
  PublishCommentInput,
  PublishCommentResult,
  PublishInput,
  PublishMedia,
  PublishResult,
  RefreshedTokens,
  StoredAccountCredentials,
  VerificationResult,
} from "../types";

// X (formerly Twitter): OAuth 2.0 Authorization Code Flow with PKCE + X API v2.
// Docs:
//   https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
//   https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token
//   https://docs.x.com/x-api/posts/create-post
//   https://docs.x.com/x-api/media/quickstart/media-upload-chunked
//   https://docs.x.com/x-api/getting-started/pricing   (every call is paid for with credits; there is no free plan)
//
// The developer app must be a confidential client ("Web App, Automated App or Bot") with "Read and write"
// permissions; the token endpoint is then called with the client id and secret in a Basic header.

export const TWITTER_REQUIRED_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"];
export const TWITTER_OPTIONAL_SCOPES: string[] = [];

const AUTH_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const API = "https://api.x.com/2";

/** X accepts up to 5 MB per uploaded piece; 4 MB leaves room for the form around it. */
const CHUNK_BYTES = 4 * 1024 * 1024;
const CHUNK_TIMEOUT_MS = 2 * 60_000;
/** How long to wait for X to finish processing a video or GIF before giving up on the post. */
const PROCESSING_LIMIT_MS = 10 * 60_000;

const DISPLAY_NAME = "X (Twitter)";
const REQUIRED_ENV = ["TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET"];

/** What X said went wrong. Its errors come in three shapes: OAuth's, "problem" documents, and a list of errors. */
function twitterMessage(body: unknown): string | undefined {
  const first = field<unknown[]>(body, "errors")?.[0];
  return stringField(body, "detail") ?? stringField(first, "message") ?? stringField(first, "detail") ?? stringField(body, "error_description") ?? stringField(body, "title") ?? stringField(body, "error") ?? undefined;
}

/**
 * Maps a failed call. `forbidden` says what a 403 means for the call being made: reading the profile, a 403 is a
 * missing permission; creating a post, X also answers 403 for a refused post (a duplicate, a video that is too
 * long), which says nothing about the account, so it must not mark the account as needing a reconnect.
 */
export function mapTwitterError(error: unknown, fallback: OAuthError["code"] = "provider_error", forbidden: OAuthError["code"] = "insufficient_permissions"): OAuthError {
  if (error instanceof OAuthError) return error;
  if (!(error instanceof ProviderHttpError)) return new OAuthError(fallback);
  const providerMessage = twitterMessage(error.body);
  if (error.status === 401) return new OAuthError("token_revoked", undefined, { providerMessage });
  if (error.status === 403) return new OAuthError(forbidden, undefined, { providerMessage });
  if (error.status === 429) return new OAuthError("rate_limited", undefined, { providerMessage });
  // X answers 402 when the developer account has no API credits left.
  if (error.status === 402) return new OAuthError(fallback, undefined, { providerMessage: providerMessage ?? "X refused the request: the developer account has no API credits left." });
  return new OAuthError(fallback, undefined, { providerMessage });
}

const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

function mediaCategory(item: PublishMedia): "tweet_image" | "tweet_gif" | "tweet_video" {
  if (item.kind === "video") return "tweet_video";
  return item.mimeType === "image/gif" ? "tweet_gif" : "tweet_image";
}

/**
 * Uploads one file with X's chunked upload (start, send the pieces, finish) and waits until X has processed it.
 * Returns the media id to attach to the post.
 */
async function uploadMedia(accessToken: string, item: PublishMedia): Promise<string> {
  const started = await requestJson(`${API}/media/upload/initialize`, {
    method: "POST",
    headers: { ...bearer(accessToken), "content-type": "application/json" },
    body: JSON.stringify({ media_type: item.mimeType, total_bytes: item.sizeBytes, media_category: mediaCategory(item) }),
  });
  const mediaId = stringField(field(started, "data"), "id");
  if (!mediaId) throw new OAuthError("publish_failed", undefined, { providerMessage: "X didn't return an upload id for a file." });

  const file = await openAsBlob(item.filePath, { type: item.mimeType });
  for (let offset = 0, index = 0; offset < file.size; offset += CHUNK_BYTES, index += 1) {
    const form = new FormData();
    form.set("segment_index", String(index));
    form.set("media", file.slice(offset, offset + CHUNK_BYTES), item.fileName);
    await requestJson(`${API}/media/upload/${encodeURIComponent(mediaId)}/append`, { method: "POST", headers: bearer(accessToken), body: form }, { timeoutMs: CHUNK_TIMEOUT_MS });
  }

  let state = field(field(await requestJson(`${API}/media/upload/${encodeURIComponent(mediaId)}/finalize`, { method: "POST", headers: bearer(accessToken) }, { timeoutMs: CHUNK_TIMEOUT_MS }), "data"), "processing_info");
  // Images are ready at once; videos and GIFs are processed first, and X says when to ask again.
  const deadline = Date.now() + PROCESSING_LIMIT_MS;
  while (state && stringField(state, "state") !== "succeeded") {
    if (stringField(state, "state") === "failed") {
      throw new OAuthError("publish_failed", undefined, { providerMessage: `X couldn't process "${item.fileName}"${stringField(field(state, "error"), "message") ? `: ${stringField(field(state, "error"), "message")}` : "."}` });
    }
    if (Date.now() > deadline) throw new OAuthError("publish_failed", undefined, { providerMessage: `X was still processing "${item.fileName}" after 10 minutes, so the post wasn't sent.` });
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(numberField(state, "check_after_secs") ?? 2, 1), 30) * 1000));
    const url = new URL(`${API}/media/upload`);
    url.searchParams.set("command", "STATUS");
    url.searchParams.set("media_id", mediaId);
    state = field(field(await requestJson(url, { headers: bearer(accessToken) }), "data"), "processing_info");
  }
  return mediaId;
}

export function createTwitterAdapter(credentials: ProviderCredentials): OAuthProviderAdapter {
  const basic = `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`;

  async function token(body: URLSearchParams): Promise<unknown> {
    body.set("client_id", credentials.clientId);
    return requestJson(TOKEN_URL, { method: "POST", headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" }, body });
  }

  async function me(accessToken: string, fields: string): Promise<unknown> {
    const url = new URL(`${API}/users/me`);
    url.searchParams.set("user.fields", fields);
    return field(await requestJson(url, { headers: bearer(accessToken) }), "data");
  }

  async function createPost(accessToken: string, body: Record<string, unknown>): Promise<string> {
    let response: unknown;
    try {
      response = await requestJson(`${API}/tweets`, { method: "POST", headers: { ...bearer(accessToken), "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (error) {
      throw mapTwitterError(error, "publish_failed", "publish_failed");
    }
    const id = stringField(field(response, "data"), "id");
    if (!id) throw new OAuthError("publish_failed", undefined, { providerMessage: "X accepted the post but returned no ID." });
    return id;
  }

  return {
    platform: "twitter",
    displayName: DISPLAY_NAME,
    requiredEnv: REQUIRED_ENV,
    requiredScopes: TWITTER_REQUIRED_SCOPES,
    optionalScopes: TWITTER_OPTIONAL_SCOPES,
    usesPkce: true,
    // X gives a new refresh token with every refresh and retires the old one (see ensureFreshToken).
    rotatesRefreshTokens: true,

    buildAuthorizationUrl({ state, redirectUri, codeChallenge }) {
      if (!codeChallenge) throw new OAuthError("invalid_callback", "X sign-in needs a PKCE challenge.");
      const url = new URL(AUTH_URL);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", credentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", [...TWITTER_REQUIRED_SCOPES, ...TWITTER_OPTIONAL_SCOPES].join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },

    async handleCallback({ code, redirectUri, codeVerifier }) {
      if (!codeVerifier) throw new OAuthError("invalid_callback");
      let response: unknown;
      try {
        response = await token(new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier }));
      } catch (error) {
        // Whatever the status, a refusal here is about the code or the app's own id and secret, never about an account.
        if (error instanceof ProviderHttpError && error.status !== 429) throw new OAuthError("token_exchange_failed", undefined, { providerMessage: twitterMessage(error.body) });
        throw mapTwitterError(error, "token_exchange_failed");
      }
      const accessToken = stringField(response, "access_token");
      const expiresIn = numberField(response, "expires_in");
      if (!accessToken || !expiresIn) throw new OAuthError("token_exchange_failed");
      // X lists what was granted; a person can't untick single permissions, but an app whose settings are
      // read-only is given fewer than it asked for.
      const granted = (stringField(response, "scope") ?? "").split(/\s+/).filter(Boolean);
      const scopes = granted.length > 0 ? granted : TWITTER_REQUIRED_SCOPES;
      const missing = TWITTER_REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
      if (missing.length > 0) {
        throw new OAuthError("missing_scopes", `Missing required X permissions: ${missing.join(", ")}. In the X developer console, set the app's permissions to "Read and write".`, { missingScopes: missing });
      }

      let user: unknown;
      try {
        user = await me(accessToken, "profile_image_url,subscription_type");
      } catch (error) {
        throw mapTwitterError(error);
      }
      const id = stringField(user, "id");
      const username = stringField(user, "username");
      if (!id || !username) throw new OAuthError("no_accounts", "X didn't return a profile for this login.");
      return {
        externalUserId: id,
        grantedScopes: scopes,
        candidates: [{
          externalAccountId: id,
          accountType: "twitter_account",
          displayName: stringField(user, "name") ?? `@${username}`,
          username,
          avatarUrl: stringField(user, "profile_image_url"),
          accessToken,
          refreshToken: stringField(response, "refresh_token"),
          tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
          refreshTokenExpiresAt: null,
          scopes,
          metadata: { subscriptionType: stringField(user, "subscription_type") },
          selectable: true,
          warnings: [],
        }],
      };
    },

    async refreshAccessToken(refreshToken: string): Promise<RefreshedTokens> {
      let response: unknown;
      try {
        response = await token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }));
      } catch (error) {
        // X answers 400 (invalid_request / invalid_grant) for a refresh token that was revoked or already used;
        // only signing in again helps. A 401 here is about the app's own id and secret, and rate limits and outages
        // say nothing about the account either, so those leave it as it is.
        if (error instanceof ProviderHttpError && error.status === 400) throw new OAuthError("token_revoked", undefined, { providerMessage: twitterMessage(error.body) });
        if (error instanceof ProviderHttpError && error.status === 401) throw new OAuthError("provider_error", undefined, { providerMessage: twitterMessage(error.body) });
        throw mapTwitterError(error);
      }
      const accessToken = stringField(response, "access_token");
      const expiresIn = numberField(response, "expires_in");
      if (!accessToken || !expiresIn) throw new OAuthError("provider_error");
      return {
        accessToken,
        // The old refresh token no longer works once this answer has arrived; the new one must be stored.
        refreshToken: stringField(response, "refresh_token") ?? refreshToken,
        tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        refreshTokenExpiresAt: null,
      };
    },

    /**
     * Posts the text with up to four photos, or one GIF, or one video. X builds a link's card itself from the page
     * the link points to, so a link attached in the composer only needs to be in the text.
     */
    async publishPost(account: StoredAccountCredentials, input: PublishInput): Promise<PublishResult> {
      let text = input.text.trim();
      if (input.link?.url && !text.includes(input.link.url)) text = `${text}\n\n${input.link.url}`.trim();
      if (twitterLength(text) > TWITTER_CHAR_LIMIT) {
        throw new OAuthError("publish_failed", undefined, { providerMessage: `X posts can be up to ${TWITTER_CHAR_LIMIT} characters (a link counts as 23); this one counts ${twitterLength(text)}.` });
      }
      const mediaIds: string[] = [];
      try {
        for (const item of input.media ?? []) mediaIds.push(await uploadMedia(account.accessToken, item));
      } catch (error) {
        throw mapTwitterError(error, "publish_failed", "publish_failed");
      }
      return { externalPostId: await createPost(account.accessToken, { text, ...(mediaIds.length > 0 ? { media: { media_ids: mediaIds } } : {}) }) };
    },

    /** The "first comment" on X is a reply under the post, from the same account. It needs no extra permission. */
    async publishComment(account: StoredAccountCredentials, input: PublishCommentInput): Promise<PublishCommentResult> {
      if (twitterLength(input.text) > TWITTER_CHAR_LIMIT) {
        throw new OAuthError("publish_failed", undefined, { providerMessage: `A reply on X can be up to ${TWITTER_CHAR_LIMIT} characters (a link counts as 23).` });
      }
      return { externalCommentId: await createPost(account.accessToken, { text: input.text, reply: { in_reply_to_tweet_id: input.externalPostId } }) };
    },

    /**
     * Followers and per-post numbers. X charges for every reading, so nothing is requested unless
     * TWITTER_ANALYTICS_ENABLED=true; switched off, the answer says so and no call is made.
     */
    async collectMetrics(account: StoredAccountCredentials, input: { postIds: string[] }): Promise<MetricsResult> {
      const result: MetricsResult = { account: {}, posts: {}, notes: [] };
      if (!twitterAnalyticsEnabled()) {
        result.notes.push({ code: "disabled", message: "Numbers from X aren't collected: X charges for every reading. Set TWITTER_ANALYTICS_ENABLED=true on the server to collect them." });
        return result;
      }
      try {
        const metrics = field(await me(account.accessToken, "public_metrics"), "public_metrics");
        result.account.followers = numberField(metrics, "followers_count");
        result.account.mediaCount = numberField(metrics, "tweet_count") ?? numberField(metrics, "post_count");
      } catch (error) {
        const mapped = mapTwitterError(error);
        if (mapped.code === "token_revoked" || mapped.code === "token_expired") throw mapped;
        result.notes.push({ code: "profile_unavailable", message: `X didn't return the profile's numbers${mapped.details.providerMessage ? `: ${mapped.details.providerMessage}` : "."}` });
      }
      for (let i = 0; i < input.postIds.length; i += 100) {
        const url = new URL(`${API}/tweets`);
        url.searchParams.set("ids", input.postIds.slice(i, i + 100).join(","));
        url.searchParams.set("tweet.fields", "public_metrics");
        try {
          for (const post of field<unknown[]>(await requestJson(url, { headers: bearer(account.accessToken) }), "data") ?? []) {
            const id = stringField(post, "id");
            const metrics = field(post, "public_metrics");
            if (!id || !metrics) continue;
            const reposts = numberField(metrics, "retweet_count");
            const quotes = numberField(metrics, "quote_count");
            result.posts[id] = {
              likes: numberField(metrics, "like_count"),
              comments: numberField(metrics, "reply_count"),
              shares: reposts === null && quotes === null ? null : (reposts ?? 0) + (quotes ?? 0),
              impressions: numberField(metrics, "impression_count"),
              saves: numberField(metrics, "bookmark_count"),
            };
          }
        } catch (error) {
          const mapped = mapTwitterError(error);
          if (mapped.code === "token_revoked" || mapped.code === "token_expired") throw mapped;
          result.notes.push({ code: "posts_unavailable", message: `X didn't return numbers for some posts${mapped.details.providerMessage ? `: ${mapped.details.providerMessage}` : "."}` });
        }
      }
      return result;
    },

    async verifyAccount(account: StoredAccountCredentials): Promise<VerificationResult> {
      try {
        const user = await me(account.accessToken, "profile_image_url");
        const username = stringField(user, "username");
        return { status: "active", detail: null, displayName: stringField(user, "name") ?? (username ? `@${username}` : undefined), avatarUrl: stringField(user, "profile_image_url") };
      } catch (error) {
        const mapped = mapTwitterError(error);
        const status = mapped.code === "token_revoked" ? "revoked" : mapped.code === "insufficient_permissions" ? "missing_permissions" : "error";
        return { status, detail: mapped.details.providerMessage ?? mapped.message };
      }
    },
  };
}

export const twitterProvider: ProviderDefinition = {
  platform: "twitter",
  displayName: DISPLAY_NAME,
  requiredEnv: REQUIRED_ENV,
  requiredScopes: TWITTER_REQUIRED_SCOPES,
  optionalScopes: TWITTER_OPTIONAL_SCOPES,
  implemented: true,
  create: createTwitterAdapter,
};
