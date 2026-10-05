import { createHmac } from "node:crypto";
import { OAuthError } from "./errors";
import { ProviderHttpError, field, requestJson, stringField } from "./http";
import { FACEBOOK_COMMENT_SCOPE, FACEBOOK_MESSAGING_SCOPES, graphApiVersion } from "./providers/facebook";
import { INSTAGRAM_COMMENT_SCOPE, INSTAGRAM_MESSAGING_SCOPE } from "./providers/instagram";
import { YOUTUBE_COMMENT_SCOPE } from "./providers/youtube";
import type { Platform } from "./types";

/*
 * Reading and answering comments, per network, as plain functions (the provider adapters are left as they are).
 * Nothing here logs URLs or tokens. Whatever a network won't do is reported as an OAuthError the caller turns into an
 * honest message; nothing is ever invented.
 */

export interface InboxCredentials {
  externalAccountId: string;
  accessToken: string;
  scopes: string[];
  /** Facebook only: the app secret, used to sign Graph calls (appsecret_proof) the same way publishing does. */
  appSecret?: string;
  /** Instagram only: the account's own username, so its own replies aren't listed as new comments. */
  username?: string | null;
}

export interface NetworkComment {
  externalId: string;
  /** Top-level comment this one replies to; null for a top-level comment. */
  parentExternalId: string | null;
  authorName: string;
  authorAvatar: string | null;
  body: string;
  createdAt: Date;
  /** True when the account itself wrote it (its own replies are not inbox work). */
  fromSelf: boolean;
}

export const MAX_COMMENTS_PER_POST = 50;

/** Longest reply each network takes. */
export const REPLY_MAX_LENGTH: Record<Platform, number> = { facebook: 8000, instagram: 2200, youtube: 10000, linkedin: 0, twitter: 0 };

const COMMENT_SCOPE: Record<Platform, string | null> = {
  facebook: FACEBOOK_COMMENT_SCOPE,
  instagram: INSTAGRAM_COMMENT_SCOPE,
  youtube: YOUTUBE_COMMENT_SCOPE,
  linkedin: null,
  twitter: null,
};

/** Why a network's comments, messages or mentions are not read at all. */
const NOT_READ: Partial<Record<Platform, string>> = {
  twitter: "SocialFlow doesn't read replies, messages or mentions from X yet (X charges for every reading), so there is nothing from X here.",
};

export function inboxCommentScope(platform: Platform): string | null {
  return COMMENT_SCOPE[platform];
}

export type InboxSupport =
  | { state: "available"; reason: null }
  | { state: "permission_needed"; reason: string }
  | { state: "unavailable"; reason: string };

/** Whether an account can be read and answered, from what the network offers and the permissions it was connected with. */
export function inboxSupport(platform: Platform, scopes: string[], commentScopesOnServer: boolean): InboxSupport {
  const scope = COMMENT_SCOPE[platform];
  if (!scope) return { state: "unavailable", reason: NOT_READ[platform] ?? "LinkedIn doesn't give this app access to comments, so they can't be read or answered here." };
  if (scopes.includes(scope)) return { state: "available", reason: null };
  return {
    state: "permission_needed",
    reason: commentScopesOnServer
      ? `Reconnect this account and allow the ${scope} permission to read and answer comments.`
      : `Comment permissions (${scope}) aren't enabled on this server yet, so this account can't be asked for them. Set COMMENT_SCOPES_ENABLED=true once the app has the permission, then reconnect the account.`,
  };
}

function isoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function providerCode(body: unknown): number | undefined {
  const code = field(field(body, "error"), "code");
  return typeof code === "number" ? code : undefined;
}

/** Maps a failed call to an OAuthError; `insufficient_permissions` is what turns an account into "permission needed". */
function mapError(error: unknown, platform: Platform, fallback: OAuthError["code"]): OAuthError {
  if (error instanceof OAuthError) return error;
  if (!(error instanceof ProviderHttpError)) return new OAuthError(fallback);
  const body = error.body;
  const details = { providerMessage: stringField(field(body, "error"), "message") ?? undefined };
  if (platform === "youtube") {
    const reason = stringField(field<unknown[]>(field(body, "error"), "errors")?.[0], "reason");
    if (reason === "quotaExceeded" || reason === "rateLimitExceeded" || error.status === 429) return new OAuthError("rate_limited", undefined, details);
    if (error.status === 401) return new OAuthError("token_expired", undefined, details);
    if (error.status === 403) return new OAuthError("insufficient_permissions", undefined, details);
    return new OAuthError(fallback, undefined, details);
  }
  const code = providerCode(body);
  if (code === 190 || error.status === 401) return new OAuthError("token_revoked", undefined, details);
  if (code === 10 || (code !== undefined && code >= 200 && code < 300)) return new OAuthError("insufficient_permissions", undefined, details);
  if (code !== undefined && [4, 17, 32, 613].includes(code)) return new OAuthError("rate_limited", undefined, details);
  if (error.status === 429) return new OAuthError("rate_limited", undefined, details);
  return new OAuthError(fallback, undefined, details);
}

// ---------------------------------------------------------------------------------------------------- Facebook

const facebookGraph = () => `https://graph.facebook.com/${graphApiVersion()}`;
const proof = (creds: InboxCredentials) => (creds.appSecret ? createHmac("sha256", creds.appSecret).update(creds.accessToken).digest("hex") : null);

async function fetchFacebookComments(creds: InboxCredentials, externalPostId: string, limit: number): Promise<NetworkComment[]> {
  const url = new URL(`${facebookGraph()}/${encodeURIComponent(externalPostId)}/comments`);
  url.searchParams.set("fields", "id,message,created_time,from{id,name,picture{url}},parent{id}");
  // "stream" lists replies alongside top-level comments, each with its parent.
  url.searchParams.set("filter", "stream");
  url.searchParams.set("order", "reverse_chronological");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("access_token", creds.accessToken);
  const signed = proof(creds);
  if (signed) url.searchParams.set("appsecret_proof", signed);
  let body: unknown;
  try {
    body = await requestJson(url);
  } catch (error) {
    throw mapError(error, "facebook", "provider_error");
  }
  const out: NetworkComment[] = [];
  for (const row of field<unknown[]>(body, "data") ?? []) {
    const id = stringField(row, "id");
    const createdAt = isoDate(field(row, "created_time"));
    const text = stringField(row, "message");
    if (!id || !createdAt || !text) continue; // photo/sticker-only comments have no text to answer
    const from = field(row, "from");
    out.push({
      externalId: id,
      parentExternalId: stringField(field(row, "parent"), "id"),
      authorName: stringField(from, "name") ?? "Facebook user",
      authorAvatar: stringField(field(field(from, "picture"), "data"), "url"),
      body: text,
      createdAt,
      fromSelf: stringField(from, "id") === creds.externalAccountId,
    });
  }
  return out;
}

async function replyFacebook(creds: InboxCredentials, commentId: string, text: string): Promise<string> {
  const form = new URLSearchParams({ message: text, access_token: creds.accessToken });
  const signed = proof(creds);
  if (signed) form.set("appsecret_proof", signed);
  let body: unknown;
  try {
    body = await requestJson(`${facebookGraph()}/${encodeURIComponent(commentId)}/comments`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  } catch (error) {
    throw mapError(error, "facebook", "publish_failed");
  }
  const id = stringField(body, "id");
  if (!id) throw new OAuthError("publish_failed", undefined, { providerMessage: "Facebook accepted the reply but returned no ID." });
  return id;
}

// --------------------------------------------------------------------------------------------------- Instagram

const INSTAGRAM_GRAPH = "https://graph.instagram.com";

async function fetchInstagramComments(creds: InboxCredentials, mediaId: string, limit: number): Promise<NetworkComment[]> {
  const url = new URL(`${INSTAGRAM_GRAPH}/${encodeURIComponent(mediaId)}/comments`);
  url.searchParams.set("fields", "id,text,timestamp,username,replies{id,text,timestamp,username}");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("access_token", creds.accessToken);
  let body: unknown;
  try {
    body = await requestJson(url);
  } catch (error) {
    throw mapError(error, "instagram", "provider_error");
  }
  const own = creds.username?.toLowerCase() ?? null;
  const out: NetworkComment[] = [];
  const read = (row: unknown, parent: string | null) => {
    const id = stringField(row, "id");
    const createdAt = isoDate(field(row, "timestamp"));
    const text = stringField(row, "text");
    if (!id || !createdAt || !text) return;
    const username = stringField(row, "username");
    out.push({ externalId: id, parentExternalId: parent, authorName: username ?? "Instagram user", authorAvatar: null, body: text, createdAt, fromSelf: own !== null && username?.toLowerCase() === own });
  };
  for (const row of field<unknown[]>(body, "data") ?? []) {
    read(row, null);
    const id = stringField(row, "id");
    for (const reply of field<unknown[]>(field(row, "replies"), "data") ?? []) read(reply, id);
  }
  return out;
}

async function replyInstagram(creds: InboxCredentials, commentId: string, text: string): Promise<string> {
  let body: unknown;
  try {
    body = await requestJson(`${INSTAGRAM_GRAPH}/${encodeURIComponent(commentId)}/replies`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ message: text, access_token: creds.accessToken }) });
  } catch (error) {
    throw mapError(error, "instagram", "publish_failed");
  }
  const id = stringField(body, "id");
  if (!id) throw new OAuthError("publish_failed", undefined, { providerMessage: "Instagram accepted the reply but returned no ID." });
  return id;
}

// ----------------------------------------------------------------------------------------------------- YouTube

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

async function fetchYouTubeComments(creds: InboxCredentials, videoId: string, limit: number): Promise<NetworkComment[]> {
  const url = new URL(`${YOUTUBE_API}/commentThreads`);
  url.searchParams.set("part", "snippet,replies");
  url.searchParams.set("videoId", videoId);
  url.searchParams.set("maxResults", String(Math.min(limit, 100)));
  url.searchParams.set("order", "time");
  url.searchParams.set("textFormat", "plainText");
  let body: unknown;
  try {
    body = await requestJson(url, { headers: { authorization: `Bearer ${creds.accessToken}` } });
  } catch (error) {
    // Comments switched off on a video is a fact about that video, not a failure.
    if (error instanceof ProviderHttpError && error.status === 403) {
      const reason = stringField(field<unknown[]>(field(error.body, "error"), "errors")?.[0], "reason");
      if (reason === "commentsDisabled") return [];
    }
    throw mapError(error, "youtube", "provider_error");
  }
  const out: NetworkComment[] = [];
  const read = (comment: unknown, fallbackParent: string | null) => {
    const snippet = field(comment, "snippet");
    const id = stringField(comment, "id");
    const createdAt = isoDate(field(snippet, "publishedAt"));
    const text = stringField(snippet, "textDisplay") ?? stringField(snippet, "textOriginal");
    if (!id || !createdAt || !text) return;
    const authorChannel = stringField(field(snippet, "authorChannelId"), "value");
    out.push({
      externalId: id,
      parentExternalId: stringField(snippet, "parentId") ?? fallbackParent,
      authorName: stringField(snippet, "authorDisplayName") ?? "YouTube user",
      authorAvatar: stringField(snippet, "authorProfileImageUrl"),
      body: text,
      createdAt,
      fromSelf: authorChannel !== null && authorChannel === creds.externalAccountId,
    });
  };
  for (const thread of field<unknown[]>(body, "items") ?? []) {
    const top = field(field(thread, "snippet"), "topLevelComment");
    read(top, null);
    const topId = stringField(top, "id");
    for (const reply of field<unknown[]>(field(thread, "replies"), "comments") ?? []) read(reply, topId);
  }
  return out;
}

async function replyYouTube(creds: InboxCredentials, parentCommentId: string, text: string): Promise<string> {
  let body: unknown;
  try {
    body = await requestJson(`${YOUTUBE_API}/comments?part=snippet`, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ snippet: { parentId: parentCommentId, textOriginal: text } }),
    });
  } catch (error) {
    throw mapError(error, "youtube", "publish_failed");
  }
  const id = stringField(body, "id");
  if (!id) throw new OAuthError("publish_failed", undefined, { providerMessage: "YouTube accepted the reply but returned no ID." });
  return id;
}

// ------------------------------------------------------------------------------------------------ Entry points

/** Comments under one published post or video (the network's own ID for it). Throws OAuthError. */
export async function fetchComments(platform: Platform, creds: InboxCredentials, input: { externalPostId: string; limit?: number }): Promise<NetworkComment[]> {
  const limit = Math.min(Math.max(input.limit ?? MAX_COMMENTS_PER_POST, 1), MAX_COMMENTS_PER_POST);
  if (platform === "facebook") return fetchFacebookComments(creds, input.externalPostId, limit);
  if (platform === "instagram") return fetchInstagramComments(creds, input.externalPostId, limit);
  if (platform === "youtube") return fetchYouTubeComments(creds, input.externalPostId, limit);
  throw new OAuthError("publish_unsupported", NOT_READ[platform] ?? "LinkedIn doesn't give this app access to comments.");
}

/**
 * Replies under a comment. `externalCommentId` must be a top-level comment: the caller passes the parent of a reply, since
 * none of these networks nests deeper. Returns the network's ID for the new reply. Throws OAuthError.
 */
export async function replyToComment(platform: Platform, creds: InboxCredentials, input: { externalCommentId: string; text: string }): Promise<{ externalId: string }> {
  if (platform === "facebook") return { externalId: await replyFacebook(creds, input.externalCommentId, input.text) };
  if (platform === "instagram") return { externalId: await replyInstagram(creds, input.externalCommentId, input.text) };
  if (platform === "youtube") return { externalId: await replyYouTube(creds, input.externalCommentId, input.text) };
  throw new OAuthError("publish_unsupported", NOT_READ[platform] ?? "LinkedIn doesn't give this app access to comments.");
}

// ================================================================================ Direct messages and mentions

/** Meta's standard messaging window: a Page or account may answer a person only within 24 hours of their last message. */
export const MESSAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_CONVERSATIONS_PER_ACCOUNT = 20;
export const MAX_MESSAGES_PER_CONVERSATION = 25;
export const MAX_MENTIONS_PER_ACCOUNT = 25;
/** Longest direct message each network takes (Messenger 2000, Instagram 1000 characters of text). */
export const MESSAGE_MAX_LENGTH: Record<Platform, number> = { facebook: 2000, instagram: 1000, youtube: 0, linkedin: 0, twitter: 0 };

export interface NetworkMessage {
  externalId: string;
  authorName: string;
  body: string;
  createdAt: Date;
  fromSelf: boolean;
}

export interface NetworkThread {
  threadId: string;
  /** The other person's ID on the network: the recipient of a reply. Null when the network didn't list one. */
  participantId: string | null;
  participantName: string;
  messages: NetworkMessage[];
}

export interface NetworkMention {
  externalId: string;
  authorName: string;
  authorAvatar: string | null;
  body: string;
  createdAt: Date;
  permalink: string | null;
}

export interface WindowState {
  canReply: boolean;
  /** When the window closes (last inbound message + 24h); null when the person hasn't written. */
  replyWindowEndsAt: Date | null;
}

/** Whether a reply is allowed now, from the time of the person's most recent message. */
export function replyWindow(lastInboundAt: Date | null, now: Date = new Date()): WindowState {
  if (!lastInboundAt) return { canReply: false, replyWindowEndsAt: null };
  const endsAt = new Date(lastInboundAt.getTime() + MESSAGE_WINDOW_MS);
  return { canReply: now.getTime() < endsAt.getTime(), replyWindowEndsAt: endsAt };
}

export const WINDOW_CLOSED_MESSAGE = "This conversation is outside Meta's 24-hour messaging window: replies are only allowed within 24 hours of the person's last message, so nothing was sent.";

const MESSAGING_SCOPES: Record<Platform, string[] | null> = {
  facebook: FACEBOOK_MESSAGING_SCOPES,
  instagram: [INSTAGRAM_MESSAGING_SCOPE],
  youtube: null,
  linkedin: null,
  twitter: null,
};

export function inboxMessagingScopes(platform: Platform): string[] | null {
  return MESSAGING_SCOPES[platform];
}

/** Direct messages: from what the network offers, the permissions the account was connected with, and the server switch. */
export function messagingSupport(platform: Platform, scopes: string[], flagOn: boolean): InboxSupport {
  const needed = MESSAGING_SCOPES[platform];
  if (!needed) {
    return { state: "unavailable", reason: NOT_READ[platform] ?? (platform === "youtube" ? "YouTube has no direct message API, so there are no messages to read or answer." : "LinkedIn doesn't give this app access to messages.") };
  }
  if (!flagOn) {
    return { state: "permission_needed", reason: `Messaging permissions (${needed.join(", ")}) aren't enabled on this server. Set MESSAGING_SCOPES_ENABLED=true once the app has passed Meta's review for them, then reconnect the account.` };
  }
  const missing = needed.filter((scope) => !scopes.includes(scope));
  if (missing.length === 0) return { state: "available", reason: null };
  return { state: "permission_needed", reason: `Reconnect this account and allow the ${missing.join(" and ")} permission${missing.length > 1 ? "s" : ""} to read and answer messages.` };
}

/**
 * Mentions. Facebook: posts the Page is tagged in (pages_read_engagement, already part of connecting). Instagram: media the
 * account is tagged in (instagram_business_basic, already part of connecting). Instagram's API does NOT return @mentions in
 * captions or comments of other people's posts (that needs webhooks), and YouTube and LinkedIn have no mentions API.
 */
export function mentionsSupport(platform: Platform, scopes: string[], flagOn: boolean): InboxSupport {
  if (platform === "youtube") return { state: "unavailable", reason: "YouTube has no mentions API, so mentions of this channel can't be read." };
  if (platform === "linkedin") return { state: "unavailable", reason: "LinkedIn doesn't give this app access to mentions." };
  if (platform === "twitter") return { state: "unavailable", reason: NOT_READ.twitter! };
  const scope = platform === "facebook" ? "pages_read_engagement" : "instagram_business_basic";
  if (!flagOn) return { state: "permission_needed", reason: "Mentions are collected only when MESSAGING_SCOPES_ENABLED=true on this server." };
  if (!scopes.includes(scope)) return { state: "permission_needed", reason: `Reconnect this account and allow the ${scope} permission to read mentions.` };
  return { state: "available", reason: null };
}

/** Whether a mention can be answered from here, and why not. Facebook: as a comment under the tagged post. */
export function mentionReplySupport(platform: Platform): { supported: boolean; reason: string | null } {
  if (platform === "facebook") return { supported: true, reason: null };
  if (platform === "instagram") return { supported: false, reason: "Instagram's API doesn't allow commenting on posts you're tagged in, so open the post on Instagram to answer." };
  return { supported: false, reason: "This network has no mentions to answer." };
}

function threadFromRow(row: unknown, threadId: string, ownIds: string[], ownName: string | null): NetworkThread {
  const isOwn = (id: string | null, name: string | null) => (id !== null && ownIds.includes(id)) || (ownName !== null && name !== null && name.toLowerCase() === ownName);
  const people = (field<unknown[]>(field(row, "participants"), "data") ?? []).map((p) => ({ id: stringField(p, "id"), name: stringField(p, "name") ?? stringField(p, "username") }));
  const other = people.find((p) => !isOwn(p.id, p.name)) ?? null;
  const messages: NetworkMessage[] = [];
  for (const m of field<unknown[]>(field(row, "messages"), "data") ?? []) {
    const id = stringField(m, "id");
    const createdAt = isoDate(field(m, "created_time"));
    const text = stringField(m, "message");
    if (!id || !createdAt || !text) continue; // attachment-only messages (stickers, images) carry no text
    const from = field(m, "from");
    const fromName = stringField(from, "name") ?? stringField(from, "username");
    const fromSelf = isOwn(stringField(from, "id"), fromName);
    messages.push({ externalId: id, authorName: fromName ?? (fromSelf ? "You" : other?.name ?? "Unknown"), body: text, createdAt, fromSelf });
  }
  return { threadId, participantId: other?.id ?? null, participantName: other?.name ?? "Unknown", messages };
}

const MESSAGE_FIELDS = "id,message,from,created_time";

async function fetchFacebookConversations(creds: InboxCredentials, limit: number): Promise<NetworkThread[]> {
  const url = new URL(`${facebookGraph()}/${encodeURIComponent(creds.externalAccountId)}/conversations`);
  url.searchParams.set("fields", `participants,updated_time,messages.limit(${MAX_MESSAGES_PER_CONVERSATION}){${MESSAGE_FIELDS}}`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("access_token", creds.accessToken);
  const signed = proof(creds);
  if (signed) url.searchParams.set("appsecret_proof", signed);
  let body: unknown;
  try {
    body = await requestJson(url);
  } catch (error) {
    throw mapError(error, "facebook", "provider_error");
  }
  const out: NetworkThread[] = [];
  for (const row of (field<unknown[]>(body, "data") ?? []).slice(0, limit)) {
    const id = stringField(row, "id");
    if (id) out.push(threadFromRow(row, id, [creds.externalAccountId], null));
  }
  return out;
}

async function fetchInstagramConversations(creds: InboxCredentials, limit: number): Promise<NetworkThread[]> {
  const list = new URL(`${INSTAGRAM_GRAPH}/me/conversations`);
  list.searchParams.set("platform", "instagram");
  list.searchParams.set("limit", String(limit));
  list.searchParams.set("access_token", creds.accessToken);
  let listing: unknown;
  try {
    listing = await requestJson(list);
  } catch (error) {
    throw mapError(error, "instagram", "provider_error");
  }
  const own = creds.username?.toLowerCase() ?? null;
  const out: NetworkThread[] = [];
  for (const row of (field<unknown[]>(listing, "data") ?? []).slice(0, limit)) {
    const conversationId = stringField(row, "id");
    if (!conversationId) continue;
    const detail = new URL(`${INSTAGRAM_GRAPH}/${encodeURIComponent(conversationId)}`);
    detail.searchParams.set("fields", `participants,messages.limit(${MAX_MESSAGES_PER_CONVERSATION}){${MESSAGE_FIELDS}}`);
    detail.searchParams.set("access_token", creds.accessToken);
    let body: unknown;
    try {
      body = await requestJson(detail);
    } catch (error) {
      throw mapError(error, "instagram", "provider_error");
    }
    out.push(threadFromRow(body, conversationId, [creds.externalAccountId], own));
  }
  return out;
}

/** Recent conversations with their latest messages (capped). Throws OAuthError; `insufficient_permissions` means the permission isn't granted. */
export async function fetchConversations(platform: Platform, creds: InboxCredentials, input: { limit?: number } = {}): Promise<NetworkThread[]> {
  const limit = Math.min(Math.max(input.limit ?? MAX_CONVERSATIONS_PER_ACCOUNT, 1), MAX_CONVERSATIONS_PER_ACCOUNT);
  if (platform === "facebook") return fetchFacebookConversations(creds, limit);
  if (platform === "instagram") return fetchInstagramConversations(creds, limit);
  throw new OAuthError("publish_unsupported", "This network has no direct message API.");
}

/** Answers a person in a conversation. The caller has already checked the 24-hour window. Returns the network's message ID. */
export async function sendDirectMessage(platform: Platform, creds: InboxCredentials, input: { recipientId: string; text: string }): Promise<{ externalId: string }> {
  let body: unknown;
  if (platform === "facebook") {
    const form = new URLSearchParams({
      recipient: JSON.stringify({ id: input.recipientId }),
      messaging_type: "RESPONSE",
      message: JSON.stringify({ text: input.text }),
      access_token: creds.accessToken,
    });
    const signed = proof(creds);
    if (signed) form.set("appsecret_proof", signed);
    try {
      body = await requestJson(`${facebookGraph()}/${encodeURIComponent(creds.externalAccountId)}/messages`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    } catch (error) {
      throw mapError(error, "facebook", "publish_failed");
    }
  } else if (platform === "instagram") {
    try {
      body = await requestJson(`${INSTAGRAM_GRAPH}/me/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${creds.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ recipient: { id: input.recipientId }, message: { text: input.text } }),
      });
    } catch (error) {
      throw mapError(error, "instagram", "publish_failed");
    }
  } else {
    throw new OAuthError("publish_unsupported", "This network has no direct message API.");
  }
  const id = stringField(body, "message_id");
  if (!id) throw new OAuthError("publish_failed", undefined, { providerMessage: "The network accepted the message but returned no ID." });
  return { externalId: id };
}

/** Posts or media the account is tagged in (capped). Throws OAuthError. Only what the network returns is used. */
export async function fetchMentions(platform: Platform, creds: InboxCredentials, input: { limit?: number } = {}): Promise<NetworkMention[]> {
  const limit = Math.min(Math.max(input.limit ?? MAX_MENTIONS_PER_ACCOUNT, 1), MAX_MENTIONS_PER_ACCOUNT);
  if (platform === "facebook") {
    const url = new URL(`${facebookGraph()}/${encodeURIComponent(creds.externalAccountId)}/tagged`);
    url.searchParams.set("fields", "id,message,created_time,permalink_url,from{id,name,picture{url}}");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("access_token", creds.accessToken);
    const signed = proof(creds);
    if (signed) url.searchParams.set("appsecret_proof", signed);
    let body: unknown;
    try {
      body = await requestJson(url);
    } catch (error) {
      throw mapError(error, "facebook", "provider_error");
    }
    const out: NetworkMention[] = [];
    for (const row of field<unknown[]>(body, "data") ?? []) {
      const id = stringField(row, "id");
      const createdAt = isoDate(field(row, "created_time"));
      if (!id || !createdAt) continue;
      const from = field(row, "from");
      if (stringField(from, "id") === creds.externalAccountId) continue;
      out.push({ externalId: id, authorName: stringField(from, "name") ?? "Facebook user", authorAvatar: stringField(field(field(from, "picture"), "data"), "url"), body: stringField(row, "message") ?? "", createdAt, permalink: stringField(row, "permalink_url") });
    }
    return out;
  }
  if (platform === "instagram") {
    const url = new URL(`${INSTAGRAM_GRAPH}/me/tags`);
    url.searchParams.set("fields", "id,caption,permalink,timestamp,username");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("access_token", creds.accessToken);
    let body: unknown;
    try {
      body = await requestJson(url);
    } catch (error) {
      throw mapError(error, "instagram", "provider_error");
    }
    const own = creds.username?.toLowerCase() ?? null;
    const out: NetworkMention[] = [];
    for (const row of field<unknown[]>(body, "data") ?? []) {
      const id = stringField(row, "id");
      const createdAt = isoDate(field(row, "timestamp"));
      if (!id || !createdAt) continue;
      const username = stringField(row, "username");
      if (own !== null && username?.toLowerCase() === own) continue;
      out.push({ externalId: id, authorName: username ?? "Instagram user", authorAvatar: null, body: stringField(row, "caption") ?? "", createdAt, permalink: stringField(row, "permalink") });
    }
    return out;
  }
  throw new OAuthError("publish_unsupported", "This network has no mentions API.");
}

/** Answers a Facebook mention as a comment from the Page under the tagged post. */
export async function replyToMention(platform: Platform, creds: InboxCredentials, input: { externalPostId: string; text: string }): Promise<{ externalId: string }> {
  if (platform === "facebook") return { externalId: await replyFacebook(creds, input.externalPostId, input.text) };
  throw new OAuthError("publish_unsupported", mentionReplySupport(platform).reason ?? "Mentions can't be answered on this network.");
}
