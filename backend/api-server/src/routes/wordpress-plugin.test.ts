import { createHmac } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CreateAutomationResponse, ListAutomationsResponse, ReplaceAutomationPluginKeyResponse, WordpressPluginConnectResponse, WordpressPluginPostResponse, WordpressPluginStatusResponse } from "@workspace/api-zod";
import { auditLogTable, automationItemsTable, automationsTable, db, tableExists, usersTable, wordpressConnectionsTable, workspacesTable } from "@workspace/db";
import { claimDueAutomations, runAutomation } from "../lib/automations";
import { saveConnectedAccount } from "../lib/oauth/accounts";
import type { Platform } from "../lib/oauth/types";
import { encodeConnectionKey, readPost, signPayload } from "../lib/wordpress-plugin";

// The WordPress plugin integration: a plugin automation and its connection key, the signed requests the plugin makes
// (connect, status, posts, disconnect), duplicate protection, and what cuts a plugin off. Nothing here reaches a
// network: the plugin's requests are made by the tests, signed the way the plugin signs them.

vi.hoisted(() => {
  process.env.AUTOMATION_RUN_RATE_LIMIT = "1000";
  process.env.WORDPRESS_PLUGIN_RATE_LIMIT = "100000";
});
const { default: app } = await import("../app");

const tablesExist = await tableExists("socialflow_wordpress_connections").catch(() => false);
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;

async function signup() {
  const agent = request.agent(app);
  const email = `wp-plugin-${Date.now()}-${counter++}@socialflow.test`;
  const res = await agent.post("/api/auth/signup").send({ email, password: "correct horse battery staple", displayName: "Tester" });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return { agent, email, workspaceId: res.body.workspace.id as string };
}

async function addMember(owner: Awaited<ReturnType<typeof signup>>, role: string) {
  const member = await signup();
  const invite = await owner.agent.post("/api/team/invitations").send({ email: member.email, role });
  expect(invite.status).toBe(201);
  const token = /token=([A-Za-z0-9_-]+)/.exec(invite.body.inviteUrl)![1]!;
  expect((await member.agent.post(`/api/invitations/${token}/accept`)).status).toBe(200);
  return member;
}

async function account(workspaceId: string, platform: Platform = "facebook", name = "Acme Page") {
  return saveConnectedAccount(db, workspaceId, platform, {
    externalAccountId: `ext-${counter++}`, accountType: `${platform}_account`, displayName: name, username: null, avatarUrl: null, accessToken: "TOKEN",
    refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: [], metadata: {}, selectable: true, warnings: [],
  }, "u");
}

type Key = { apiBase: string; keyId: string; secret: string };

function decodeKey(connectionKey: string): Key {
  expect(connectionKey).toMatch(/^sfwp1_[A-Za-z0-9_-]+$/);
  const [apiBase, keyId, secret] = Buffer.from(connectionKey.slice(6), "base64url").toString("utf8").split("\n");
  return { apiBase: apiBase!, keyId: keyId!, secret: secret! };
}

/** One request the way the plugin makes it: the exact bytes sent are the bytes signed. */
function plugin(key: Key, path: string, body: unknown, forged: { timestamp?: number; signWith?: string; signBody?: string; keyId?: string; signature?: string } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(forged.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = forged.signature ?? `v1=${createHmac("sha256", forged.signWith ?? key.secret).update(`${timestamp}.${forged.signBody ?? raw}`).digest("hex")}`;
  return request(app).post(`/api/wordpress-plugin/${path}`)
    .set("content-type", "application/json").set("x-socialflow-key", forged.keyId ?? key.keyId).set("x-socialflow-timestamp", timestamp).set("x-socialflow-signature", signature)
    .send(raw);
}

const SITE = { url: "https://blog.example.com/", name: "The Blog", wpVersion: "6.6.2", pluginVersion: "1.0.0" };
const article = (n: number, extra: Record<string, unknown> = {}) => ({
  id: n, guid: `https://blog.example.com/?p=${n}`, title: `Post ${n}`, excerpt: `Excerpt ${n}`, url: `https://blog.example.com/post-${n}/`,
  imageUrl: `https://blog.example.com/${n}.jpg`, author: "Ada", publishedAt: "2026-03-01T09:30:00Z", ...extra,
});

/** A workspace with a plugin automation whose plugin has connected. */
async function connected(config: Record<string, unknown> = {}, platform: Platform = "facebook") {
  const owner = await signup();
  const target = await account(owner.workspaceId, platform, platform === "facebook" ? "Acme Page" : "Acme IG");
  const created = await owner.agent.post("/api/automations").send({ kind: "wordpress_plugin", name: "My site", config: { connectedAccountIds: [target.id], mode: "draft", ...config } });
  expect(created.status).toBe(201);
  const key = decodeKey(created.body.connectionKey);
  expect((await plugin(key, "connect", { site: SITE })).status).toBe(200);
  return { owner, target, id: created.body.id as string, key };
}

describe.skipIf(!tablesExist)("WordPress plugin (test DB only)", () => {
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("a plugin automation is created with a connection key that is shown once and stored encrypted", async () => {
    const owner = await signup();
    const fb = await account(owner.workspaceId);
    const yt = await account(owner.workspaceId, "youtube", "Acme TV");

    const res = await owner.agent.post("/api/automations").set("origin", "https://socialflow.test").send({ kind: "wordpress_plugin", name: " My site ", config: { connectedAccountIds: [fb.id], mode: "draft" } });
    expect(res.status).toBe(201);
    expect(() => CreateAutomationResponse.parse(res.body)).not.toThrow(); // matches the OpenAPI schema
    expect(res.body).toMatchObject({ kind: "wordpress_plugin", name: "My site", sourceUrl: "", status: "active", nextRunAt: null, plugin: { status: "pending", siteUrl: null, connectedAt: null } });
    // The key says where to call (this installation's address), which key, and its secret.
    const key = decodeKey(res.body.connectionKey);
    expect(key.apiBase).toBe("https://socialflow.test/api");
    expect(key.keyId).toMatch(/^wpk_[0-9a-f]{24}$/);
    expect(key.secret.length).toBeGreaterThanOrEqual(40);

    // Never again: not in the list, not in the single read, and only an encrypted copy in the database.
    const list = await owner.agent.get("/api/automations");
    expect(() => ListAutomationsResponse.parse(list.body)).not.toThrow();
    expect(list.body.automations[0].plugin.status).toBe("pending");
    const one = await owner.agent.get(`/api/automations/${res.body.id}`);
    for (const body of [list.body, one.body]) {
      expect(JSON.stringify(body)).not.toContain(key.secret);
      expect(JSON.stringify(body)).not.toContain("connectionKey");
      expect(JSON.stringify(body)).not.toContain(key.keyId);
    }
    const [row] = await db.select().from(wordpressConnectionsTable).where(eq(wordpressConnectionsTable.automationId, res.body.id));
    expect(row!.keyId).toBe(key.keyId);
    expect(row!.secretEncrypted).toMatch(/^v1\./);
    expect(row!.secretEncrypted).not.toContain(key.secret);

    // Without an Origin header the configured public address is used.
    const second = await owner.agent.post("/api/automations").send({ kind: "wordpress_plugin", name: "Second", config: { connectedAccountIds: [fb.id] } });
    expect(decodeKey(second.body.connectionKey).apiBase).toBe("https://socialflow.test/api");
    expect(second.body.config.mode).toBe("publish");
    // The address in a key is only ever this installation's own: an Origin from anywhere else is ignored, and a
    // local development address is taken as it is.
    for (const [origin, expected] of [["https://evil.example", "https://socialflow.test/api"], ["not a url", "https://socialflow.test/api"], ["http://localhost:3000", "http://localhost:3000/api"], ["http://127.0.0.1:8080", "http://127.0.0.1:8080/api"]] as const) {
      const made = await owner.agent.post(`/api/automations/${second.body.id}/plugin-key`).set("origin", origin);
      expect([origin, decodeKey(made.body.connectionKey).apiBase]).toEqual([origin, expected]);
    }

    // The same account rules as every automation.
    expect((await owner.agent.post("/api/automations").send({ kind: "wordpress_plugin", name: "x", config: {} })).status).toBe(400);
    expect((await owner.agent.post("/api/automations").send({ kind: "wordpress_plugin", name: "x", config: { connectedAccountIds: [yt.id] } })).body.message).toMatch(/YouTube/);
    const viewer = await addMember(owner, "viewer");
    expect((await viewer.agent.post("/api/automations").send({ kind: "wordpress_plugin", name: "x", config: { connectedAccountIds: [fb.id] } })).status).toBe(403);
    expect((await viewer.agent.get("/api/automations")).body.automations).toHaveLength(2);
  });

  it("connect records the site; status reports it; disconnect ends it until the plugin connects again", async () => {
    const owner = await signup();
    const fb = await account(owner.workspaceId);
    const created = await owner.agent.post("/api/automations").send({ kind: "wordpress_plugin", name: "My site", config: { connectedAccountIds: [fb.id], mode: "queue" } });
    const key = decodeKey(created.body.connectionKey);

    // Until it has connected, the plugin can't send posts or ask for status.
    expect([(await plugin(key, "posts", { post: article(1) })).body.error, (await plugin(key, "status", {})).body.error]).toEqual(["not_connected", "not_connected"]);
    expect((await plugin(key, "connect", { site: { name: "No address" } })).body.error).toBe("invalid_site");

    const res = await plugin(key, "connect", { site: SITE });
    expect(res.status).toBe(200);
    expect(() => WordpressPluginConnectResponse.parse(res.body)).not.toThrow();
    expect(res.body.connection).toEqual({
      status: "connected", workspaceName: expect.any(String), automationName: "My site", automationStatus: "active", mode: "queue",
      accounts: [{ name: "Acme Page", platform: "facebook", status: "active" }], postsCreated: 0, dashboardUrl: "https://socialflow.test/automations",
    });

    const listed = (await owner.agent.get("/api/automations")).body.automations[0];
    expect(listed.sourceUrl).toBe("https://blog.example.com");
    expect(listed.plugin).toMatchObject({ status: "connected", siteUrl: "https://blog.example.com", siteName: "The Blog", wpVersion: "6.6.2", pluginVersion: "1.0.0", lastPostAt: null });
    expect(listed.plugin.connectedAt).toBeTruthy();
    expect(listed.plugin.lastSeenAt).toBeTruthy();
    const audit = await db.select().from(auditLogTable).where(and(eq(auditLogTable.workspaceId, owner.workspaceId), eq(auditLogTable.action, "automation.plugin_connected")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorUserId).toBeNull();

    const status = await plugin(key, "status", { site: { pluginVersion: "1.0.1" } });
    expect(status.status).toBe(200);
    expect(() => WordpressPluginStatusResponse.parse(status.body)).not.toThrow();
    expect(status.body.recent).toEqual([]);
    expect((await owner.agent.get("/api/automations")).body.automations[0].plugin.pluginVersion).toBe("1.0.1");

    expect((await plugin(key, "disconnect", {})).body).toEqual({ ok: true });
    expect((await owner.agent.get("/api/automations")).body.automations[0].plugin.status).toBe("disconnected");
    expect((await plugin(key, "posts", { post: article(1) })).status).toBe(409);
    expect((await plugin(key, "status", {})).status).toBe(409);
    // The key itself still stands (only SocialFlow withdraws it), so the same plugin can connect again.
    expect((await plugin(key, "connect", { site: SITE })).body.connection.status).toBe("connected");
  });

  it("refuses requests that aren't signed with the key, were altered, or are too old", async () => {
    const { key, owner } = await connected();
    const now = Math.floor(Date.now() / 1000);
    const post = { post: article(1) };
    const attempts: Array<[string, Awaited<ReturnType<typeof plugin>>, string]> = [
      ["another secret", await plugin(key, "posts", post, { signWith: "not-the-secret" }), "bad_signature"],
      ["a body changed after signing", await plugin(key, "posts", post, { signBody: JSON.stringify({ post: article(2) }) }), "bad_signature"],
      ["a signature for another time", await plugin(key, "posts", post, { signature: `v1=${signPayload(key.secret, String(now - 30), JSON.stringify(post))}` }), "bad_signature"],
      ["a malformed signature", await plugin(key, "posts", post, { signature: "v1=abc" }), "bad_signature"],
      ["a key that doesn't exist", await plugin(key, "posts", post, { keyId: "wpk_000000000000000000000000" }), "unknown_key"],
      ["a malformed key id", await plugin(key, "posts", post, { keyId: "' or 1=1 --" }), "bad_signature"],
      ["a request from an hour ago", await plugin(key, "posts", post, { timestamp: now - 3600 }), "stale_timestamp"],
      ["a request from the future", await plugin(key, "posts", post, { timestamp: now + 3600 }), "stale_timestamp"],
    ];
    for (const [what, res, error] of attempts) expect([what, res.status, res.body.error]).toEqual([what, 401, error]);
    // A wrong clock is named as the reason (with our time), but only to a request the key really signed.
    expect(attempts[6]![1].body.serverTime).toBeGreaterThan(now - 5);
    expect((await request(app).post("/api/wordpress-plugin/posts").send(post)).status).toBe(401);
    expect((await owner.agent.get("/api/posts")).body.posts).toHaveLength(0);
    // A few minutes of clock difference are fine.
    expect((await plugin(key, "status", {}, { timestamp: now - 300 })).status).toBe(200);
  });

  it("a published post becomes one social post; sending it again is a duplicate", async () => {
    const { owner, id, key, target } = await connected({ template: "New: {title} by {author} on {site}\n\n{url}" });
    const first = await plugin(key, "posts", { post: article(1) });
    expect(first.status).toBe(200);
    expect(() => WordpressPluginPostResponse.parse(first.body)).not.toThrow();
    expect(first.body).toEqual({ result: "created", message: expect.stringMatching(/Saved as a draft/), post: { status: "draft", scheduledAt: null } });

    let posts = (await owner.agent.get("/api/posts")).body.posts;
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ status: "draft", content: "New: Post 1 by Ada on The Blog\n\nhttps://blog.example.com/post-1/" });
    expect(posts[0].link).toMatchObject({ url: "https://blog.example.com/post-1/", title: "Post 1", description: "Excerpt 1", imageUrl: "https://blog.example.com/1.jpg" });
    expect(posts[0].targets.map((t: { connectedAccountId: string }) => t.connectedAccountId)).toEqual([target.id]);

    // The same post again: a retry, a second editor, or unpublishing and publishing it once more.
    for (const again of [article(1), article(1, { title: "Post 1 (edited)" }), article(1, { url: "https://blog.example.com/a-new-slug/" })]) {
      const res = await plugin(key, "posts", { post: again });
      expect([res.status, res.body.result, res.body.post]).toEqual([200, "duplicate", null]);
    }
    expect((await plugin(key, "posts", { post: article(1), manual: true })).body.result).toBe("duplicate");
    // Sent together, a new post is still made once.
    const together = await Promise.all([plugin(key, "posts", { post: article(2) }), plugin(key, "posts", { post: article(2) }), plugin(key, "posts", { post: article(2) })]);
    expect(together.map((res) => res.body.result).sort()).toEqual(["created", "duplicate", "duplicate"]);
    posts = (await owner.agent.get("/api/posts")).body.posts;
    expect(posts).toHaveLength(2);

    // It is all in the automation's history, like a polled automation's.
    const automation = (await owner.agent.get(`/api/automations/${id}`)).body;
    expect(automation).toMatchObject({ lastStatus: "success", lastError: null, postsCreatedTotal: 2, nextRunAt: null });
    expect(automation.plugin.lastPostAt).toBeTruthy();
    const items = (await owner.agent.get(`/api/automations/${id}/items`)).body.items;
    expect(items.map((item: { status: string; itemKey: string }) => [item.status, item.itemKey]).sort()).toEqual([["posted", "blog.example.com?p=1"], ["posted", "blog.example.com?p=2"]]);
    const runs = (await owner.agent.get(`/api/automations/${id}/runs`)).body.runs;
    expect(runs.map((run: { status: string; postsCreated: number }) => [run.status, run.postsCreated])).toEqual([["success", 1], ["success", 1]]);
    const status = await plugin(key, "status", {});
    expect(status.body.connection.postsCreated).toBe(2);
    expect(status.body.recent.map((share: { title: string; status: string; postStatus: string }) => [share.title, share.status, share.postStatus]).sort()).toEqual([["Post 1", "posted", "draft"], ["Post 2", "posted", "draft"]]);
  });

  it("follows the automation's mode: publish schedules it for now, queue without a free time saves a draft, approval is named", async () => {
    const publishing = await connected({ mode: "publish" });
    const before = Date.now();
    const sent = await plugin(publishing.key, "posts", { post: article(1) });
    expect(sent.body).toMatchObject({ result: "created", message: expect.stringMatching(/published within about a minute/), post: { status: "scheduled" } });
    expect(Math.abs(new Date(sent.body.post.scheduledAt).getTime() - before)).toBeLessThan(10_000);
    const [post] = (await publishing.owner.agent.get("/api/posts")).body.posts;
    expect(post).toMatchObject({ status: "scheduled" });

    expect((await publishing.owner.agent.put("/api/approvals/settings").send({ required: true })).status).toBe(200);
    expect((await plugin(publishing.key, "posts", { post: article(2) })).body.message).toMatch(/requires approval/);

    const queued = await connected({ mode: "queue" });
    const fallback = await plugin(queued.key, "posts", { post: article(1) });
    expect(fallback.body).toMatchObject({ result: "created", post: { status: "draft", scheduledAt: null }, message: expect.stringMatching(/^Saved as a draft: /) });
  });

  it("a paused automation skips posts; a post that can't be made says why and can be sent again", async () => {
    const paused = await connected();
    expect((await paused.owner.agent.post(`/api/automations/${paused.id}/pause`)).status).toBe(200);
    const skipped = await plugin(paused.key, "posts", { post: article(1) });
    expect(skipped.body).toEqual({ result: "skipped", message: expect.stringMatching(/paused in SocialFlow/), post: null });
    expect((await db.select().from(automationItemsTable).where(eq(automationItemsTable.automationId, paused.id)))).toHaveLength(0);
    // Resuming a plugin automation doesn't give it a next run: there is nothing to poll.
    const resumed = await paused.owner.agent.post(`/api/automations/${paused.id}/resume`);
    expect(resumed.body).toMatchObject({ status: "active", nextRunAt: null });
    expect((await plugin(paused.key, "posts", { post: article(1) })).body.result).toBe("created");

    for (const bad of [{}, { post: null }, { post: { title: "No address" } }, { post: { url: "ftp://blog.example.com/x" } }, { post: { url: "javascript:alert(1)" } }]) {
      const res = await plugin(paused.key, "posts", bad);
      expect([res.status, res.body.error]).toEqual([422, "invalid_post"]);
    }

    // Instagram needs a picture. Without one the post is refused with the reason; with one it goes through on a retry.
    const instagram = await connected({ mode: "publish" }, "instagram");
    const refused = await plugin(instagram.key, "posts", { post: article(1, { imageUrl: null }) });
    expect(refused.body.result).toBe("failed");
    expect(refused.body.message).toMatch(/image|picture|photo/i);
    expect((await instagram.owner.agent.get(`/api/automations/${instagram.id}`)).body).toMatchObject({ lastStatus: "failed", postsCreatedTotal: 0 });
    expect((await plugin(instagram.key, "posts", { post: article(1) })).body.result).toBe("created");
    expect((await instagram.owner.agent.get("/api/posts")).body.posts).toHaveLength(1);

    // The automatic path gives up on an item after three attempts; a person pressing "Share now" is not held to that.
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await plugin(instagram.key, "posts", { post: article(2, { imageUrl: null }) })).body.result).toBe("failed");
    const givenUp = await plugin(instagram.key, "posts", { post: article(2) });
    expect(givenUp.body).toMatchObject({ result: "failed", message: expect.stringMatching(/tried this post 3 times.*Share now/s), post: null });
    expect((await instagram.owner.agent.get("/api/posts")).body.posts).toHaveLength(1);
    expect((await plugin(instagram.key, "posts", { post: article(2), manual: true })).body.result).toBe("created");
  });

  it("takes a limited number of new posts an hour from one site", async () => {
    vi.stubEnv("WORDPRESS_PLUGIN_POSTS_PER_HOUR", "2");
    const { key, owner } = await connected();
    expect((await plugin(key, "posts", { post: article(1) })).body.result).toBe("created");
    expect((await plugin(key, "posts", { post: article(2) })).body.result).toBe("created");
    const third = await plugin(key, "posts", { post: article(3) });
    expect([third.status, third.body.error, third.headers["retry-after"]]).toEqual([429, "rate_limited", "900"]);
    expect(third.body.message).toMatch(/up to 2 posts an hour/);
    // A post it already has is still answered as a duplicate, not as "too many".
    expect((await plugin(key, "posts", { post: article(1) })).body.result).toBe("duplicate");
    expect((await owner.agent.get("/api/posts")).body.posts).toHaveLength(2);
  });

  it("replacing the key or deleting the automation cuts the plugin off; only its workspace can do either", async () => {
    const { owner, id, key } = await connected();
    const viewer = await addMember(owner, "viewer");
    const stranger = await signup();
    expect((await viewer.agent.post(`/api/automations/${id}/plugin-key`)).status).toBe(403);
    expect((await stranger.agent.post(`/api/automations/${id}/plugin-key`)).status).toBe(404);
    expect((await request(app).post(`/api/automations/${id}/plugin-key`)).status).toBe(401);

    const replaced = await owner.agent.post(`/api/automations/${id}/plugin-key`).set("origin", "https://socialflow.test");
    expect(replaced.status).toBe(200);
    expect(() => ReplaceAutomationPluginKeyResponse.parse(replaced.body)).not.toThrow();
    expect(replaced.body.plugin).toMatchObject({ status: "pending", connectedAt: null, siteUrl: "https://blog.example.com" });
    const fresh = decodeKey(replaced.body.connectionKey);
    expect(fresh.keyId).not.toBe(key.keyId);
    expect(fresh.secret).not.toBe(key.secret);
    // The old key is gone for good, even with a correct signature.
    expect((await plugin(key, "connect", { site: SITE })).body.error).toBe("unknown_key");
    expect((await plugin(key, "posts", { post: article(1) })).body.error).toBe("unknown_key");
    // The new one is pending until the plugin connects with it.
    expect((await plugin(fresh, "posts", { post: article(1) })).body.error).toBe("not_connected");
    expect((await plugin(fresh, "connect", { site: SITE })).status).toBe(200);
    expect((await plugin(fresh, "posts", { post: article(1) })).body.result).toBe("created");

    // A polled automation has no key.
    const fb = await account(owner.workspaceId, "facebook", "Other Page");
    const polled = await owner.agent.post("/api/automations").send({ kind: "rss", name: "Feed", sourceUrl: "https://blog.example.com/feed", config: { connectedAccountIds: [fb.id] } });
    expect(polled.body.plugin).toBeNull();
    expect((await owner.agent.post(`/api/automations/${polled.body.id}/plugin-key`)).body.error).toBe("not_a_plugin_automation");

    expect((await owner.agent.delete(`/api/automations/${id}`)).status).toBe(204);
    expect((await db.select().from(wordpressConnectionsTable).where(eq(wordpressConnectionsTable.automationId, id)))).toHaveLength(0);
    expect((await plugin(fresh, "status", {})).body.error).toBe("unknown_key");
    // Posts it made are kept, as for every automation.
    expect((await owner.agent.get("/api/posts")).body.posts).toHaveLength(1);
  });

  it("is never polled: the poller doesn't claim it and there is nothing to run now", async () => {
    const { owner, id } = await connected();
    // Even if a next run were somehow set, the poller leaves a plugin automation alone.
    await db.update(automationsTable).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(automationsTable.id, id));
    expect(await claimDueAutomations(50)).not.toContain(id);
    expect(await runAutomation(id)).toBeNull();
    const res = await owner.agent.post(`/api/automations/${id}/run-now`);
    expect([res.status, res.body.error]).toEqual([400, "nothing_to_check"]);
    expect((await owner.agent.post("/api/automations/test-source").send({ kind: "wordpress_plugin", url: "https://blog.example.com" })).status).toBe(400);
    // Its name and settings are edited like any automation's; a source address has no meaning for it.
    const edited = await owner.agent.patch(`/api/automations/${id}`).send({ name: "Renamed", sourceUrl: "https://elsewhere.example.com", config: { mode: "publish" } });
    expect(edited.body).toMatchObject({ name: "Renamed", sourceUrl: "https://blog.example.com", config: { mode: "publish" } });
  });
});

describe("WordPress plugin helpers", () => {
  it("a connection key carries the address, the key id and the secret", () => {
    const key = encodeConnectionKey("https://app.example.com/api", "wpk_0123456789abcdef01234567", "s3cret");
    expect(key).toMatch(/^sfwp1_[A-Za-z0-9_-]+$/);
    expect(Buffer.from(key.slice(6), "base64url").toString("utf8")).toBe("https://app.example.com/api\nwpk_0123456789abcdef01234567\ns3cret");
  });

  it("the signature covers the time and every byte of the body", () => {
    const signature = signPayload("secret", "1700000000", '{"a":1}');
    expect(signature).toBe(createHmac("sha256", "secret").update('1700000000.{"a":1}').digest("hex"));
    expect(signPayload("secret", "1700000001", '{"a":1}')).not.toBe(signature);
    expect(signPayload("secret", "1700000000", '{"a":2}')).not.toBe(signature);
    expect(signPayload("secret", "1700000000", Buffer.from('{"a":1}'))).toBe(signature);
  });

  it("reads a post as plain text and gives it the identity its feed would", () => {
    const read = readPost({ id: 7, guid: "https://Blog.Example.com/?p=7", title: "  Tom &  Jerry\u0007 ", excerpt: `one\n\ntwo ${"x".repeat(2000)}`, url: "https://blog.example.com/tom/", imageUrl: "not a url", author: "", publishedAt: "nonsense" }, "https://blog.example.com");
    if ("error" in read) throw new Error(read.error);
    expect(read.item).toMatchObject({ key: "blog.example.com?p=7", title: "Tom & Jerry", url: "https://blog.example.com/tom/", imageUrl: null, author: null, publishedAt: null });
    expect(read.item.excerpt.length).toBeLessThanOrEqual(1000);
    expect(read.item.excerpt.startsWith("one two x")).toBe(true);
    // Without a guid the site and the post's number identify it, so a changed permalink is still the same post.
    const a = readPost({ id: 7, url: "https://blog.example.com/old/" }, "https://blog.example.com");
    const b = readPost({ id: 7, url: "https://blog.example.com/new/" }, "https://blog.example.com");
    expect("item" in a && "item" in b && a.item.key === b.item.key).toBe(true);
    expect(readPost({ url: "ftp://x" }, null)).toEqual({ error: expect.stringMatching(/web address/) });
    expect(readPost("nope", null)).toEqual({ error: expect.stringMatching(/no post/) });
  });
});
