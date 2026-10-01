import { asc, eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automationItemsTable, automationsTable, connectedAccountsTable, db, postTargetsTable, postsTable, usersTable, workspacesTable, type AutomationConfig } from "@workspace/db";
import app from "../app";
import { claimDueAutomations, nextRunAfter, renderTemplate, runAutomation } from "./automations";
import { FeedError, fetchSource, htmlToText, normalizeItemKey, normalizeSiteUrl, parseFeedXml, parseWordPressPosts } from "./feeds";
import { linkPreviewDeps, type HopResponse } from "./link-preview";
import { saveConnectedAccount } from "./oauth/accounts";

// Automations: feed parsing (fixtures), and the runner against the test database with the network stubbed at the
// SSRF-safe fetcher's seams. Nothing here reaches a real website.

const realDeps = { ...linkPreviewDeps };
afterEach(() => {
  Object.assign(linkPreviewDeps, realDeps);
  vi.unstubAllEnvs();
});

type Served = { status?: number; type?: string; body?: string };
/** Answers every request through `handler`; hosts resolve to a public address unless `dns` says otherwise. */
function serve(handler: (url: URL) => Served, dns: Record<string, string> = {}) {
  const calls: string[] = [];
  linkPreviewDeps.lookup = async (host) => [{ address: dns[host] ?? "93.184.216.34", family: 4 }];
  linkPreviewDeps.request = (async (url: URL): Promise<HopResponse> => {
    calls.push(url.toString());
    const { status = 200, type = "application/rss+xml; charset=utf-8", body = "" } = handler(url);
    return { status, headers: { "content-type": type }, body: (async function* () { yield Buffer.from(body); })(), destroy: vi.fn() };
  }) as never;
  return calls;
}

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Acme &amp; Co Blog</title>
  <atom:link href="https://blog.example.com/feed/" rel="self" type="application/rss+xml"/>
  <link>https://blog.example.com/</link>
  <item>
    <title>First post</title>
    <link>https://blog.example.com/first/</link>
    <guid>https://blog.example.com/first/</guid>
    <pubDate>Mon, 01 Jun 2026 10:00:00 +0000</pubDate>
    <description>Plain &lt;i&gt;text&lt;/i&gt; with &amp;nbsp; entities</description>
    <media:content url="https://blog.example.com/img/1.png" medium="image"/>
  </item>
  <item>
    <title>Second post&#8217;s title</title>
    <link>https://blog.example.com/second/?utm=1&amp;x=2</link>
    <guid isPermaLink="false">https://blog.example.com/?p=2</guid>
    <pubDate>Tue, 02 Jun 2026 10:00:00 +0000</pubDate>
    <dc:creator><![CDATA[Jane Doe]]></dc:creator>
    <description><![CDATA[<p>Hello &amp; <b>welcome</b> to the second post. [&#8230;]</p>]]></description>
    <enclosure url="https://blog.example.com/img/2.jpg" type="image/jpeg" length="1000"/>
  </item>
  <item>
    <title>No guid</title>
    <link>/third/</link>
    <description><![CDATA[<img src="/img/3.jpg" alt=""><script>alert(1)</script>Third]]></description>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <title type="text">Atom News</title>
  <link href="https://news.example.org/" rel="alternate"/>
  <entry>
    <title type="html">Older &amp;amp; wiser</title>
    <link rel="self" href="https://news.example.org/api/1"/>
    <link rel="alternate" type="text/html" href="https://news.example.org/older"/>
    <id>tag:news.example.org,2026:1</id>
    <updated>2026-05-01T08:00:00Z</updated>
    <summary>Short summary</summary>
    <author><name>Sam</name></author>
  </entry>
  <entry>
    <title>Newer</title>
    <link href="https://news.example.org/newer"/>
    <id>tag:news.example.org,2026:2</id>
    <published>2026-05-03T08:00:00Z</published>
    <updated>2026-05-04T08:00:00Z</updated>
    <content type="html">&lt;p&gt;Full &lt;em&gt;content&lt;/em&gt;&lt;/p&gt;</content>
    <media:thumbnail url="https://news.example.org/t.jpg"/>
  </entry>
</feed>`;

const WP_POSTS = [
  {
    id: 42, date: "2026-06-02T15:30:00", date_gmt: "2026-06-02T10:00:00", link: "https://wp.example.com/hello-world/",
    guid: { rendered: "https://wp.example.com/?p=42" }, title: { rendered: "Hello &#8211; World" },
    excerpt: { rendered: "<p>An excerpt with <a href=\"#\">a link</a> &hellip; [&hellip;]</p>\n" },
    _embedded: { author: [{ name: "Priya" }], "wp:featuredmedia": [{ source_url: "https://wp.example.com/wp-content/uploads/a.jpg" }] },
  },
  { id: 41, date_gmt: "2026-06-01T10:00:00", link: "https://wp.example.com/older/", guid: { rendered: "https://wp.example.com/?p=41" }, title: { rendered: "Older" }, excerpt: { rendered: "" } },
];

describe("parsing", () => {
  it("reads RSS 2.0: newest first, entities decoded, tags stripped, images from enclosure / media / img", () => {
    const feed = parseFeedXml(RSS, "https://blog.example.com/feed/");
    expect(feed.sourceTitle).toBe("Acme & Co Blog");
    expect(feed.items.map((item) => item.title)).toEqual(["Second post’s title", "First post", "No guid"]);
    const [second, first, third] = feed.items;
    expect(second).toMatchObject({
      key: "blog.example.com?p=2", url: "https://blog.example.com/second/?utm=1&x=2", author: "Jane Doe",
      excerpt: "Hello & welcome to the second post.", imageUrl: "https://blog.example.com/img/2.jpg",
    });
    expect(second!.publishedAt!.toISOString()).toBe("2026-06-02T10:00:00.000Z");
    expect(first).toMatchObject({ key: "blog.example.com/first", excerpt: "Plain text with entities", imageUrl: "https://blog.example.com/img/1.png", author: null });
    // No guid: the link (resolved against the channel) is the key; scripts never reach the excerpt.
    expect(third).toMatchObject({ key: "blog.example.com/third", url: "https://blog.example.com/third/", excerpt: "Third", imageUrl: "https://blog.example.com/img/3.jpg", publishedAt: null });
  });

  it("reads Atom: alternate link, id, published/updated, summary or content, author", () => {
    const feed = parseFeedXml(ATOM, "https://news.example.org/atom.xml");
    expect(feed.sourceTitle).toBe("Atom News");
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toMatchObject({ key: "tag:news.example.org,2026:2", title: "Newer", url: "https://news.example.org/newer", excerpt: "Full content", imageUrl: "https://news.example.org/t.jpg" });
    expect(feed.items[0]!.publishedAt!.toISOString()).toBe("2026-05-03T08:00:00.000Z");
    expect(feed.items[1]).toMatchObject({ key: "tag:news.example.org,2026:1", title: "Older & wiser", url: "https://news.example.org/older", excerpt: "Short summary", author: "Sam" });
  });

  it("reads WordPress REST posts with embedded author and featured image", () => {
    const items = parseWordPressPosts(WP_POSTS, "https://wp.example.com");
    expect(items[0]).toMatchObject({
      key: "wp.example.com?p=42", title: "Hello – World", url: "https://wp.example.com/hello-world/", author: "Priya",
      imageUrl: "https://wp.example.com/wp-content/uploads/a.jpg", excerpt: "An excerpt with a link …",
    });
    expect(items[0]!.publishedAt!.toISOString()).toBe("2026-06-02T10:00:00.000Z");
    expect(items[1]).toMatchObject({ title: "Older", imageUrl: null, author: null, excerpt: "" });
    expect(() => parseWordPressPosts({ code: "rest_no_route" }, "https://wp.example.com")).toThrow(FeedError);
  });

  it("refuses documents that aren't feeds, and entity declarations", () => {
    expect(() => parseFeedXml("<html><body>Hi</body></html>", "https://e.com")).toThrow(/RSS or Atom/);
    expect(() => parseFeedXml("not xml at all", "https://e.com")).toThrow(FeedError);
    expect(() => parseFeedXml(`<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]><rss><channel><item><title>&a;</title><link>https://e.com/1</link></item></channel></rss>`, "https://e.com")).toThrow(FeedError);
  });

  it("helpers: text, keys, site addresses, template tokens, backoff", () => {
    expect(htmlToText("<p>Tom &amp; Jerry&#39;s<br>show</p><style>p{}</style>")).toBe("Tom & Jerry's show");
    expect(normalizeItemKey(" HTTPS://Blog.Example.com/a/#frag ")).toBe("blog.example.com/a");
    expect(normalizeItemKey("urn:uuid:123")).toBe("urn:uuid:123");
    expect(normalizeSiteUrl("blog.example.com/")).toBe("https://blog.example.com");
    expect(normalizeSiteUrl("http://example.com/blog/?x=1")).toBe("http://example.com/blog");
    expect(() => normalizeSiteUrl("ftp://example.com")).toThrow(FeedError);
    const item = { key: "k", title: "Title", url: "https://e.com/a", publishedAt: null, imageUrl: null, excerpt: "An excerpt", author: null };
    expect(renderTemplate("{title}\n\n{url}", item, "Site")).toBe("Title\n\nhttps://e.com/a");
    expect(renderTemplate("New on {site}: {title} by {author}\n{excerpt}\n\n\n\n{url}", item, "Site")).toBe("New on Site: Title by\nAn excerpt\n\nhttps://e.com/a");
    const now = new Date("2026-01-01T00:00:00Z");
    expect(nextRunAfter("rss", 0, now).toISOString()).toBe("2026-01-01T01:00:00.000Z");
    expect(nextRunAfter("wordpress", 0, now).toISOString()).toBe("2026-01-01T00:15:00.000Z");
    expect(nextRunAfter("rss", 2, now).toISOString()).toBe("2026-01-01T04:00:00.000Z");
    expect(nextRunAfter("rss", 9, now).toISOString()).toBe("2026-01-02T00:00:00.000Z"); // capped at 24 h
    vi.stubEnv("RSS_POLL_MINUTES", "30");
    expect(nextRunAfter("rss", 0, now).toISOString()).toBe("2026-01-01T00:30:00.000Z");
  });
});

describe("fetchSource", () => {
  it("WordPress: uses the REST API and the site's name", async () => {
    const calls = serve((url) => url.pathname === "/wp-json/wp/v2/posts" ? { type: "application/json; charset=UTF-8", body: JSON.stringify(WP_POSTS) }
      : url.pathname === "/wp-json/" ? { type: "application/json", body: JSON.stringify({ name: "My WP &amp; Site" }) } : { status: 404 });
    const result = await fetchSource("wordpress", "wp.example.com/");
    expect(result.sourceTitle).toBe("My WP & Site");
    expect(result.items).toHaveLength(2);
    expect(calls[0]).toBe("https://wp.example.com/wp-json/wp/v2/posts?per_page=10&orderby=date&order=desc&_embed=1&status=publish");
  });

  it("WordPress: falls back to /feed/ when the REST API is off (404, 401 or HTML)", async () => {
    for (const rest of [{ status: 404 }, { status: 401 }, { type: "text/html", body: "<html>login</html>" }, { type: "application/json", body: "{not json" }] as Served[]) {
      const calls = serve((url) => (url.pathname.startsWith("/wp-json") ? rest : url.pathname === "/feed/" ? { body: RSS } : { status: 404 }));
      const result = await fetchSource("wordpress", "https://blog.example.com");
      expect(result.items).toHaveLength(3);
      expect(calls.at(-1)).toBe("https://blog.example.com/feed/");
    }
  });

  it("says so when a site is neither", async () => {
    serve(() => ({ type: "text/html", body: "<html></html>" }));
    await expect(fetchSource("wordpress", "https://example.com")).rejects.toMatchObject({ code: "not_a_source", message: expect.stringMatching(/doesn't look like a WordPress site/) });
    await expect(fetchSource("rss", "https://example.com/feed")).rejects.toMatchObject({ code: "not_a_source", message: expect.stringMatching(/RSS or Atom/) });
    serve(() => ({ status: 500 }));
    await expect(fetchSource("rss", "https://example.com/feed")).rejects.toMatchObject({ code: "fetch_failed" });
  });

  it("refuses private and non-web addresses without making a request", async () => {
    const calls = serve(() => ({ body: RSS }), { "intranet.example": "10.0.0.5" });
    for (const url of ["http://127.0.0.1/feed", "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd", "http://localhost/feed", "https://intranet.example/feed", "https://example.com:8443/feed"]) {
      await expect(fetchSource("rss", url)).rejects.toMatchObject({ code: "invalid_url" });
      await expect(fetchSource("wordpress", url)).rejects.toMatchObject({ code: "invalid_url" });
    }
    expect(calls).toHaveLength(0);
  });
});

/* ---------- the runner, against the test database ---------- */

const tablesExist = await db.execute(sql`select to_regclass('public.socialflow_automations') as t`).then((r) => Boolean((r.rows[0] as { t: string | null }).t)).catch(() => false);
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;

/** A feed with items numbered `from`..`to`; a higher number is newer. */
function feedOf(from: number, to: number): string {
  const items: string[] = [];
  for (let n = to; n >= from; n -= 1) {
    items.push(`<item><title>Post ${n}</title><link>https://blog.example.com/p${n}</link><guid isPermaLink="false">post-${n}</guid><pubDate>${new Date(Date.UTC(2026, 0, n, 12)).toUTCString()}</pubDate><description>Excerpt ${n}</description><enclosure url="https://blog.example.com/img/${n}.jpg" type="image/jpeg"/></item>`);
  }
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title><link>https://blog.example.com/</link>${items.join("")}</channel></rss>`;
}

describe.skipIf(!tablesExist)("runner (database, test DB only)", () => {
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  let current = feedOf(1, 3);
  let status = 200;
  beforeEach(() => {
    current = feedOf(1, 3);
    status = 200;
    serve(() => ({ status, body: current }));
  });

  async function setup(config: Partial<AutomationConfig> = {}, platform: "facebook" | "instagram" = "facebook") {
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ email: `automations-${Date.now()}-${counter++}@socialflow.test`, password: "correct horse battery staple" });
    expect(signup.status).toBe(201);
    createdUserIds.add(signup.body.user.id);
    createdWorkspaceIds.add(signup.body.workspace.id);
    const workspaceId = signup.body.workspace.id as string;
    const account = await saveConnectedAccount(db, workspaceId, platform, {
      externalAccountId: `acct-${counter++}`, accountType: platform === "facebook" ? "facebook_page" : "instagram_business", displayName: "Acme", username: "acme", avatarUrl: null, accessToken: "TOKEN",
      refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: [], metadata: {}, selectable: true, warnings: [],
    }, "u");
    const [automation] = await db.insert(automationsTable).values({
      workspaceId, kind: "rss", name: "Blog", sourceUrl: "https://blog.example.com/feed", status: "active", nextRunAt: new Date(), createdByUserId: signup.body.user.id,
      config: { connectedAccountIds: [account.id], mode: "publish", template: "{title}\n\n{url}", includeImage: true, maxPostsPerRun: 3, postExistingOnFirstRun: false, ...config },
    }).returning();
    const posts = () => db.select().from(postsTable).where(eq(postsTable.workspaceId, workspaceId)).orderBy(asc(postsTable.createdAt), asc(postsTable.scheduledAt));
    const items = () => db.select().from(automationItemsTable).where(eq(automationItemsTable.automationId, automation!.id));
    const reload = async () => (await db.select().from(automationsTable).where(eq(automationsTable.id, automation!.id)))[0]!;
    return { workspaceId, account, automation: automation!, posts, items, reload, userId: signup.body.user.id as string };
  }

  it("first run is a baseline: everything already there is recorded as seen and nothing is posted", async () => {
    const t = await setup();
    const run = await runAutomation(t.automation.id);
    expect(run).toMatchObject({ status: "no_new", itemsFound: 3, postsCreated: 0, error: null });
    expect(await t.posts()).toHaveLength(0);
    expect((await t.items()).map((item) => item.status)).toEqual(["seen", "seen", "seen"]);
    const after = await t.reload();
    expect(after.baselineAt).not.toBeNull();
    expect(after).toMatchObject({ lastStatus: "no_new", consecutiveFailures: 0, status: "active" });
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it("a new item becomes exactly one post with the link card and the right targets; running again adds nothing", async () => {
    const t = await setup();
    await runAutomation(t.automation.id);
    current = feedOf(1, 4);
    const before = Date.now();
    const run = await runAutomation(t.automation.id);
    expect(run).toMatchObject({ status: "success", itemsFound: 4, itemsNew: 1, postsCreated: 1 });
    const posts = await t.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      content: "Post 4\n\nhttps://blog.example.com/p4", status: "scheduled", createdByUserId: t.userId,
      linkUrl: "https://blog.example.com/p4", linkTitle: "Post 4", linkDescription: "Excerpt 4", linkImageUrl: "https://blog.example.com/img/4.jpg",
    });
    // "publish" mode: due now, so the publisher (and the approvals gate) picks it up on its next pass.
    expect(posts[0]!.scheduledAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(posts[0]!.scheduledAt!.getTime()).toBeLessThanOrEqual(Date.now());
    const targets = await db.select().from(postTargetsTable).where(eq(postTargetsTable.postId, posts[0]!.id));
    expect(targets.map((target) => [target.connectedAccountId, target.status])).toEqual([[t.account.id, "scheduled"]]);
    const item = (await t.items()).find((row) => row.itemKey === "post-4")!;
    expect(item).toMatchObject({ status: "posted", postId: posts[0]!.id, attempts: 1, error: null });

    expect(await runAutomation(t.automation.id)).toMatchObject({ status: "no_new", postsCreated: 0 });
    expect(await t.posts()).toHaveLength(1);
  });

  it("concurrent runs create one post per item", async () => {
    const t = await setup();
    await runAutomation(t.automation.id);
    current = feedOf(1, 5);
    const runs = await Promise.all([runAutomation(t.automation.id), runAutomation(t.automation.id), runAutomation(t.automation.id)]);
    expect(runs.reduce((sum, run) => sum + run!.postsCreated, 0)).toBe(2);
    const posts = await t.posts();
    expect(posts.map((post) => post.linkUrl).sort()).toEqual(["https://blog.example.com/p4", "https://blog.example.com/p5"]);
    expect((await t.items()).filter((item) => item.status === "posted")).toHaveLength(2);
  });

  it("caps posts per run at maxPostsPerRun, newest first, posting the older of them first; the rest follow next run", async () => {
    const t = await setup({ maxPostsPerRun: 2 });
    await runAutomation(t.automation.id);
    current = feedOf(1, 8); // five new items: 4..8
    expect(await runAutomation(t.automation.id)).toMatchObject({ status: "success", itemsNew: 5, postsCreated: 2 });
    expect((await t.posts()).map((post) => post.linkTitle)).toEqual(["Post 7", "Post 8"]);
    expect((await t.items()).filter((item) => item.status !== "seen")).toHaveLength(2); // the rest stay unrecorded
    expect(await runAutomation(t.automation.id)).toMatchObject({ itemsNew: 3, postsCreated: 2 });
    expect((await t.posts()).map((post) => post.linkTitle)).toEqual(["Post 7", "Post 8", "Post 5", "Post 6"]);
    expect(await runAutomation(t.automation.id)).toMatchObject({ postsCreated: 1 });
    expect(await runAutomation(t.automation.id)).toMatchObject({ status: "no_new", postsCreated: 0 });
    expect(await t.posts()).toHaveLength(5);
  });

  it("postExistingOnFirstRun posts only the newest existing item", async () => {
    const t = await setup({ postExistingOnFirstRun: true });
    expect(await runAutomation(t.automation.id)).toMatchObject({ status: "success", postsCreated: 1 });
    expect((await t.posts()).map((post) => post.linkTitle)).toEqual(["Post 3"]);
    expect((await t.items()).map((item) => item.status).sort()).toEqual(["posted", "seen", "seen"]);
    expect(await runAutomation(t.automation.id)).toMatchObject({ status: "no_new" });
  });

  it("draft and queue modes: drafts are drafts; a queue with no slots falls back to a draft and says why", async () => {
    const draft = await setup({ mode: "draft", postExistingOnFirstRun: true });
    await runAutomation(draft.automation.id);
    expect((await draft.posts())[0]).toMatchObject({ status: "draft", scheduledAt: null });
    const queue = await setup({ mode: "queue", postExistingOnFirstRun: true });
    expect(await runAutomation(queue.automation.id)).toMatchObject({ status: "success", postsCreated: 1 });
    expect((await queue.posts())[0]).toMatchObject({ status: "draft" });
    expect((await queue.items()).find((item) => item.status === "posted")!.error).toMatch(/Saved as a draft: .*no posting schedule/);
  });

  it("Instagram gets the link's picture; without one the item fails with the reason", async () => {
    const withImage = await setup({ postExistingOnFirstRun: true }, "instagram");
    expect(await runAutomation(withImage.automation.id)).toMatchObject({ status: "success", postsCreated: 1 });
    expect((await withImage.posts())[0]!.linkImageUrl).toBe("https://blog.example.com/img/3.jpg");
    const without = await setup({ postExistingOnFirstRun: true, includeImage: false }, "instagram");
    const run = await runAutomation(without.automation.id);
    expect(run).toMatchObject({ status: "failed", postsCreated: 0 });
    expect(run!.error).toMatch(/Instagram posts need an image/);
    expect(await without.posts()).toHaveLength(0);
  });

  it("fetch failures back off and stop the automation after five in a row; success resets the count", async () => {
    const t = await setup();
    await runAutomation(t.automation.id);
    status = 500;
    const now = new Date();
    const first = await runAutomation(t.automation.id, now);
    expect(first).toMatchObject({ status: "failed", postsCreated: 0 });
    expect(first!.error).toMatch(/500/);
    let state = await t.reload();
    expect(state).toMatchObject({ status: "active", consecutiveFailures: 1, lastStatus: "failed" });
    expect(state.nextRunAt!.getTime()).toBe(now.getTime() + 2 * 60 * 60_000); // hourly x 2^1

    status = 200;
    await runAutomation(t.automation.id);
    expect(await t.reload()).toMatchObject({ consecutiveFailures: 0, lastStatus: "no_new", lastError: null });

    status = 500;
    for (let i = 1; i <= 4; i += 1) {
      await runAutomation(t.automation.id, now);
      state = await t.reload();
      expect(state).toMatchObject({ status: "active", consecutiveFailures: i });
      expect(state.nextRunAt!.getTime()).toBe(now.getTime() + Math.min(2 ** i, 24) * 60 * 60_000);
    }
    await runAutomation(t.automation.id, now);
    state = await t.reload();
    expect(state).toMatchObject({ status: "error", consecutiveFailures: 5 });
    expect(state.lastError).toMatch(/Stopped after 5 failed checks/);
    // An automation in "error" is no longer polled.
    await db.update(automationsTable).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(automationsTable.id, t.automation.id));
    expect(await claimDueAutomations(1000)).not.toContain(t.automation.id);
  });

  it("an item that can't be posted is retried on later runs, three attempts at most", async () => {
    const t = await setup();
    await runAutomation(t.automation.id);
    await db.update(connectedAccountsTable).set({ status: "expired" }).where(eq(connectedAccountsTable.id, t.account.id));
    current = feedOf(1, 4);
    const run = await runAutomation(t.automation.id);
    expect(run).toMatchObject({ status: "failed", postsCreated: 0 });
    expect(run!.error).toMatch(/Post 4: Acme needs to be reconnected/);
    const item = async () => (await t.items()).find((row) => row.itemKey === "post-4")!;
    expect(await item()).toMatchObject({ status: "failed", attempts: 1, postId: null });
    // An item failure is not a source failure: no backoff.
    expect(await t.reload()).toMatchObject({ status: "active", consecutiveFailures: 0, lastStatus: "failed" });

    await runAutomation(t.automation.id);
    await runAutomation(t.automation.id);
    expect(await item()).toMatchObject({ status: "failed", attempts: 3 });
    // Out of attempts: left failed even once the account works again.
    await db.update(connectedAccountsTable).set({ status: "active" }).where(eq(connectedAccountsTable.id, t.account.id));
    expect(await runAutomation(t.automation.id)).toMatchObject({ status: "no_new" });
    expect(await item()).toMatchObject({ status: "failed", attempts: 3 });
    expect(await t.posts()).toHaveLength(0);
  });

  it("a retry that works posts the item once", async () => {
    const t = await setup();
    await runAutomation(t.automation.id);
    await db.update(connectedAccountsTable).set({ status: "expired" }).where(eq(connectedAccountsTable.id, t.account.id));
    current = feedOf(1, 4);
    await runAutomation(t.automation.id);
    await db.update(connectedAccountsTable).set({ status: "active" }).where(eq(connectedAccountsTable.id, t.account.id));
    const [a, b] = await Promise.all([runAutomation(t.automation.id), runAutomation(t.automation.id)]);
    expect(a!.postsCreated + b!.postsCreated).toBe(1);
    expect(await t.posts()).toHaveLength(1);
    expect((await t.items()).find((row) => row.itemKey === "post-4")).toMatchObject({ status: "posted", attempts: 2, error: null });
  });

  it("an account removed from the workspace fails the item with a clear message", async () => {
    const t = await setup();
    await runAutomation(t.automation.id);
    await db.delete(connectedAccountsTable).where(eq(connectedAccountsTable.id, t.account.id));
    current = feedOf(1, 4);
    const run = await runAutomation(t.automation.id);
    expect(run!.error).toMatch(/accounts no longer exist/);
  });

  it("claims due active automations once, moving next_run_at before they run; paused ones are skipped", async () => {
    const t = await setup();
    const paused = await setup();
    await db.update(automationsTable).set({ status: "paused", nextRunAt: new Date(Date.now() - 60_000) }).where(eq(automationsTable.id, paused.automation.id));
    await db.update(automationsTable).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(automationsTable.id, t.automation.id));
    const [first, second] = await Promise.all([claimDueAutomations(1000), claimDueAutomations(1000)]);
    expect([...first, ...second].filter((id) => id === t.automation.id)).toHaveLength(1);
    expect([...first, ...second]).not.toContain(paused.automation.id);
    expect((await t.reload()).nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(await claimDueAutomations(1000)).not.toContain(t.automation.id);
  });

  it("keeps the latest 50 runs", async () => {
    const t = await setup();
    for (let i = 0; i < 53; i += 1) await runAutomation(t.automation.id);
    const count = await db.execute(sql`select count(*)::int as n from socialflow_automation_runs where automation_id = ${t.automation.id}`);
    expect((count.rows[0] as { n: number }).n).toBe(50);
  });
});
