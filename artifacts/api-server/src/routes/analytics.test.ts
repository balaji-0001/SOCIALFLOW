import { eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { accountMetricsTable, db, postMetricsTable, postTargetsTable, postsTable, usersTable, workspacesTable } from "@workspace/db";
import app from "../app";
import { collectWorkspace, metricSupport } from "../lib/analytics";
import { resolveRange } from "../lib/analytics-report";
import { saveConnectedAccount } from "../lib/oauth/accounts";
import { createFacebookAdapter } from "../lib/oauth/providers/facebook";
import { createInstagramAdapter } from "../lib/oauth/providers/instagram";
import { createLinkedInAdapter } from "../lib/oauth/providers/linkedin";
import { createYouTubeAdapter } from "../lib/oauth/providers/youtube";

// Analytics: adapters against faked networks, the collector storing snapshots, and the report built from them.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("metric support", () => {
  it("explains what each network can and can't report", () => {
    expect(metricSupport("facebook", []).reach).toMatchObject({ available: false });
    expect(metricSupport("facebook", []).reach.reason).toContain("read_insights");
    expect(metricSupport("facebook", ["read_insights"]).reach.available).toBe(true);
    expect(metricSupport("facebook", []).likes.available).toBe(true);
    expect(metricSupport("instagram", []).saves.available).toBe(false);
    expect(metricSupport("instagram", ["instagram_business_manage_insights"]).saves.available).toBe(true);
    expect(metricSupport("youtube", []).views.available).toBe(true);
    expect(metricSupport("youtube", []).shares.available).toBe(false);
    expect(Object.values(metricSupport("linkedin", ["w_member_social"])).every((m) => !m.available)).toBe(true);
  });
});

describe("range resolution", () => {
  const now = new Date("2026-03-15T10:00:00.000Z");
  it("builds presets with a same-length previous period", () => {
    const r = resolveRange("7d", "UTC", {}, now)!;
    expect(r.from.toISOString()).toBe("2026-03-09T00:00:00.000Z");
    expect(r.to.toISOString()).toBe(now.toISOString());
    expect(r.previousTo.toISOString()).toBe(r.from.toISOString());
    expect(r.from.getTime() - r.previousFrom.getTime()).toBe(r.to.getTime() - r.from.getTime());
    expect(resolveRange("today", "UTC", {}, now)!.from.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(resolveRange("today", "Asia/Kolkata", {}, now)!.from.toISOString()).toBe("2026-03-14T18:30:00.000Z");
  });
  it("accepts custom ranges and refuses bad ones", () => {
    const r = resolveRange("custom", "UTC", { from: "2026-03-01", to: "2026-03-03" }, now)!;
    expect(r.from.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-03-04T00:00:00.000Z");
    expect(resolveRange("custom", "UTC", { from: "2026-03-05", to: "2026-03-01" }, now)).toBeNull();
    expect(resolveRange("custom", "UTC", { from: "nope", to: "2026-03-01" }, now)).toBeNull();
    expect(resolveRange("custom", "UTC", { from: "2024-01-01", to: "2026-03-01" }, now)).toBeNull();
  });
});

describe("network adapters", () => {
  it("Facebook: followers, likes, comments, shares; insights only with the permission; missing posts are reported", async () => {
    const adapter = createFacebookAdapter({ clientId: "app", clientSecret: "secret" });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      calls.push(url.pathname.replace(/^\/v[\d.]+/, ""));
      const path = url.pathname.replace(/^\/v[\d.]+/, "");
      if (path === "/1001") return json({ followers_count: 4200, fan_count: 4100 });
      if (path === "/1001_1") return json({ likes: { summary: { total_count: 12 } }, comments: { summary: { total_count: 3 } }, shares: { count: 2 } });
      if (path === "/1001_1/insights") return json({ data: [{ name: "post_impressions", values: [{ value: 900 }] }, { name: "post_impressions_unique", values: [{ value: 640 }] }] });
      if (path === "/1001_2") return json({ likes: { summary: { total_count: 0 } }, comments: { summary: { total_count: 0 } } });
      return json({ error: { code: 100, message: "Unsupported get request" } }, 400);
    }));
    const base = { externalAccountId: "1001", accessToken: "PAGE_TOKEN", refreshToken: null, tokenExpiresAt: null };
    const without = await adapter.collectMetrics!({ ...base, scopes: ["pages_manage_posts"] }, { postIds: ["1001_1", "1001_2", "1001_gone"] });
    expect(without.account.followers).toBe(4200);
    expect(without.posts["1001_1"]).toEqual({ likes: 12, comments: 3, shares: 2 });
    expect(without.posts["1001_2"]).toMatchObject({ likes: 0, comments: 0, shares: 0 }); // a real zero the network reported
    expect(without.posts["1001_gone"]).toBeUndefined();
    expect(without.notes.map((n) => n.code).sort()).toEqual(["insights_permission", "posts_unavailable"]);
    expect(calls.some((c) => c.endsWith("/insights"))).toBe(false);

    const withScope = await adapter.collectMetrics!({ ...base, scopes: ["read_insights"] }, { postIds: ["1001_1"] });
    expect(withScope.posts["1001_1"]).toMatchObject({ likes: 12, impressions: 900, reach: 640 });
    expect(withScope.notes).toEqual([]);
  });

  it("Facebook: a dead token throws so the account is marked for reconnect", async () => {
    const adapter = createFacebookAdapter({ clientId: "app", clientSecret: "secret" });
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: 190, message: "Invalid OAuth access token" } }, 400)));
    await expect(adapter.collectMetrics!({ externalAccountId: "1001", accessToken: "x", refreshToken: null, tokenExpiresAt: null }, { postIds: [] })).rejects.toMatchObject({ code: "token_revoked" });
  });

  it("Instagram: followers and media count, likes and comments; insights with the permission", async () => {
    const adapter = createInstagramAdapter({ clientId: "app", clientSecret: "secret" });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname === "/me") return json({ followers_count: 830, media_count: 41 });
      if (url.pathname === "/m1") return json({ like_count: 50, comments_count: 7 });
      if (url.pathname === "/m1/insights") return json({ data: [{ name: "reach", values: [{ value: 700 }] }, { name: "saved", values: [{ value: 9 }] }, { name: "shares", values: [{ value: 4 }] }, { name: "views", values: [{ value: 1200 }] }] });
      return json({ error: { code: 100, message: "nope" } }, 400);
    }));
    const base = { externalAccountId: "ig-1", accessToken: "IG", refreshToken: null, tokenExpiresAt: null };
    const basic = await adapter.collectMetrics!({ ...base, scopes: ["instagram_business_basic"] }, { postIds: ["m1"] });
    expect(basic.account).toEqual({ followers: 830, mediaCount: 41 });
    expect(basic.posts.m1).toEqual({ likes: 50, comments: 7 });
    expect(basic.notes.map((n) => n.code)).toEqual(["insights_permission"]);
    const full = await adapter.collectMetrics!({ ...base, scopes: ["instagram_business_manage_insights"] }, { postIds: ["m1"] });
    expect(full.posts.m1).toMatchObject({ likes: 50, reach: 700, saves: 9, shares: 4, views: 1200 });
  });

  it("YouTube: channel statistics and per-video views/likes/comments; hidden subscribers are explained", async () => {
    const adapter = createYouTubeAdapter({ clientId: "id", clientSecret: "secret" });
    let hidden = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/channels")) return json({ items: [{ statistics: { subscriberCount: "1500", viewCount: "98000", videoCount: "12", hiddenSubscriberCount: hidden } }] });
      if (url.pathname.endsWith("/videos")) return json({ items: [{ id: "v1", statistics: { viewCount: "320", likeCount: "21", commentCount: "4" } }] });
      return json({}, 404);
    }));
    const base = { externalAccountId: "UC1", accessToken: "YT", refreshToken: null, tokenExpiresAt: null };
    const shown = await adapter.collectMetrics!(base, { postIds: ["v1", "v2"] });
    expect(shown.account).toEqual({ followers: 1500, mediaCount: 12, viewsTotal: 98000 });
    expect(shown.posts.v1).toEqual({ views: 320, likes: 21, comments: 4 });
    expect(shown.notes.map((n) => n.code)).toEqual(["posts_unavailable"]);
    hidden = true;
    const hiddenResult = await adapter.collectMetrics!(base, { postIds: [] });
    expect(hiddenResult.account.followers).toBeUndefined();
    expect(hiddenResult.notes.map((n) => n.code)).toContain("subscribers_hidden");
  });

  it("LinkedIn reports nothing rather than guessing", () => {
    expect(createLinkedInAdapter({ clientId: "id", clientSecret: "secret" }).collectMetrics).toBeUndefined();
  });
});

const tablesExist = await db
  .execute(sql`select to_regclass('public.socialflow_post_metrics') as t`)
  .then((r) => Boolean((r.rows[0] as { t: string | null }).t))
  .catch(() => false);

const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;

async function newWorkspace() {
  const agent = request.agent(app);
  const email = `analytics-test-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2)}@socialflow.test`;
  const res = await agent.post("/api/auth/signup").send({ email, password: "correct horse battery staple" });
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return { agent, workspaceId: res.body.workspace.id as string };
}

async function facebookPage(workspaceId: string, id: string, name: string, scopes: string[] = ["pages_manage_posts"]) {
  return saveConnectedAccount(db, workspaceId, "facebook", {
    externalAccountId: id, accountType: "facebook_page", displayName: name, username: null, avatarUrl: null, accessToken: `TOKEN_${id}`,
    refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes, metadata: {}, selectable: true, warnings: [],
  }, "u");
}

async function publishedPost(workspaceId: string, accountId: string, externalPostId: string, content: string, publishedAt: Date) {
  const [post] = await db.insert(postsTable).values({ workspaceId, content, status: "published", scheduledAt: publishedAt, publishedAt }).returning();
  const [target] = await db.insert(postTargetsTable).values({ postId: post!.id, connectedAccountId: accountId, status: "published", externalPostId }).returning();
  return { post: post!, target: target! };
}

describe.skipIf(!tablesExist)("Analytics (database)", () => {
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("collects real numbers into snapshots and reports them; unreported metrics stay unavailable, not zero", async () => {
    const { agent, workspaceId } = await newWorkspace();
    const page = await facebookPage(workspaceId, "2001", "Analytics Page");
    const hourAgo = new Date(Date.now() - 3600_000);
    const one = await publishedPost(workspaceId, page.id, "2001_a", "First post", hourAgo);
    const two = await publishedPost(workspaceId, page.id, "2001_b", "Second post", hourAgo);

    // Nothing collected yet: an honest empty report.
    const empty = await agent.get("/api/analytics?range=7d&tz=UTC");
    expect(empty.status).toBe(200);
    expect(empty.body.lastCollectedAt).toBeNull();
    expect(empty.body.kpis.followers.value).toBeNull();
    expect(empty.body.kpis.likes.value).toBeNull();
    expect(empty.body.kpis.posts.value).toBe(2); // posts published is known without the network

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const path = url.pathname.replace(/^\/v[\d.]+/, "");
      if (path === "/2001") return json({ followers_count: 1000 });
      if (path === "/2001_a") return json({ likes: { summary: { total_count: 30 } }, comments: { summary: { total_count: 5 } }, shares: { count: 1 } });
      if (path === "/2001_b") return json({ likes: { summary: { total_count: 10 } }, comments: { summary: { total_count: 0 } }, shares: { count: 0 } });
      return json({ error: { code: 100, message: "?" } }, 400);
    }));
    const outcomes = await collectWorkspace(workspaceId, { force: true });
    expect(outcomes[0]).toMatchObject({ ok: true, postsRead: 2 });
    expect(outcomes[0]!.notes.map((n) => n.code)).toContain("insights_permission");

    const report = await agent.get("/api/analytics?range=7d&tz=UTC");
    expect(report.body.kpis.followers.value).toBe(1000);
    expect(report.body.kpis.likes.value).toBe(40);
    expect(report.body.kpis.comments.value).toBe(5);
    expect(report.body.kpis.shares.value).toBe(1);
    expect(report.body.kpis.engagement.value).toBe(46);
    expect(report.body.kpis.engagement.rate).toBeNull(); // no reach/impressions/views to divide by, so no rate
    expect(report.body.kpis.reach).toMatchObject({ value: null, available: false });
    expect(report.body.kpis.reach.reason).toContain("read_insights");
    expect(report.body.kpis.views).toMatchObject({ value: null, available: false });
    expect(report.body.lastCollectedAt).not.toBeNull();
    expect(report.body.platforms).toEqual([expect.objectContaining({ platform: "facebook", followers: 1000, posts: 2, likes: 40 })]);
    expect(report.body.topPosts.map((p: { content: string }) => p.content)).toEqual(["First post", "Second post"]);
    expect(report.body.topPosts[0]).toMatchObject({ likes: 30, engagement: 36 });
    expect(report.body.series.followers).toHaveLength(1);
    expect(report.body.series.activity.reduce((sum: number, d: { posts: number }) => sum + d.posts, 0)).toBe(2);
    expect(report.body.accounts[0].support.reach.available).toBe(false);

    // A second collection within the minimum gap is skipped unless forced.
    const [dueAccount] = await db.select().from((await import("@workspace/db")).connectedAccountsTable).where(eq((await import("@workspace/db")).connectedAccountsTable.id, page.id));
    const { collectAccount } = await import("../lib/analytics");
    expect((await collectAccount(dueAccount!)).skipped).toBe(true);
    void one; void two;
  });

  it("compares with the previous period and filters by platform and account", async () => {
    const { agent, workspaceId } = await newWorkspace();
    const page = await facebookPage(workspaceId, "3001", "Compare Page");
    const otherPage = await facebookPage(workspaceId, "3002", "Other Page");
    const now = Date.now();
    const recent = await publishedPost(workspaceId, page.id, "3001_new", "Recent", new Date(now - 2 * 86_400_000));
    const older = await publishedPost(workspaceId, page.id, "3001_old", "Older", new Date(now - 10 * 86_400_000));
    await publishedPost(workspaceId, otherPage.id, "3002_x", "Other page post", new Date(now - 3 * 86_400_000));
    await db.insert(postMetricsTable).values([
      { postTargetId: recent.target.id, capturedAt: new Date(now - 3600_000), likes: 100, comments: 10, shares: 5 },
      { postTargetId: older.target.id, capturedAt: new Date(now - 3600_000), likes: 40, comments: 2, shares: 0 },
    ]);
    await db.insert(accountMetricsTable).values([
      { connectedAccountId: page.id, capturedAt: new Date(now - 9 * 86_400_000), followers: 500 },
      { connectedAccountId: page.id, capturedAt: new Date(now - 3600_000), followers: 560 },
    ]);
    const week = await agent.get(`/api/analytics?range=7d&tz=UTC&accountId=${page.id}`);
    expect(week.body.kpis.posts).toMatchObject({ value: 1, previous: 1, change: 0 });
    expect(week.body.kpis.likes).toMatchObject({ value: 100, previous: 40, change: 60 });
    expect(week.body.kpis.followers).toMatchObject({ value: 560, previous: 500, change: 60 });
    expect(week.body.accounts).toHaveLength(1);
    const all = await agent.get("/api/analytics?range=7d&tz=UTC&platform=facebook");
    expect(all.body.accounts).toHaveLength(2);
    expect(all.body.kpis.posts.value).toBe(2);
    const none = await agent.get("/api/analytics?range=7d&tz=UTC&platform=youtube");
    expect(none.body.accounts).toHaveLength(0);
    expect(none.body.kpis.likes.available).toBe(false);
    // Bad input.
    expect((await agent.get("/api/analytics?range=forever")).status).toBe(400);
    expect((await agent.get("/api/analytics?range=custom&from=2026-01-02&to=2026-01-01")).status).toBe(400);
    expect((await agent.get("/api/analytics?platform=myspace")).status).toBe(400);
    expect((await request(app).get("/api/analytics")).status).toBe(401);
  });

  it("never shows another workspace's numbers", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    const page = await facebookPage(a.workspaceId, "4001", "Private Page");
    const { target } = await publishedPost(a.workspaceId, page.id, "4001_p", "Private", new Date(Date.now() - 3600_000));
    await db.insert(postMetricsTable).values({ postTargetId: target.id, likes: 999 });
    const mine = await a.agent.get("/api/analytics?range=7d&tz=UTC");
    expect(mine.body.kpis.likes.value).toBe(999);
    const theirs = await b.agent.get("/api/analytics?range=7d&tz=UTC");
    expect(theirs.body.kpis.likes.value).toBeNull();
    expect(theirs.body.accounts).toHaveLength(0);
    expect((await b.agent.get(`/api/analytics?accountId=${page.id}`)).body.accounts).toHaveLength(0);
  });

  it("refresh reads the networks now and reports why something is missing", async () => {
    const { agent, workspaceId } = await newWorkspace();
    const page = await facebookPage(workspaceId, "5001", "Refresh Page");
    await publishedPost(workspaceId, page.id, "5001_a", "Fresh", new Date(Date.now() - 3600_000));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname.replace(/^\/v[\d.]+/, "");
      if (path === "/5001") return json({ followers_count: 77 });
      if (path === "/5001_a") return json({ likes: { summary: { total_count: 3 } }, comments: { summary: { total_count: 1 } }, shares: { count: 0 } });
      return json({}, 404);
    }));
    const res = await agent.post("/api/analytics/refresh").send({});
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ ok: true, postsRead: 1, error: null });
    expect(res.body.results[0].notes.map((n: { code: string }) => n.code)).toContain("insights_permission");
    expect((await agent.get("/api/analytics?range=7d&tz=UTC")).body.kpis.followers.value).toBe(77);
  });
});
