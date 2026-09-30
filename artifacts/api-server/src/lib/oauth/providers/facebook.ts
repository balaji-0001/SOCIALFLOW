import { createHmac } from "node:crypto";
import { openAsBlob } from "node:fs";
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
  PublishResult,
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
// pages_manage_engagement lets the Page comment under its own posts (first comment). Requested only when
// COMMENT_SCOPES_ENABLED=true; text and media publishing work without it.
export const FACEBOOK_OPTIONAL_SCOPES = ["business_management"];
export const FACEBOOK_COMMENT_SCOPE = "pages_manage_engagement";
// read_insights unlocks reach and impressions. Requested only when ANALYTICS_SCOPES_ENABLED=true.
export const FACEBOOK_INSIGHTS_SCOPE = "read_insights";
// Direct messages: pages_messaging reads and answers Messenger conversations, pages_manage_metadata is the companion Meta asks for. Requested only when
// MESSAGING_SCOPES_ENABLED=true (both need Meta app review).
export const FACEBOOK_MESSAGING_SCOPES = ["pages_messaging", "pages_manage_metadata"];

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

  const UPLOAD_TIMEOUT_MS = 8 * 60_000;

  /** POSTs multipart form data (a file plus fields) to the Page and returns the parsed JSON. */
  async function uploadForm(account: StoredAccountCredentials, edge: string, fields: Record<string, string>, file?: { field: string; blob: Blob; name: string }): Promise<unknown> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set("access_token", account.accessToken);
    form.set("appsecret_proof", appSecretProof(account.accessToken));
    if (file) form.set(file.field, file.blob, file.name);
    try {
      return await requestJson(`${graph}/${encodeURIComponent(account.externalAccountId)}/${edge}`, { method: "POST", body: form }, { timeoutMs: UPLOAD_TIMEOUT_MS });
    } catch (error) {
      throw mapGraphError(error, "publish_failed");
    }
  }

  async function publishMedia(account: StoredAccountCredentials, text: string, media: NonNullable<PublishInput["media"]>): Promise<PublishResult> {
    const video = media.find((item) => item.kind === "video");
    if (video) {
      const response = await uploadForm(account, "videos", { description: text }, { field: "source", blob: await openAsBlob(video.filePath, { type: video.mimeType }), name: video.fileName });
      const id = stringField(response, "id");
      if (!id) throw new OAuthError("publish_failed", undefined, { providerMessage: "Facebook accepted the video but returned no ID." });
      return { externalPostId: id };
    }
    if (media.length === 1) {
      const photo = media[0]!;
      const response = await uploadForm(account, "photos", { caption: text, published: "true" }, { field: "source", blob: await openAsBlob(photo.filePath, { type: photo.mimeType }), name: photo.fileName });
      const id = stringField(response, "post_id") ?? stringField(response, "id");
      if (!id) throw new OAuthError("publish_failed", undefined, { providerMessage: "Facebook accepted the photo but returned no post ID." });
      return { externalPostId: id };
    }
    // Several photos: upload each unpublished, then one feed post attaches them all.
    const photoIds: string[] = [];
    for (const photo of media) {
      const response = await uploadForm(account, "photos", { published: "false" }, { field: "source", blob: await openAsBlob(photo.filePath, { type: photo.mimeType }), name: photo.fileName });
      const id = stringField(response, "id");
      if (!id) throw new OAuthError("publish_failed", undefined, { providerMessage: "Facebook accepted a photo but returned no ID." });
      photoIds.push(id);
    }
    const fields: Record<string, string> = { message: text };
    photoIds.forEach((id, index) => { fields[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id }); });
    const feed = await uploadForm(account, "feed", fields);
    const id = stringField(feed, "id");
    if (!id) throw new OAuthError("publish_failed", undefined, { providerMessage: "Facebook accepted the post but returned no post ID." });
    return { externalPostId: id };
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
        url.searchParams.set("scope", [...FACEBOOK_REQUIRED_SCOPES, ...FACEBOOK_OPTIONAL_SCOPES, ...(commentScopesEnabled() ? [FACEBOOK_COMMENT_SCOPE] : []), ...(analyticsScopesEnabled() ? [FACEBOOK_INSIGHTS_SCOPE] : []), ...(messagingScopesEnabled() ? FACEBOOK_MESSAGING_SCOPES : [])].join(","));
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

    /**
     * Publishes to the Page: text to the feed, one photo (or a GIF) with its caption, several photos as one post
     * (each uploaded unpublished, then attached to a single feed post), or one video. Files are uploaded as bytes,
     * so no public URL is needed. `account.accessToken` is the Page access token.
     */
    async publishPost(account: StoredAccountCredentials, input: PublishInput): Promise<PublishResult> {
      const media = input.media ?? [];
      if (media.length > 0) return publishMedia(account, input.text, media);
      const body = new URLSearchParams({
        message: input.text,
        access_token: account.accessToken,
        appsecret_proof: appSecretProof(account.accessToken),
      });
      // A link post: Facebook builds the clickable card (image, title, description) itself from the website's Open Graph
      // tags. Custom title/image overrides are not supported by the Graph API for Pages, so only the URL is sent. The
      // text is sent exactly as written; the card appears in addition to it. With media attached the link stays text.
      if (input.link?.url) body.set("link", input.link.url);
      let response: unknown;
      try {
        response = await requestJson(`${graph}/${encodeURIComponent(account.externalAccountId)}/feed`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
      } catch (error) {
        throw mapGraphError(error, "publish_failed");
      }
      const externalPostId = stringField(response, "id");
      if (!externalPostId) throw new OAuthError("publish_failed", undefined, { providerMessage: "Facebook accepted the request but returned no post ID." });
      return { externalPostId };
    },

    /**
     * Follower count for the Page and likes, comments and shares for each published post. Uses only permissions the app
     * already requires (pages_read_engagement). Reach and impressions are added when the Page was connected with read_insights.
     */
    async collectMetrics(account: StoredAccountCredentials, input: { postIds: string[] }): Promise<MetricsResult> {
      const result: MetricsResult = { account: {}, posts: {}, notes: [] };
      const withInsights = (account.scopes ?? []).includes(FACEBOOK_INSIGHTS_SCOPE);
      try {
        const page = await requestJson(graphUrl(`/${encodeURIComponent(account.externalAccountId)}`, account.accessToken, { fields: "followers_count,fan_count" }));
        result.account.followers = numberField(page, "followers_count") ?? numberField(page, "fan_count");
      } catch (error) {
        const mapped = mapGraphError(error);
        if (mapped.code === "token_revoked" || mapped.code === "token_expired") throw mapped;
        result.notes.push({ code: "followers_unavailable", message: "Facebook didn't return the follower count." });
      }
      let missing = 0;
      for (let i = 0; i < input.postIds.length; i += 5) {
        await Promise.all(input.postIds.slice(i, i + 5).map(async (postId) => {
          try {
            const body = await requestJson(graphUrl(`/${encodeURIComponent(postId)}`, account.accessToken, { fields: "likes.summary(true).limit(0),comments.summary(true).limit(0),shares" }));
            const values: PostMetricValues = {
              likes: numberField(field(field(body, "likes"), "summary"), "total_count"),
              comments: numberField(field(field(body, "comments"), "summary"), "total_count"),
              shares: numberField(field(body, "shares"), "count") ?? 0,
            };
            if (withInsights) {
              try {
                const insights = await requestJson(graphUrl(`/${encodeURIComponent(postId)}/insights`, account.accessToken, { metric: "post_impressions,post_impressions_unique" }));
                for (const item of field<Array<Record<string, unknown>>>(insights, "data") ?? []) {
                  const value = numberField((field<unknown[]>(item, "values") ?? [])[0], "value");
                  if (item.name === "post_impressions") values.impressions = value;
                  if (item.name === "post_impressions_unique") values.reach = value;
                }
              } catch {
                /* insights for this post aren't available; likes and comments still are */
              }
            }
            result.posts[postId] = values;
          } catch {
            missing += 1;
          }
        }));
      }
      if (missing > 0) result.notes.push({ code: "posts_unavailable", message: `Facebook didn't return numbers for ${missing} ${missing === 1 ? "post" : "posts"} (deleted, or not visible to this connection).` });
      if (!withInsights) result.notes.push({ code: "insights_permission", message: "Reach and impressions need the read_insights permission. Enable it on the Meta app, set ANALYTICS_SCOPES_ENABLED=true and reconnect this Page." });
      return result;
    },

    commentScope: FACEBOOK_COMMENT_SCOPE,
    /** Posts a comment as the Page under one of its own posts. */
    async publishComment(account: StoredAccountCredentials, input: PublishCommentInput): Promise<PublishCommentResult> {
      const body = new URLSearchParams({ message: input.text, access_token: account.accessToken, appsecret_proof: appSecretProof(account.accessToken) });
      let response: unknown;
      try {
        response = await requestJson(`${graph}/${encodeURIComponent(input.externalPostId)}/comments`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
      } catch (error) {
        throw mapGraphError(error, "publish_failed");
      }
      const externalCommentId = stringField(response, "id");
      if (!externalCommentId) throw new OAuthError("publish_failed", undefined, { providerMessage: "Facebook accepted the comment but returned no ID." });
      return { externalCommentId };
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
