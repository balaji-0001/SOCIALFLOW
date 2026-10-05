import { openAsBlob } from "node:fs";
import { commentScopesEnabled } from "../config";
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
  PublishCommentInput,
  PublishCommentResult,
  PublishInput,
  PublishResult,
  RefreshedTokens,
  StoredAccountCredentials,
  VerificationResult,
} from "../types";

// Google OAuth 2.0 (web server flow, with PKCE) + the YouTube Data API v3.
// Docs:
//   https://developers.google.com/identity/protocols/oauth2/web-server
//   https://developers.google.com/identity/protocols/oauth2 (refresh token expiry, incl. the
//     7-day expiry for apps whose OAuth consent screen is in Testing status)
//   https://developers.google.com/youtube/v3/docs/channels/list

export const YOUTUBE_REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
];
// youtube.force-ssl is what commentThreads.insert needs (first comment). Requested only when
// COMMENT_SCOPES_ENABLED=true; uploads work without it.
export const YOUTUBE_COMMENT_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
export const YOUTUBE_OPTIONAL_SCOPES: string[] = [];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

/** YouTube shows the first line of the post as the video title (max 100 characters) and the whole text as the description. */
export function youtubeTitleAndDescription(text: string): { title: string; description: string } {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
  const title = firstLine.length > 100 ? `${firstLine.slice(0, 99).trimEnd()}…` : firstLine;
  return { title, description: text.trim() };
}

/** YouTube rejects angle brackets in titles and descriptions. */
export const YOUTUBE_BAD_CHARACTERS = /[<>]/;

/** Videos are uploaded as private unless YOUTUBE_DEFAULT_PRIVACY says otherwise. Google forces private on API projects it hasn't audited. */
function uploadPrivacy(): "private" | "unlisted" | "public" {
  const value = process.env.YOUTUBE_DEFAULT_PRIVACY?.trim();
  return value === "public" || value === "unlisted" ? value : "private";
}

/** Upload failures that are about the project's quota, not about the account's permissions. */
function mapUploadError(error: unknown): OAuthError {
  const body = error instanceof ProviderHttpError ? error.body : null;
  const reasons = field<Array<{ reason?: string }>>(field(body, "error"), "errors") ?? [];
  const reason = reasons[0]?.reason;
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || reason === "uploadLimitExceeded" || reason === "rateLimitExceeded") {
    const detail = googleError(body)?.message;
    return new OAuthError("rate_limited", undefined, { providerMessage: `YouTube's upload limit was reached (${reason}). Try again later.${detail ? ` ${detail}` : ""}` });
  }
  if (reason === "forbidden" || reason === "youtubeSignupRequired") {
    return new OAuthError("publish_failed", undefined, { providerMessage: googleError(body)?.message ?? "YouTube refused the upload for this channel." });
  }
  return mapGoogleError(error, "publish_failed");
}

type GoogleError = { message?: string; status?: string; code?: number; errorCode?: string };

function googleError(body: unknown): GoogleError | null {
  const error = field(body, "error");
  // The token and tokeninfo endpoints return { error: "invalid_grant" | "invalid_token", error_description }
  // (RFC 6749 style, HTTP 400) rather than the { error: { code, status, message } } shape used by most
  // other Google APIs (e.g. YouTube Data API), so both must be recognized here.
  if (typeof error === "string") {
    return { message: field<string>(body, "error_description") ?? error, errorCode: error };
  }
  if (error && typeof error === "object") return error as GoogleError;
  return null;
}

export function mapGoogleError(error: unknown, fallback: OAuthError["code"] = "provider_error"): OAuthError {
  if (error instanceof OAuthError) return error;
  const status = error instanceof ProviderHttpError ? error.status : undefined;
  const body = error instanceof ProviderHttpError ? error.body : null;
  const g = googleError(body);
  const providerMessage = g?.message;
  // Note: "invalid_grant" is deliberately not treated as a dead token here,
  // since it's ambiguous out of context — from the token endpoint during
  // code exchange it means a bad/expired authorization code (see
  // exchangeCode's explicit token_exchange_failed fallback below), while
  // from the same endpoint during a refresh it means a dead refresh token
  // (see refreshAccessToken's explicit handling).
  const isDeadToken = status === 401 || g?.status === "UNAUTHENTICATED" || g?.errorCode === "invalid_token";
  if (isDeadToken) return new OAuthError("token_revoked", undefined, { providerMessage });
  if (status === 403) return new OAuthError("insufficient_permissions", undefined, { providerMessage });
  if (status === 429) return new OAuthError("rate_limited", undefined, { providerMessage });
  return new OAuthError(fallback, undefined, { providerMessage });
}

export function createYouTubeAdapter(credentials: ProviderCredentials): OAuthProviderAdapter {
  async function exchangeCode(code: string, redirectUri: string, codeVerifier: string | undefined) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    });
    if (codeVerifier) body.set("code_verifier", codeVerifier);
    let response: unknown;
    try {
      response = await requestJson(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    } catch (error) {
      throw mapGoogleError(error, "token_exchange_failed");
    }
    const accessToken = stringField(response, "access_token");
    const expiresIn = numberField(response, "expires_in");
    if (!accessToken || !expiresIn) throw new OAuthError("token_exchange_failed");
    return {
      accessToken,
      refreshToken: stringField(response, "refresh_token"),
      tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
      scope: (stringField(response, "scope") ?? "").split(/\s+/).filter(Boolean),
    };
  }

  async function listChannels(accessToken: string): Promise<unknown[]> {
    const url = new URL(`${YOUTUBE_API}/channels`);
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("mine", "true");
    const body = await requestJson(url, { headers: { authorization: `Bearer ${accessToken}` } });
    return field<unknown[]>(body, "items") ?? [];
  }

  return {
    platform: "youtube",
    displayName: "YouTube",
    requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    requiredScopes: YOUTUBE_REQUIRED_SCOPES,
    optionalScopes: YOUTUBE_OPTIONAL_SCOPES,
    usesPkce: true,

    buildAuthorizationUrl({ state, redirectUri, codeChallenge, reconnect }) {
      const url = new URL(AUTH_URL);
      url.searchParams.set("client_id", credentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", [...YOUTUBE_REQUIRED_SCOPES, ...YOUTUBE_OPTIONAL_SCOPES, ...(commentScopesEnabled() ? [YOUTUBE_COMMENT_SCOPE] : [])].join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("include_granted_scopes", "true");
      if (codeChallenge) {
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
      }
      // Force the consent screen so a refresh token is issued even if the
      // user previously authorized this app (Google only returns a refresh
      // token on the first grant, unless prompt=consent forces it again).
      // Also used for reconnect, so a revoked/declined grant is re-asked.
      if (reconnect) url.searchParams.set("prompt", "consent");
      return url.toString();
    },

    async handleCallback({ code, redirectUri, codeVerifier }) {
      const token = await exchangeCode(code, redirectUri, codeVerifier);

      const missing = YOUTUBE_REQUIRED_SCOPES.filter((s) => !token.scope.includes(s));
      if (missing.length > 0) {
        throw new OAuthError("missing_scopes", `Missing required Google permissions: ${missing.join(", ")}`, { missingScopes: missing });
      }

      try {
        const channels = await listChannels(token.accessToken);
        const candidates: AccountCandidate[] = [];
        for (const channel of channels) {
          const id = stringField(channel, "id");
          const snippet = field(channel, "snippet");
          const title = stringField(snippet, "title");
          if (!id || !title) continue;
          candidates.push({
            externalAccountId: id,
            accountType: "youtube_channel",
            displayName: title,
            username: stringField(snippet, "customUrl"),
            avatarUrl: stringField(field(field(snippet, "thumbnails"), "default"), "url"),
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            tokenExpiresAt: token.tokenExpiresAt,
            refreshTokenExpiresAt: null,
            scopes: token.scope,
            metadata: {},
            selectable: true,
            warnings: [],
          });
        }

        if (candidates.length === 0) {
          throw new OAuthError(
            "no_accounts",
            "No YouTube channels were found for this Google account. Create a channel at youtube.com and try again.",
          );
        }

        // externalUserId: Google's OAuth doesn't return a stable user ID from
        // this flow without an extra userinfo call this adapter doesn't need
        // (channels are already scoped to `mine=true`); the first channel ID
        // stands in as the authorizing identity for reconnect matching.
        return { externalUserId: candidates[0]!.externalAccountId, grantedScopes: token.scope, candidates };
      } catch (error) {
        throw mapGoogleError(error);
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
        // A revoked or expired (e.g. 7-day Testing-mode) refresh token comes
        // back as invalid_grant. mapGoogleError can't tell that apart from a
        // bad authorization code (same error code, different endpoint use),
        // so in this specific refresh context, treat its generic fallback as
        // token_revoked: the account should show "Reconnect".
        const mapped = mapGoogleError(error);
        throw mapped.code === "provider_error" ? new OAuthError("token_revoked", undefined, mapped.details) : mapped;
      }
      const accessToken = stringField(response, "access_token");
      const expiresIn = numberField(response, "expires_in");
      if (!accessToken || !expiresIn) throw new OAuthError("provider_error");
      // Google does not return a new refresh_token on refresh; keep the one we have.
      return {
        accessToken,
        refreshToken,
        tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        refreshTokenExpiresAt: null,
      };
    },

    /**
     * Uploads one video with YouTube's resumable upload protocol: a first request sends the title, description and
     * privacy and returns an upload address, then the file's bytes go to that address. The first line of the post is
     * the title and the whole text is the description.
     */
    async publishPost(account: StoredAccountCredentials, input: PublishInput): Promise<PublishResult> {
      const video = (input.media ?? []).find((item) => item.kind === "video");
      const thumbnail = (input.media ?? []).find((item) => item.kind === "image");
      if (!video || (input.media ?? []).length !== (thumbnail ? 2 : 1)) throw new OAuthError("publish_failed", undefined, { providerMessage: "YouTube posts need one video, and optionally one photo as its thumbnail." });
      const { title, description } = youtubeTitleAndDescription(input.text);
      if (!title) throw new OAuthError("publish_failed", undefined, { providerMessage: "YouTube needs some text: its first line becomes the video title." });
      if (YOUTUBE_BAD_CHARACTERS.test(input.text)) throw new OAuthError("publish_failed", undefined, { providerMessage: "YouTube doesn't allow < or > in a title or description." });

      // Step 1: open the upload session. Its address comes back in the Location header, so this call uses fetch directly.
      let session: Response;
      try {
        session = await fetch(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${account.accessToken}`,
            "content-type": "application/json; charset=UTF-8",
            "x-upload-content-length": String(video.sizeBytes),
            "x-upload-content-type": video.mimeType,
          },
          body: JSON.stringify({
            snippet: { title, description, categoryId: "22" },
            status: { privacyStatus: uploadPrivacy(), selfDeclaredMadeForKids: false },
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        throw mapUploadError(error);
      }
      if (!session.ok) {
        const text = await session.text();
        let body: unknown = null;
        try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
        throw mapUploadError(new ProviderHttpError(session.status, body));
      }
      const uploadAddress = session.headers.get("location");
      if (!uploadAddress) throw new OAuthError("publish_failed", undefined, { providerMessage: "YouTube didn't return an upload address." });

      // Step 2: send the file.
      let response: unknown;
      try {
        response = await requestJson(uploadAddress, {
          method: "PUT",
          headers: { authorization: `Bearer ${account.accessToken}`, "content-type": video.mimeType },
          body: await openAsBlob(video.filePath, { type: video.mimeType }),
        }, { timeoutMs: UPLOAD_TIMEOUT_MS });
      } catch (error) {
        throw mapUploadError(error);
      }
      const externalPostId = stringField(response, "id");
      if (!externalPostId) throw new OAuthError("publish_failed", undefined, { providerMessage: "YouTube accepted the upload but returned no video ID." });
      if (!thumbnail) return { externalPostId };
      // The video is already up, so a thumbnail problem is reported without failing the post.
      try {
        await requestJson(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(externalPostId)}`, {
          method: "POST",
          headers: { authorization: `Bearer ${account.accessToken}`, "content-type": thumbnail.mimeType },
          body: await openAsBlob(thumbnail.filePath, { type: thumbnail.mimeType }),
        }, { timeoutMs: 60_000 });
        return { externalPostId };
      } catch (error) {
        const detail = mapUploadError(error).details.providerMessage;
        return { externalPostId, notice: `The video was published, but the thumbnail wasn't set${detail ? `: ${detail}` : "."} YouTube only allows custom thumbnails on verified channels.` };
      }
    },

    /** Channel statistics and per-video views, likes and comments from the YouTube Data API (covered by youtube.readonly). */
    async collectMetrics(account: StoredAccountCredentials, input: { postIds: string[] }): Promise<MetricsResult> {
      const result: MetricsResult = { account: {}, posts: {}, notes: [] };
      const headers = { authorization: `Bearer ${account.accessToken}` };
      try {
        const url = new URL(`${YOUTUBE_API}/channels`);
        url.searchParams.set("part", "statistics");
        url.searchParams.set("mine", "true");
        const items = field<unknown[]>(await requestJson(url, { headers }), "items") ?? [];
        const stats = field(items[0], "statistics");
        const asNumber = (key: string) => { const raw = stringField(stats, key); return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null; };
        if (field(stats, "hiddenSubscriberCount") === true) result.notes.push({ code: "subscribers_hidden", message: "This channel hides its subscriber count, so followers can't be shown." });
        else result.account.followers = asNumber("subscriberCount");
        result.account.mediaCount = asNumber("videoCount");
        result.account.viewsTotal = asNumber("viewCount");
      } catch (error) {
        const mapped = mapGoogleError(error);
        if (mapped.code === "token_revoked" || mapped.code === "token_expired") throw mapped;
        result.notes.push({ code: "channel_unavailable", message: "YouTube didn't return the channel statistics." });
      }
      for (let i = 0; i < input.postIds.length; i += 50) {
        const ids = input.postIds.slice(i, i + 50);
        try {
          const url = new URL(`${YOUTUBE_API}/videos`);
          url.searchParams.set("part", "statistics");
          url.searchParams.set("id", ids.join(","));
          for (const item of field<unknown[]>(await requestJson(url, { headers }), "items") ?? []) {
            const id = stringField(item, "id");
            const stats = field(item, "statistics");
            const asNumber = (key: string) => { const raw = stringField(stats, key); return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null; };
            if (id) result.posts[id] = { views: asNumber("viewCount"), likes: asNumber("likeCount"), comments: asNumber("commentCount") };
          }
        } catch {
          result.notes.push({ code: "videos_unavailable", message: "YouTube didn't return statistics for some videos." });
        }
      }
      const missing = input.postIds.filter((id) => !(id in result.posts)).length;
      if (missing > 0 && input.postIds.length > 0) result.notes.push({ code: "posts_unavailable", message: `YouTube didn't return numbers for ${missing} ${missing === 1 ? "video" : "videos"} (deleted or removed).` });
      return result;
    },

    commentScope: YOUTUBE_COMMENT_SCOPE,
    async publishComment(account: StoredAccountCredentials, input: PublishCommentInput): Promise<PublishCommentResult> {
      let response: unknown;
      try {
        response = await requestJson(`${YOUTUBE_API}/commentThreads?part=snippet`, {
          method: "POST",
          headers: { authorization: `Bearer ${account.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ snippet: { videoId: input.externalPostId, topLevelComment: { snippet: { textOriginal: input.text } } } }),
        });
      } catch (error) {
        throw mapGoogleError(error, "publish_failed");
      }
      const externalCommentId = stringField(response, "id");
      if (!externalCommentId) throw new OAuthError("publish_failed", undefined, { providerMessage: "YouTube accepted the comment but returned no ID." });
      return { externalCommentId };
    },

    async verifyAccount(account: StoredAccountCredentials): Promise<VerificationResult> {
      const infoUrl = new URL(TOKENINFO_URL);
      infoUrl.searchParams.set("access_token", account.accessToken);
      let info: unknown;
      try {
        info = await requestJson(infoUrl);
      } catch (error) {
        const mapped = mapGoogleError(error);
        return { status: mapped.code === "token_revoked" ? "revoked" : "error", detail: mapped.message };
      }

      const scopeStr = stringField(info, "scope") ?? "";
      const scopes = scopeStr.split(/\s+/).filter(Boolean);
      const missing = YOUTUBE_REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
      if (missing.length > 0) {
        return { status: "missing_permissions", detail: `Missing permissions: ${missing.join(", ")}`, scopes };
      }

      try {
        const channels = await listChannels(account.accessToken);
        const channel = channels.find((c) => stringField(c, "id") === account.externalAccountId) ?? channels[0];
        const snippet = field(channel, "snippet");
        return {
          status: "active",
          detail: null,
          scopes,
          displayName: stringField(snippet, "title") ?? undefined,
          avatarUrl: stringField(field(field(snippet, "thumbnails"), "default"), "url"),
        };
      } catch (error) {
        const mapped = mapGoogleError(error);
        const status = mapped.code === "token_revoked" ? "revoked" : mapped.code === "insufficient_permissions" ? "missing_permissions" : "error";
        return { status, detail: mapped.details.providerMessage ?? mapped.message, scopes };
      }
    },
  };
}

/** Revokes a Google access or refresh token. Not called by the shared
 * disconnect route today (see Facebook/Instagram adapters for why disconnect
 * doesn't revoke provider-side by default), but exported for a future
 * "revoke on disconnect" option. */
export async function revokeGoogleToken(token: string): Promise<void> {
  const url = new URL(REVOKE_URL);
  url.searchParams.set("token", token);
  await requestJson(url, { method: "POST" });
}

export const youtubeProvider: ProviderDefinition = {
  platform: "youtube",
  displayName: "YouTube",
  requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  requiredScopes: YOUTUBE_REQUIRED_SCOPES,
  optionalScopes: YOUTUBE_OPTIONAL_SCOPES,
  implemented: true,
  create: createYouTubeAdapter,
};
