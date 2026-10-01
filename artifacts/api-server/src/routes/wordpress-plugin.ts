import { Router, type IRouter, type RequestHandler, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { automationItemsTable, automationsTable, db, wordpressConnectionsTable, type Automation, type WordPressConnection } from "@workspace/db";
import { recordAudit } from "../lib/audit";
import { ingestPushedItem } from "../lib/automations";
import { jsonError } from "../lib/http-errors";
import {
  authenticatePlugin,
  connectionSummary,
  describeOutcome,
  pluginPostsPerHour,
  postsInLastHour,
  readPost,
  readSite,
  recentShares,
  type RawBodyRequest,
} from "../lib/wordpress-plugin";
import { rateLimit } from "../middlewares/rate-limit";

/*
 * The endpoints the SocialFlow WordPress plugin calls. There is no session here: every request is signed with the
 * connection key (lib/wordpress-plugin.ts). All four are POSTs with a JSON body, so the signature always covers one.
 *
 *   connect     the plugin was given a key: record its site and answer with what it is connected to
 *   status      the same answer plus the latest shares, for the plugin's settings page
 *   posts       a post was published on the site: make its social post (once)
 *   disconnect  the WordPress admin disconnected the plugin
 */

const router: IRouter = Router();
// A coarse shield only. What one site may send is limited per connection (pluginPostsPerHour), not per address,
// because requests that come through a shared proxy all arrive from the proxy's address.
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: Number(process.env.WORDPRESS_PLUGIN_RATE_LIMIT ?? 600), keyPrefix: "wordpress-plugin" });

type Authed = { connection: WordPressConnection; automation: Automation };

/** Runs a handler for a correctly signed request and always answers in JSON, which is all the plugin reads. */
const signed = (handler: (auth: Authed, body: Record<string, unknown>, res: Response) => Promise<void>): RequestHandler => async (req, res) => {
  try {
    const auth = await authenticatePlugin(req as RawBodyRequest);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, message: auth.message, ...(auth.serverTime ? { serverTime: auth.serverTime } : {}) });
      return;
    }
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
    await handler({ connection: auth.connection, automation: auth.automation }, body, res);
  } catch (error) {
    req.log.error({ err: error }, "A WordPress plugin request failed");
    if (!res.headersSent) jsonError(res, 500, "server_error", "SocialFlow couldn't handle the request. It will work again shortly.");
  }
};

const notConnected = (res: Response) => jsonError(res, 409, "not_connected", "This site isn't connected in SocialFlow any more. Connect the plugin again with its connection key.");

router.post("/wordpress-plugin/connect", limiter, signed(async ({ connection, automation }, body, res) => {
  const site = readSite(body.site);
  if (!site.url) return jsonError(res, 400, "invalid_site", "The plugin didn't say which site it is on.");
  const now = new Date();
  const [updated] = await db
    .update(wordpressConnectionsTable)
    .set({ status: "connected", siteUrl: site.url, siteName: site.name, wpVersion: site.wpVersion, pluginVersion: site.pluginVersion, connectedAt: connection.status === "connected" && connection.connectedAt ? connection.connectedAt : now, lastSeenAt: now })
    .where(eq(wordpressConnectionsTable.id, connection.id))
    .returning();
  // The automation shows the site it is connected to, like the address of a polled source.
  const [renamed] = await db.update(automationsTable).set({ sourceUrl: site.url }).where(eq(automationsTable.id, automation.id)).returning();
  if (connection.status !== "connected" || connection.siteUrl !== site.url) {
    await recordAudit({ workspaceId: automation.workspaceId, actorUserId: null, action: "automation.plugin_connected", target: automation.id, detail: { site: site.url, pluginVersion: site.pluginVersion } });
  }
  res.json({ connection: await connectionSummary(updated!, renamed ?? automation) });
}));

router.post("/wordpress-plugin/status", limiter, signed(async ({ connection, automation }, body, res) => {
  if (connection.status !== "connected") return notConnected(res);
  const site = readSite(body.site);
  const [updated] = await db
    .update(wordpressConnectionsTable)
    .set({ lastSeenAt: new Date(), ...(site.wpVersion ? { wpVersion: site.wpVersion } : {}), ...(site.pluginVersion ? { pluginVersion: site.pluginVersion } : {}) })
    .where(eq(wordpressConnectionsTable.id, connection.id))
    .returning();
  res.json({ connection: await connectionSummary(updated!, automation), recent: await recentShares(automation.id) });
}));

router.post("/wordpress-plugin/posts", limiter, signed(async ({ connection, automation }, body, res) => {
  if (connection.status !== "connected") return notConnected(res);
  const now = new Date();
  await db.update(wordpressConnectionsTable).set({ lastSeenAt: now }).where(eq(wordpressConnectionsTable.id, connection.id));
  // Paused in SocialFlow means the same as switched off in WordPress: the post is not shared, and not held for later.
  if (automation.status !== "active") {
    res.json({ result: "skipped", message: "Sharing is paused in SocialFlow, so this post wasn't sent to the accounts.", post: null });
    return;
  }
  const read = readPost(body.post, connection.siteUrl);
  if ("error" in read) return jsonError(res, 422, "invalid_post", read.error);

  const [known] = await db.select({ id: automationItemsTable.id }).from(automationItemsTable).where(and(eq(automationItemsTable.automationId, automation.id), eq(automationItemsTable.itemKey, read.item.key)));
  const limit = pluginPostsPerHour();
  if (!known && (await postsInLastHour(automation.id, now)) >= limit) {
    res.setHeader("Retry-After", "900");
    return jsonError(res, 429, "rate_limited", `SocialFlow takes up to ${limit} posts an hour from one site. This one will be tried again later.`);
  }

  const siteName = connection.siteName ?? (connection.siteUrl ? new URL(connection.siteUrl).hostname.replace(/^www\./, "") : automation.name);
  const outcome = await ingestPushedItem(automation, read.item, siteName, { manual: body.manual === true }, now);
  if (outcome.result === "created") await db.update(wordpressConnectionsTable).set({ lastPostAt: now }).where(eq(wordpressConnectionsTable.id, connection.id));
  res.json({
    result: outcome.result,
    message: await describeOutcome(automation, outcome),
    post: outcome.result === "created" ? { status: outcome.postStatus, scheduledAt: outcome.scheduledAt } : null,
  });
}));

router.post("/wordpress-plugin/disconnect", limiter, signed(async ({ connection, automation }, _body, res) => {
  if (connection.status !== "disconnected") {
    await db.update(wordpressConnectionsTable).set({ status: "disconnected", lastSeenAt: new Date() }).where(eq(wordpressConnectionsTable.id, connection.id));
    await recordAudit({ workspaceId: automation.workspaceId, actorUserId: null, action: "automation.plugin_disconnected", target: automation.id, detail: { site: connection.siteUrl } });
  }
  res.json({ ok: true });
}));

export default router;
