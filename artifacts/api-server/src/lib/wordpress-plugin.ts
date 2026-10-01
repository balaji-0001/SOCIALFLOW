import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import {
  automationItemsTable,
  automationsTable,
  connectedAccountsTable,
  db,
  postsTable,
  wordpressConnectionsTable,
  workspacesTable,
  type Automation,
  type WordPressConnection,
} from "@workspace/db";
import { isApprovalRequired } from "./approvals";
import { normalizeConfig, type PushOutcome } from "./automations";
import { decryptSecret, encryptSecret, randomToken } from "./crypto";
import { normalizeItemKey, truncateText, type FeedItem } from "./feeds";
import { MAX_LINK_URL_LENGTH } from "./post-extras";
import { getRedirectBaseUrl } from "./oauth/config";

/*
 * The SocialFlow WordPress plugin's side of a "wordpress_plugin" automation.
 *
 * A connection key is shown once in SocialFlow and pasted into the plugin. It carries this API's address, a key id
 * and a secret. The secret never travels again: every request from the plugin is signed with it,
 *
 *   X-SocialFlow-Key:        the key id
 *   X-SocialFlow-Timestamp:  Unix seconds
 *   X-SocialFlow-Signature:  v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
 *
 * so a request can't be forged or altered, and one captured in transit stops working after ten minutes (and a
 * replayed post is a duplicate anyway). Replacing the key in SocialFlow cuts the old plugin off at once.
 */

export const CONNECTION_KEY_PREFIX = "sfwp1_";
export const SIGNATURE_TOLERANCE_SECONDS = 600;
const KEY_ID = /^wpk_[0-9a-f]{24}$/;
const SIGNATURE = /^v1=([0-9a-f]{64})$/;
const MAX_TITLE = 300;
const MAX_EXCERPT = 1_000;

export type RawBodyRequest = Request & { rawBody?: Buffer };

/** Posts accepted from one site in an hour. A bulk publish or an import on the site can't flood the accounts. */
export function pluginPostsPerHour(): number {
  const raw = Number(process.env.WORDPRESS_PLUGIN_POSTS_PER_HOUR);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 30;
}

const secretContext = (automationId: string) => `wordpress-connection:${automationId}`;

export function newKeyMaterial(automationId: string): { keyId: string; secret: string; secretEncrypted: string } {
  const secret = randomToken(32);
  return { keyId: `wpk_${randomBytes(12).toString("hex")}`, secret, secretEncrypted: encryptSecret(secret, secretContext(automationId)) };
}

/** What the user pastes into the plugin: where this API is, which key, and its secret. */
export function encodeConnectionKey(apiBase: string, keyId: string, secret: string): string {
  return CONNECTION_KEY_PREFIX + Buffer.from(`${apiBase}\n${keyId}\n${secret}`, "utf8").toString("base64url");
}

export function signPayload(secret: string, timestamp: string, body: Buffer | string): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
}

/**
 * The address the plugin must call. It is the address the person is using SocialFlow at (the browser's Origin) when
 * that is this installation's own address: the configured public address, the host this request came to, or a local
 * development address. Any other Origin is ignored and the configured public address is used, so a key never points
 * a site's posts at somebody else's server.
 */
export function publicApiBase(req: Request): string | null {
  const configured = getRedirectBaseUrl();
  let origin: URL | null = null;
  try {
    const parsed = new URL(req.get("origin") ?? "");
    if (parsed.protocol === "https:" || parsed.protocol === "http:") origin = parsed;
  } catch { /* no usable Origin */ }
  if (origin) {
    const local = origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
    const own = origin.host === req.get("host") || origin.host === req.get("x-forwarded-host");
    if (local || own || origin.origin === configured) return `${origin.origin}/api`;
  }
  if (configured) return `${configured}/api`;
  const host = req.get("host");
  return host ? `${req.protocol}://${host}/api` : null;
}

export type PluginAuth =
  | { ok: true; connection: WordPressConnection; automation: Automation }
  | { ok: false; status: number; error: string; message: string; serverTime?: number };

/** Checks the three headers against the stored key. The reason for a refusal is only specific once the signature is good. */
export async function authenticatePlugin(req: RawBodyRequest, now = new Date()): Promise<PluginAuth> {
  const refused = { ok: false as const, status: 401, error: "bad_signature", message: "The request's signature isn't valid." };
  const keyId = req.get("x-socialflow-key") ?? "";
  const timestamp = req.get("x-socialflow-timestamp") ?? "";
  const signature = SIGNATURE.exec(req.get("x-socialflow-signature") ?? "")?.[1];
  if (!KEY_ID.test(keyId) || !/^\d{9,12}$/.test(timestamp) || !signature) return refused;

  const [row] = await db
    .select({ connection: wordpressConnectionsTable, automation: automationsTable })
    .from(wordpressConnectionsTable)
    .innerJoin(automationsTable, eq(automationsTable.id, wordpressConnectionsTable.automationId))
    .where(eq(wordpressConnectionsTable.keyId, keyId));
  if (!row) return { ok: false, status: 401, error: "unknown_key", message: "This connection key is no longer valid. Create a new one in SocialFlow and connect again." };

  let secret: string;
  try {
    secret = decryptSecret(row.connection.secretEncrypted, secretContext(row.automation.id));
  } catch {
    return { ok: false, status: 401, error: "unknown_key", message: "This connection key can't be used any more. Create a new one in SocialFlow and connect again." };
  }
  const expected = Buffer.from(signPayload(secret, timestamp, req.rawBody ?? Buffer.alloc(0)), "hex");
  const given = Buffer.from(signature, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return refused;

  const serverTime = Math.floor(now.getTime() / 1000);
  if (Math.abs(serverTime - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, status: 401, error: "stale_timestamp", message: "The request's time is more than 10 minutes away from SocialFlow's. Check the clock on the WordPress server.", serverTime };
  }
  return { ok: true, connection: row.connection, automation: row.automation };
}

/* ---------- what the plugin tells us ---------- */

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  // Control characters (other than a line break) have no place in a title or a name.
  const clean = value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
};

const webAddress = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > MAX_LINK_URL_LENGTH) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

export type PluginSite = { url: string | null; name: string | null; wpVersion: string | null; pluginVersion: string | null };

export function readSite(raw: unknown): PluginSite {
  const site = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const address = webAddress(site.url);
  return { url: address ? address.replace(/\/+$/, "") : null, name: text(site.name, 200), wpVersion: text(site.wpVersion, 40), pluginVersion: text(site.pluginVersion, 40) };
}

/** The post as an automation item, or why it can't be one. Text arrives as plain text; nothing here is fetched. */
export function readPost(raw: unknown, siteUrl: string | null): { item: FeedItem } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "The request has no post." };
  const post = raw as Record<string, unknown>;
  const url = webAddress(post.url);
  if (!url) return { error: "The post has no web address (url must start with http:// or https://)." };
  const id = typeof post.id === "number" || typeof post.id === "string" ? String(post.id).trim().replace(/[^\w-]/g, "").slice(0, 40) : "";
  // The same identity a feed gives the post: WordPress's guid. Without one, the guid WordPress would give it by
  // default (the site and the post's number), so a changed permalink is still the same post.
  const guid = text(post.guid, 500);
  const key = normalizeItemKey(guid ?? (id ? `${siteUrl ?? new URL(url).origin}/?p=${id}` : url));
  const title = (text(post.title, 2_000) ?? "").replace(/\s+/g, " ").slice(0, MAX_TITLE);
  const excerpt = truncateText((text(post.excerpt, 20_000) ?? "").replace(/\s+/g, " "), MAX_EXCERPT);
  const published = typeof post.publishedAt === "string" ? new Date(post.publishedAt) : null;
  return {
    item: {
      key,
      title,
      url,
      publishedAt: published && !Number.isNaN(published.getTime()) ? published : null,
      imageUrl: webAddress(post.imageUrl),
      excerpt,
      author: text(post.author, 200),
    },
  };
}

/* ---------- what we tell the plugin ---------- */

export async function connectionSummary(connection: WordPressConnection, automation: Automation) {
  const config = normalizeConfig(automation.config);
  const [workspace] = await db.select({ name: workspacesTable.name }).from(workspacesTable).where(eq(workspacesTable.id, automation.workspaceId));
  const accounts = config.connectedAccountIds.length === 0 ? [] : await db
    .select({ id: connectedAccountsTable.id, name: connectedAccountsTable.displayName, platform: connectedAccountsTable.platform, status: connectedAccountsTable.status })
    .from(connectedAccountsTable)
    .where(and(eq(connectedAccountsTable.workspaceId, automation.workspaceId), inArray(connectedAccountsTable.id, config.connectedAccountIds)));
  const [posted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(automationItemsTable)
    .where(and(eq(automationItemsTable.automationId, automation.id), eq(automationItemsTable.status, "posted")));
  const base = getRedirectBaseUrl();
  return {
    status: connection.status,
    workspaceName: workspace?.name ?? "",
    automationName: automation.name,
    automationStatus: automation.status,
    mode: config.mode,
    accounts: config.connectedAccountIds
      .map((id) => accounts.find((account) => account.id === id))
      .filter((account): account is NonNullable<typeof account> => Boolean(account))
      .map(({ name, platform, status }) => ({ name, platform, status })),
    postsCreated: Number(posted?.total ?? 0),
    dashboardUrl: base ? `${base}/automations` : null,
  };
}

/** The latest posts the plugin sent and what became of each in SocialFlow. */
export async function recentShares(automationId: string, limit = 10) {
  const rows = await db
    .select({
      title: automationItemsTable.title, url: automationItemsTable.url, status: automationItemsTable.status, error: automationItemsTable.error,
      createdAt: automationItemsTable.createdAt, postStatus: postsTable.status, postScheduledAt: postsTable.scheduledAt,
    })
    .from(automationItemsTable)
    .leftJoin(postsTable, eq(postsTable.id, automationItemsTable.postId))
    .where(and(eq(automationItemsTable.automationId, automationId), ne(automationItemsTable.status, "seen")))
    .orderBy(desc(automationItemsTable.createdAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, postStatus: row.postStatus ?? null, postScheduledAt: row.postScheduledAt ?? null }));
}

export async function postsInLastHour(automationId: string, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(automationItemsTable)
    .where(and(eq(automationItemsTable.automationId, automationId), gt(automationItemsTable.createdAt, new Date(now.getTime() - 3600_000))));
  return Number(row?.total ?? 0);
}

/** Words for the WordPress admin: what happened to the post they just published. */
export async function describeOutcome(automation: Automation, outcome: PushOutcome): Promise<string> {
  if (outcome.result === "duplicate") return "Already shared. SocialFlow has this post, so it wasn't sent again.";
  if (outcome.result === "failed") return outcome.message;
  if (outcome.postStatus === "draft") return outcome.note ?? "Saved as a draft in SocialFlow. Nothing is sent until it is reviewed there.";
  const waits = await isApprovalRequired(automation.workspaceId);
  if (waits) return "Sent to SocialFlow. The workspace requires approval, so it is published once it has been approved there.";
  return normalizeConfig(automation.config).mode === "queue" ? "Sent to SocialFlow and added to the queue." : "Sent to SocialFlow. It is published within about a minute.";
}
