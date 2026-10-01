import { eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateAutomationResponse, ListAutomationItemsResponse, ListAutomationRunsResponse, ListAutomationsResponse, PauseAutomationResponse, RunAutomationNowResponse, TestAutomationSourceResponse } from "@workspace/api-zod";
import { auditLogTable, automationsTable, db, postsTable, usersTable, workspacesTable } from "@workspace/db";
import { linkPreviewDeps, type HopResponse } from "../lib/link-preview";
import { saveConnectedAccount } from "../lib/oauth/accounts";
import type { Platform } from "../lib/oauth/types";

// Automations API: source testing (with the SSRF rules), CRUD and validation, pause / resume / run now, history,
// permissions and workspace isolation. Websites are served by stubs at the SSRF-safe fetcher's seams.

vi.hoisted(() => {
  process.env.AUTOMATION_RUN_RATE_LIMIT = "1000";
  process.env.AUTOMATION_TEST_RATE_LIMIT = "1000";
});
const { default: app } = await import("../app");

const realDeps = { ...linkPreviewDeps };
type Served = { status?: number; type?: string; body?: string };
let handler: (url: URL) => Served = () => ({ status: 404 });
let calls: string[] = [];
beforeEach(() => {
  calls = [];
  linkPreviewDeps.lookup = async (host) => [{ address: host === "intranet.example" ? "192.168.1.10" : "93.184.216.34", family: 4 }];
  linkPreviewDeps.request = (async (url: URL): Promise<HopResponse> => {
    calls.push(url.toString());
    const { status = 200, type = "application/rss+xml", body = "" } = handler(url);
    return { status, headers: { "content-type": type }, body: (async function* () { yield Buffer.from(body); })(), destroy: vi.fn() };
  }) as never;
});
afterEach(() => Object.assign(linkPreviewDeps, realDeps));

function feedOf(count: number): string {
  const items: string[] = [];
  for (let n = count; n >= 1; n -= 1) {
    items.push(`<item><title>Post ${n}</title><link>https://blog.example.com/p${n}</link><guid>https://blog.example.com/p${n}</guid><pubDate>${new Date(Date.UTC(2026, 0, n, 12)).toUTCString()}</pubDate><description><![CDATA[<p>Excerpt ${n}</p>]]></description><enclosure url="https://blog.example.com/${n}.jpg" type="image/jpeg"/></item>`);
  }
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>The Blog</title><link>https://blog.example.com/</link>${items.join("")}</channel></rss>`;
}

const tablesExist = await db.execute(sql`select to_regclass('public.socialflow_automations') as t`).then((r) => Boolean((r.rows[0] as { t: string | null }).t)).catch(() => false);
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;

async function signup() {
  const agent = request.agent(app);
  const email = `automations-api-${Date.now()}-${counter++}@socialflow.test`;
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

describe.skipIf(!tablesExist)("automations API (test DB only)", () => {
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  describe("POST /automations/test-source", () => {
    it("returns the feed's title and its latest five items", async () => {
      const owner = await signup();
      handler = () => ({ body: feedOf(7) });
      const res = await owner.agent.post("/api/automations/test-source").send({ kind: "rss", url: "https://blog.example.com/feed" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, kind: "rss", url: "https://blog.example.com/feed", sourceTitle: "The Blog" });
      expect(res.body.items).toHaveLength(5);
      expect(() => TestAutomationSourceResponse.parse(res.body)).not.toThrow(); // matches the OpenAPI schema
      expect(res.body.items[0]).toEqual({ title: "Post 7", url: "https://blog.example.com/p7", publishedAt: "2026-01-07T12:00:00.000Z", imageUrl: "https://blog.example.com/7.jpg", excerpt: "Excerpt 7" });
    });

    it("accepts a bare WordPress address and reads the REST API", async () => {
      const owner = await signup();
      handler = (url) => url.pathname === "/wp-json/wp/v2/posts"
        ? { type: "application/json", body: JSON.stringify([{ id: 1, date_gmt: "2026-02-01T09:00:00", link: "https://wp.example.com/a/", title: { rendered: "A &amp; B" }, excerpt: { rendered: "<p>Ex</p>" }, guid: { rendered: "https://wp.example.com/?p=1" } }]) }
        : url.pathname === "/wp-json/" ? { type: "application/json", body: JSON.stringify({ name: "WP Site" }) } : { status: 404 };
      const res = await owner.agent.post("/api/automations/test-source").send({ kind: "wordpress", url: "wp.example.com/" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, url: "https://wp.example.com", sourceTitle: "WP Site" });
      expect(res.body.items).toEqual([{ title: "A & B", url: "https://wp.example.com/a/", publishedAt: "2026-02-01T09:00:00.000Z", imageUrl: null, excerpt: "Ex" }]);
    });

    it("refuses loopback, metadata, private and non-web addresses without fetching", async () => {
      const owner = await signup();
      handler = () => ({ body: feedOf(1) });
      for (const url of ["http://127.0.0.1/feed", "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd", "http://[::1]/feed", "https://intranet.example/feed", "http://user:pass@example.com/feed"]) {
        for (const kind of ["rss", "wordpress"]) {
          const res = await owner.agent.post("/api/automations/test-source").send({ kind, url });
          expect([url, kind, res.status, res.body.error]).toEqual([url, kind, 400, "invalid_url"]);
        }
      }
      expect(calls).toHaveLength(0);
    });

    it("a redirect to an internal address is refused too", async () => {
      const owner = await signup();
      handler = () => ({ status: 302, type: "text/html", body: "" });
      linkPreviewDeps.request = (async (url: URL): Promise<HopResponse> => {
        calls.push(url.toString());
        return { status: 302, headers: { location: "http://169.254.169.254/latest/" }, body: (async function* () { /* empty */ })(), destroy: vi.fn() };
      }) as never;
      const res = await owner.agent.post("/api/automations/test-source").send({ kind: "rss", url: "https://blog.example.com/feed" });
      expect([res.status, res.body.error]).toEqual([400, "invalid_url"]);
      expect(calls).toEqual(["https://blog.example.com/feed"]);
    });

    it("explains pages that aren't feeds (422), sites that fail (502) and bad input (400)", async () => {
      const owner = await signup();
      handler = () => ({ type: "text/html", body: "<html><title>Home</title></html>" });
      const notFeed = await owner.agent.post("/api/automations/test-source").send({ kind: "rss", url: "https://example.com/" });
      expect([notFeed.status, notFeed.body.error]).toEqual([422, "not_a_source"]);
      expect(notFeed.body.message).toMatch(/doesn't look like an RSS or Atom feed/);
      const notWp = await owner.agent.post("/api/automations/test-source").send({ kind: "wordpress", url: "https://example.com/" });
      expect(notWp.status).toBe(422);
      expect(notWp.body.message).toMatch(/doesn't look like a WordPress site/);
      handler = () => ({ type: "application/xml", body: "<notafeed><x/></notafeed>" });
      expect((await owner.agent.post("/api/automations/test-source").send({ kind: "rss", url: "https://example.com/x.xml" })).status).toBe(422);
      handler = () => ({ status: 503 });
      expect((await owner.agent.post("/api/automations/test-source").send({ kind: "rss", url: "https://example.com/feed" })).status).toBe(502);
      expect((await owner.agent.post("/api/automations/test-source").send({ kind: "atom", url: "https://example.com/feed" })).status).toBe(400);
      expect((await owner.agent.post("/api/automations/test-source").send({ kind: "rss" })).status).toBe(400);
      expect((await request(app).post("/api/automations/test-source").send({ kind: "rss", url: "https://example.com/feed" })).status).toBe(401);
    });
  });

  it("creates, lists, reads, updates and deletes; validates input; records audit entries", async () => {
    const owner = await signup();
    const fb = await account(owner.workspaceId, "facebook", "Acme Page");
    const li = await account(owner.workspaceId, "linkedin", "Acme Co");
    const yt = await account(owner.workspaceId, "youtube", "Acme TV");
    const stranger = await signup();
    const foreign = await account(stranger.workspaceId);

    const base = { kind: "rss", name: "Company blog", sourceUrl: "https://blog.example.com/feed", config: { connectedAccountIds: [fb.id] } };
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...base, kind: "twitter" }, /wordpress, rss or wordpress_plugin/],
      [{ ...base, name: "" }, /Name must be/],
      [{ ...base, name: "n".repeat(121) }, /Name must be/],
      [{ ...base, sourceUrl: "ftp://example.com/feed" }, /http/],
      [{ ...base, sourceUrl: "http://127.0.0.1/feed" }, /private or internal/],
      [{ ...base, sourceUrl: "https://example.com:8443/feed" }, /standard web ports/],
      [{ ...base, sourceUrl: `https://example.com/${"a".repeat(2050)}` }, /./],
      [{ ...base, config: {} }, /at least one account/],
      [{ ...base, config: { connectedAccountIds: [] } }, /at least one account/],
      [{ ...base, config: { connectedAccountIds: [foreign.id] } }, /don't exist in this workspace/],
      [{ ...base, config: { connectedAccountIds: ["nope"] } }, /accounts/],
      [{ ...base, config: { connectedAccountIds: [yt.id] } }, /YouTube/],
      [{ ...base, config: { connectedAccountIds: [fb.id], template: "No tokens here" } }, /\{title\} or \{url\}/],
      [{ ...base, config: { connectedAccountIds: [fb.id], template: `{title}${"x".repeat(2000)}` } }, /2,000 characters/],
      [{ ...base, config: { connectedAccountIds: [fb.id], maxPostsPerRun: 11 } }, /1 to 10/],
      [{ ...base, config: { connectedAccountIds: [fb.id], maxPostsPerRun: 0 } }, /1 to 10/],
      [{ ...base, config: { connectedAccountIds: [fb.id], mode: "blast" } }, /publish, queue or draft/],
      [{ ...base, config: { connectedAccountIds: [fb.id], includeImage: "yes" } }, /includeImage/],
    ];
    for (const [body, message] of bad) {
      const res = await owner.agent.post("/api/automations").send(body);
      expect([JSON.stringify(body).slice(0, 120), res.status]).toEqual([JSON.stringify(body).slice(0, 120), 400]);
      expect(res.body.message).toMatch(message);
    }

    const created = await owner.agent.post("/api/automations").send(base);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: "rss", name: "Company blog", sourceUrl: "https://blog.example.com/feed", status: "active", lastRunAt: null, lastStatus: null, lastError: null, postsCreatedTotal: 0,
      config: { connectedAccountIds: [fb.id], mode: "publish", template: "{title}\n\n{url}", includeImage: true, maxPostsPerRun: 3, postExistingOnFirstRun: false },
      accounts: [{ id: fb.id, name: "Acme Page", platform: "facebook", status: "active" }],
    });
    expect(new Date(created.body.nextRunAt).getTime()).toBeLessThanOrEqual(Date.now());
    const id = created.body.id as string;
    expect(() => CreateAutomationResponse.parse(created.body)).not.toThrow();

    const wp = await owner.agent.post("/api/automations").send({ kind: "wordpress", name: "WP", sourceUrl: "wp.example.com/", config: { connectedAccountIds: [fb.id, li.id], mode: "draft", template: "{title} via {site}", maxPostsPerRun: 5, includeImage: false, postExistingOnFirstRun: true } });
    expect(wp.status).toBe(201);
    expect(wp.body).toMatchObject({ sourceUrl: "https://wp.example.com", config: { mode: "draft", template: "{title} via {site}", maxPostsPerRun: 5, includeImage: false, postExistingOnFirstRun: true } });
    expect(wp.body.accounts.map((a: { name: string }) => a.name)).toEqual(["Acme Page", "Acme Co"]);

    const list = await owner.agent.get("/api/automations");
    expect(list.status).toBe(200);
    expect(list.body.limit).toBe(25);
    // How often each kind is checked, so the page can say so without guessing.
    expect(list.body.pollMinutes).toEqual({ wordpress: 15, rss: 60 });
    expect(() => ListAutomationsResponse.parse(list.body)).not.toThrow();
    expect(list.body.automations.map((a: { name: string }) => a.name)).toEqual(["Company blog", "WP"]);
    expect((await owner.agent.get(`/api/automations/${id}`)).body.name).toBe("Company blog");
    expect((await owner.agent.get("/api/automations/not-a-uuid")).status).toBe(404);

    // Update: partial config merges; accounts are re-checked against the workspace.
    const renamed = await owner.agent.patch(`/api/automations/${id}`).send({ name: "Blog to social", config: { maxPostsPerRun: 2, connectedAccountIds: [li.id] } });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Blog to social", config: { connectedAccountIds: [li.id], maxPostsPerRun: 2, template: "{title}\n\n{url}", mode: "publish" } });
    expect((await owner.agent.patch(`/api/automations/${id}`).send({ config: { connectedAccountIds: [foreign.id] } })).status).toBe(400);
    expect((await owner.agent.patch(`/api/automations/${id}`).send({ config: { template: "nothing" } })).status).toBe(400);
    expect((await owner.agent.patch(`/api/automations/${id}`).send({ kind: "wordpress" })).status).toBe(400);
    expect((await owner.agent.patch(`/api/automations/${id}`).send({ sourceUrl: "javascript:alert(1)" })).status).toBe(400);
    // A new source address means a new baseline.
    await db.update(automationsTable).set({ baselineAt: new Date(), consecutiveFailures: 3 }).where(eq(automationsTable.id, id));
    expect((await owner.agent.patch(`/api/automations/${id}`).send({ sourceUrl: "https://other.example.com/rss" })).body.sourceUrl).toBe("https://other.example.com/rss");
    const [row] = await db.select().from(automationsTable).where(eq(automationsTable.id, id));
    expect(row).toMatchObject({ baselineAt: null, consecutiveFailures: 0 });

    expect((await owner.agent.delete(`/api/automations/${id}`)).status).toBe(204);
    expect((await owner.agent.get(`/api/automations/${id}`)).status).toBe(404);
    expect((await owner.agent.delete(`/api/automations/${id}`)).status).toBe(404);

    const audit = await db.select({ action: auditLogTable.action }).from(auditLogTable).where(eq(auditLogTable.workspaceId, owner.workspaceId));
    const actions = audit.map((entry) => entry.action);
    expect(actions.filter((action) => action === "automation.create")).toHaveLength(2);
    expect(actions).toEqual(expect.arrayContaining(["automation.update", "automation.delete"]));
  });

  it("allows at most 25 automations per workspace", async () => {
    const owner = await signup();
    const fb = await account(owner.workspaceId);
    const config = { connectedAccountIds: [fb.id], mode: "publish" as const, template: "{title}", includeImage: true, maxPostsPerRun: 3, postExistingOnFirstRun: false };
    await db.insert(automationsTable).values(Array.from({ length: 24 }, (_, i) => ({ workspaceId: owner.workspaceId, kind: "rss" as const, name: `A${i}`, sourceUrl: `https://e.com/${i}`, config, status: "paused" as const })));
    const body = { kind: "rss", name: "One more", sourceUrl: "https://e.com/feed", config: { connectedAccountIds: [fb.id] } };
    expect((await owner.agent.post("/api/automations").send(body)).status).toBe(201);
    const over = await owner.agent.post("/api/automations").send(body);
    expect([over.status, over.body.error]).toEqual([400, "limit_reached"]);
  });

  it("run now, pause and resume; runs and items are listed with the post each item became", async () => {
    const owner = await signup();
    const fb = await account(owner.workspaceId);
    handler = () => ({ body: feedOf(2) });
    const created = await owner.agent.post("/api/automations").send({ kind: "rss", name: "Blog", sourceUrl: "https://blog.example.com/feed", config: { connectedAccountIds: [fb.id] } });
    const id = created.body.id as string;

    const baseline = await owner.agent.post(`/api/automations/${id}/run-now`);
    expect(baseline.status).toBe(200);
    expect(baseline.body.run).toMatchObject({ status: "no_new", itemsFound: 2, itemsNew: 0, postsCreated: 0, error: null });
    expect(baseline.body.automation).toMatchObject({ id, lastStatus: "no_new", postsCreatedTotal: 0 });
    expect(baseline.body.automation.lastRunAt).not.toBeNull();

    handler = () => ({ body: feedOf(3) });
    const second = await owner.agent.post(`/api/automations/${id}/run-now`);
    expect(second.body.run).toMatchObject({ status: "success", itemsNew: 1, postsCreated: 1 });
    expect(second.body.automation.postsCreatedTotal).toBe(1);
    expect(() => RunAutomationNowResponse.parse(second.body)).not.toThrow();
    // Run now twice more: still one post.
    await owner.agent.post(`/api/automations/${id}/run-now`);
    await owner.agent.post(`/api/automations/${id}/run-now`);
    const posts = await db.select().from(postsTable).where(eq(postsTable.workspaceId, owner.workspaceId));
    expect(posts).toHaveLength(1);

    const runs = await owner.agent.get(`/api/automations/${id}/runs`);
    expect(runs.body.runs.map((run: { status: string }) => run.status)).toEqual(["no_new", "no_new", "success", "no_new"]);
    expect(runs.body.runs[2]).toMatchObject({ automationId: id, itemsFound: 3, postsCreated: 1 });
    expect(() => ListAutomationRunsResponse.parse(runs.body)).not.toThrow();
    const items = await owner.agent.get(`/api/automations/${id}/items`);
    expect(() => ListAutomationItemsResponse.parse(items.body)).not.toThrow();
    expect(items.body.items).toHaveLength(3);
    const posted = items.body.items.find((item: { status: string }) => item.status === "posted");
    expect(posted).toMatchObject({ title: "Post 3", url: "https://blog.example.com/p3", postId: posts[0]!.id, postStatus: "scheduled", attempts: 1, error: null });
    expect(items.body.items.filter((item: { status: string }) => item.status === "seen")).toHaveLength(2);
    expect(items.body.items.find((item: { status: string }) => item.status === "seen")).toMatchObject({ postId: null, postStatus: null });

    const paused = await owner.agent.post(`/api/automations/${id}/pause`);
    expect(paused.body).toMatchObject({ status: "paused", nextRunAt: null });
    expect(() => PauseAutomationResponse.parse(paused.body)).not.toThrow();
    // A source failure while paused doesn't flip it to "error", and resume clears the failure count.
    handler = () => ({ status: 500 });
    for (let i = 0; i < 5; i += 1) expect((await owner.agent.post(`/api/automations/${id}/run-now`)).body.run.status).toBe("failed");
    expect((await owner.agent.get(`/api/automations/${id}`)).body).toMatchObject({ status: "paused", consecutiveFailures: 5 });
    const resumed = await owner.agent.post(`/api/automations/${id}/resume`);
    expect(resumed.body).toMatchObject({ status: "active", consecutiveFailures: 0 });
    expect(new Date(resumed.body.nextRunAt).getTime()).toBeLessThanOrEqual(Date.now());

    // Five failures in a row while active put it into "error"; resume brings it back.
    for (let i = 0; i < 5; i += 1) await owner.agent.post(`/api/automations/${id}/run-now`);
    const errored = await owner.agent.get(`/api/automations/${id}`);
    expect(errored.body).toMatchObject({ status: "error", nextRunAt: null });
    expect(errored.body.lastError).toMatch(/Stopped after 5 failed checks/);
    expect((await owner.agent.post(`/api/automations/${id}/resume`)).body).toMatchObject({ status: "active", consecutiveFailures: 0 });

    const actions = (await db.select({ action: auditLogTable.action }).from(auditLogTable).where(eq(auditLogTable.workspaceId, owner.workspaceId))).map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(["automation.create", "automation.pause", "automation.resume"]));
  });

  it("permissions: viewers and approvers read, editors manage; workspaces are isolated", async () => {
    const owner = await signup();
    const fb = await account(owner.workspaceId);
    handler = () => ({ body: feedOf(1) });
    const body = { kind: "rss", name: "Blog", sourceUrl: "https://blog.example.com/feed", config: { connectedAccountIds: [fb.id] } };
    const created = await owner.agent.post("/api/automations").send(body);
    const id = created.body.id as string;

    const viewer = await addMember(owner, "viewer");
    expect((await viewer.agent.get("/api/automations")).body.automations).toHaveLength(1);
    expect((await viewer.agent.get(`/api/automations/${id}`)).status).toBe(200);
    expect((await viewer.agent.get(`/api/automations/${id}/runs`)).status).toBe(200);
    expect((await viewer.agent.get(`/api/automations/${id}/items`)).status).toBe(200);
    expect((await viewer.agent.post("/api/automations").send(body)).status).toBe(403);
    expect((await viewer.agent.patch(`/api/automations/${id}`).send({ name: "x" })).status).toBe(403);
    expect((await viewer.agent.delete(`/api/automations/${id}`)).status).toBe(403);
    expect((await viewer.agent.post(`/api/automations/${id}/pause`)).status).toBe(403);
    expect((await viewer.agent.post(`/api/automations/${id}/resume`)).status).toBe(403);
    expect((await viewer.agent.post(`/api/automations/${id}/run-now`)).status).toBe(403);
    expect((await viewer.agent.post("/api/automations/test-source").send({ kind: "rss", url: "https://blog.example.com/feed" })).status).toBe(403);
    expect(calls).toHaveLength(0);

    const editor = await addMember(owner, "editor");
    expect((await editor.agent.patch(`/api/automations/${id}`).send({ name: "Edited" })).status).toBe(200);
    expect((await editor.agent.post(`/api/automations/${id}/pause`)).status).toBe(200);

    const me = await viewer.agent.get("/api/auth/me");
    expect(me.body.permissions).toContain("automations:read");
    expect(me.body.permissions).not.toContain("automations:manage");

    const stranger = await signup();
    expect((await stranger.agent.get("/api/automations")).body.automations).toEqual([]);
    for (const res of [
      await stranger.agent.get(`/api/automations/${id}`),
      await stranger.agent.patch(`/api/automations/${id}`).send({ name: "mine now" }),
      await stranger.agent.delete(`/api/automations/${id}`),
      await stranger.agent.post(`/api/automations/${id}/pause`),
      await stranger.agent.post(`/api/automations/${id}/resume`),
      await stranger.agent.post(`/api/automations/${id}/run-now`),
      await stranger.agent.get(`/api/automations/${id}/runs`),
      await stranger.agent.get(`/api/automations/${id}/items`),
    ]) expect(res.status).toBe(404);
    expect((await owner.agent.get(`/api/automations/${id}`)).body.name).toBe("Edited");
    for (const path of ["/api/automations", `/api/automations/${id}`, `/api/automations/${id}/runs`]) expect((await request(app).get(path)).status).toBe(401);
  });
});
