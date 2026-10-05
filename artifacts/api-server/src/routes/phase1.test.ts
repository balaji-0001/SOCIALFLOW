import { and, eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { connectedAccountsTable, db, postsTable, postTargetsTable, recurrencesTable, tableExists, usersTable, workspacesTable } from "@workspace/db";
import app from "../app";
import { nextOccurrence, upcomingOccurrences } from "../lib/recurrence";
import { runPublishCycle } from "../lib/publisher";
import { upcomingSlotInstants } from "../lib/queue";
import { zonedParts, zonedToUtc } from "../lib/time";
import { installFakeGraph } from "../test/fake-graph";
import { saveConnectedAccount } from "../lib/oauth/accounts";

// Phase 1 publishing features: per-network text, queues, recurring posts, first comments, tags, custom fields and
// mention groups. Network calls are faked; the scheduler tests only run against a *_test database.

const tablesExist = await tableExists("socialflow_recurrences").catch(() => false);
const isolatedTestDb = (() => { try { return new URL(process.env.DATABASE_URL ?? "").pathname.replace("/", "").endsWith("_test"); } catch { return false; } })();

type Agent = ReturnType<typeof request.agent>;
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;

async function newUser(): Promise<{ agent: Agent; workspaceId: string }> {
  const agent = request.agent(app);
  const email = `phase1-test-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2)}@socialflow.test`;
  const res = await agent.post("/api/auth/signup").send({ email, password: "correct horse battery staple" });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return { agent, workspaceId: res.body.workspace.id };
}

/** A Facebook Page stored the way the real OAuth flow stores it; `scopes` decides first-comment support. */
async function facebookPage(workspaceId: string, externalId: string, name: string, scopes: string[] = []): Promise<string> {
  const row = await saveConnectedAccount(db, workspaceId, "facebook", {
    externalAccountId: externalId, accountType: "facebook_page", displayName: name, username: null, avatarUrl: null, accessToken: `PAGE_TOKEN_${externalId}`,
    refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes, metadata: {}, selectable: true, warnings: [],
  }, "u");
  return row.id;
}
async function linkedin(workspaceId: string, name: string): Promise<string> {
  const row = await saveConnectedAccount(db, workspaceId, "linkedin", {
    externalAccountId: `li-${Math.random().toString(36).slice(2)}`, accountType: "linkedin_member", displayName: name, username: null, avatarUrl: null, accessToken: "LI_TOKEN",
    refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: [], metadata: {}, selectable: true, warnings: [],
  }, "u");
  return row.id;
}
const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

describe("time-zone arithmetic", () => {
  it("converts local wall-clock times to instants, including across DST", () => {
    expect(zonedToUtc(2026, 1, 15, 9 * 60, "Asia/Kolkata").toISOString()).toBe("2026-01-15T03:30:00.000Z");
    expect(zonedToUtc(2026, 7, 1, 9 * 60, "Europe/London").toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(zonedToUtc(2026, 1, 1, 9 * 60, "Europe/London").toISOString()).toBe("2026-01-01T09:00:00.000Z");
    const parts = zonedParts(new Date("2026-01-15T03:30:00.000Z"), "Asia/Kolkata");
    expect(parts).toMatchObject({ year: 2026, month: 1, day: 15, weekday: 4, minuteOfDay: 540 });
  });
  it("lists queue slots in order after a given moment", () => {
    // Thursday 2026-01-15 10:00 IST; slots Mon 09:00 and Thu 09:00/15:00.
    const after = new Date("2026-01-15T04:30:00.000Z");
    const slots = [{ weekday: 1, minuteOfDay: 540 }, { weekday: 4, minuteOfDay: 540 }, { weekday: 4, minuteOfDay: 900 }];
    const next = upcomingSlotInstants("Asia/Kolkata", slots, after, 3).map((d) => d.toISOString());
    expect(next).toEqual(["2026-01-15T09:30:00.000Z", "2026-01-19T03:30:00.000Z", "2026-01-22T03:30:00.000Z"]);
  });
});

describe("recurrence rules", () => {
  const base = { interval: 1, weekdays: [], dayOfMonth: null, minuteOfDay: 600, timezone: "UTC", startDate: "2026-03-01", endDate: null, maxOccurrences: null };
  it("daily, every N days, weekly on weekdays, monthly with short months", () => {
    expect(nextOccurrence({ ...base, frequency: "daily" }, null)?.toISOString()).toBe("2026-03-01T10:00:00.000Z");
    expect(upcomingOccurrences({ ...base, frequency: "daily", interval: 3 }, new Date("2026-03-01T10:00:00.000Z"), 2).map((d) => d.toISOString())).toEqual(["2026-03-04T10:00:00.000Z", "2026-03-07T10:00:00.000Z"]);
    // 2026-03-01 is a Sunday. Weekly Mon+Wed:
    expect(upcomingOccurrences({ ...base, frequency: "weekly", weekdays: [1, 3] }, new Date("2026-03-01T00:00:00.000Z"), 3).map((d) => d.toISOString())).toEqual(["2026-03-02T10:00:00.000Z", "2026-03-04T10:00:00.000Z", "2026-03-09T10:00:00.000Z"]);
    // Every 2 weeks on Monday:
    expect(upcomingOccurrences({ ...base, frequency: "weekly", weekdays: [1], interval: 2 }, new Date("2026-03-01T00:00:00.000Z"), 2).map((d) => d.toISOString())).toEqual(["2026-03-02T10:00:00.000Z", "2026-03-16T10:00:00.000Z"]);
    // Monthly on the 31st falls back to the last day of shorter months:
    expect(upcomingOccurrences({ ...base, frequency: "monthly", dayOfMonth: 31, startDate: "2026-01-31" }, new Date("2026-01-01T00:00:00.000Z"), 3).map((d) => d.toISOString())).toEqual(["2026-01-31T10:00:00.000Z", "2026-02-28T10:00:00.000Z", "2026-03-31T10:00:00.000Z"]);
  });
  it("stops at the end date", () => {
    expect(upcomingOccurrences({ ...base, frequency: "daily", endDate: "2026-03-03" }, new Date("2026-02-01T00:00:00.000Z"), 10)).toHaveLength(3);
  });
});

describe.skipIf(!tablesExist)("Phase 1 publishing features (database)", () => {
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("stores per-network text, sends each network its own version, and keeps the base text as the default", async () => {
    const { agent, workspaceId } = await newUser();
    const fb = await facebookPage(workspaceId, "1001", "Acme Bakery");
    const li = await linkedin(workspaceId, "Acme on LinkedIn");
    const created = await agent.post("/api/posts").send({ content: "Base text", connectedAccountIds: [fb, li], platformContent: { facebook: "Facebook version #fb", youtube: "  " } });
    expect(created.status).toBe(201);
    expect(created.body.platformContent).toEqual({ facebook: "Facebook version #fb" });
    // Over the LinkedIn limit is refused with the network named.
    const tooLong = await agent.patch(`/api/posts/${created.body.id}`).send({ platformContent: { linkedin: "x".repeat(3001) } });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.message).toContain("LinkedIn");

    const { feedPosts } = installFakeGraph();
    const linkedinBodies: string[] = [];
    const graphFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
      if (url.includes("linkedin.com")) { linkedinBodies.push(String(init?.body)); return new Response(JSON.stringify({ id: "urn:li:share:1" }), { status: 201, headers: { "content-type": "application/json" } }); }
      return graphFetch(input, init);
    }));
    const sent = await agent.post(`/api/posts/${created.body.id}/publish`);
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe("published");
    expect(feedPosts[0]!.body.get("message")).toBe("Facebook version #fb");
    expect(JSON.parse(linkedinBodies[0]!).specificContent["com.linkedin.ugc.ShareContent"].shareCommentary.text).toBe("Base text");
  });

  it("can't schedule a post whose only text is a version for a network it isn't going to", async () => {
    const { agent, workspaceId } = await newUser();
    const li = await linkedin(workspaceId, "Only LinkedIn");
    const res = await agent.post("/api/posts").send({ content: "", connectedAccountIds: [li], scheduledAt: inAnHour(), platformContent: { facebook: "FB only" } });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Write something");
  });

  it("posts a first comment where the account has the permission, and explains when it doesn't", async () => {
    const { agent, workspaceId } = await newUser();
    const withScope = await facebookPage(workspaceId, "1001", "Engaging Page", ["pages_manage_posts", "pages_manage_engagement"]);
    const withoutScope = await facebookPage(workspaceId, "1002", "Plain Page", ["pages_manage_posts"]);
    const accounts = await agent.get("/api/connections");
    const byId = new Map(accounts.body.accounts.map((a: { id: string; firstComment: string }) => [a.id, a.firstComment]));
    expect(byId.get(withScope)).toBe("supported");
    expect(byId.get(withoutScope)).toBe("needs_permission");

    const comments: Array<{ path: string; message: string | null }> = [];
    const { fetchMock } = installFakeGraph({ pages: [{ id: "1001", name: "Engaging Page", access_token: "PAGE_TOKEN_1001" }, { id: "1002", name: "Plain Page", access_token: "PAGE_TOKEN_1002" }] });
    const graph = fetchMock.getMockImplementation()!;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof URL ? input.href : typeof input === "string" ? input : input.url));
      if (url.pathname.endsWith("/comments")) { comments.push({ path: url.pathname, message: new URLSearchParams(String(init?.body)).get("message") }); return new Response(JSON.stringify({ id: "c1" }), { status: 200, headers: { "content-type": "application/json" } }); }
      return graph(input, init);
    }));
    const post = await agent.post("/api/posts").send({ content: "Big news", connectedAccountIds: [withScope, withoutScope], firstComment: "Link in the comments: https://example.com" });
    expect(post.body.firstComment).toContain("Link in the comments");
    const sent = await agent.post(`/api/posts/${post.body.id}/publish`);
    expect(sent.body.status).toBe("published");
    expect(comments).toHaveLength(1);
    expect(comments[0]!.path).toMatch(/\/1001_\d+\/comments$/);
    expect(comments[0]!.message).toContain("Link in the comments");
    const targets = new Map(sent.body.targets.map((t: { connectedAccountId: string; firstCommentStatus: string; firstCommentError: string | null }) => [t.connectedAccountId, t]));
    expect((targets.get(withScope) as { firstCommentStatus: string }).firstCommentStatus).toBe("published");
    const plain = targets.get(withoutScope) as { firstCommentStatus: string; firstCommentError: string };
    expect(plain.firstCommentStatus).toBe("failed");
    expect(plain.firstCommentError).toContain("pages_manage_engagement");
  });

  it("tags: create, rename, refuse duplicates, assign to posts, filter, delete", async () => {
    const { agent } = await newUser();
    const launch = await agent.post("/api/tags").send({ name: "Launch", color: "#FF0000" });
    expect(launch.status).toBe(201);
    expect(launch.body.color).toBe("#ff0000");
    expect((await agent.post("/api/tags").send({ name: "launch" })).status).toBe(409);
    const client = await agent.post("/api/tags").send({ name: "Client A" });
    const tagged = await agent.post("/api/posts").send({ content: "Tagged", connectedAccountIds: [], tagIds: [launch.body.id] });
    expect(tagged.body.tags.map((t: { name: string }) => t.name)).toEqual(["Launch"]);
    await agent.post("/api/posts").send({ content: "Untagged", connectedAccountIds: [] });
    const filtered = await agent.get(`/api/posts?tag=${launch.body.id}`);
    expect(filtered.body.posts.map((p: { content: string }) => p.content)).toEqual(["Tagged"]);
    expect((await agent.get(`/api/posts?tag=${client.body.id}`)).body.posts).toHaveLength(0);
    const renamed = await agent.patch(`/api/tags/${launch.body.id}`).send({ name: "Spring launch" });
    expect(renamed.body.name).toBe("Spring launch");
    const list = await agent.get("/api/tags");
    expect(list.body.tags.find((t: { id: string }) => t.id === launch.body.id).postCount).toBe(1);
    expect((await agent.post("/api/posts").send({ content: "x", connectedAccountIds: [], tagIds: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
    expect((await agent.delete(`/api/tags/${launch.body.id}`)).status).toBe(204);
    expect((await agent.get(`/api/posts/${tagged.body.id}`)).body.tags).toEqual([]);
  });

  it("search finds base and per-network text", async () => {
    const { agent } = await newUser();
    await agent.post("/api/posts").send({ content: "Quarterly numbers", connectedAccountIds: [] });
    await agent.post("/api/posts").send({ content: "Plain", connectedAccountIds: [], platformContent: { linkedin: "Hiring engineers" } });
    expect((await agent.get("/api/posts?q=quarterly")).body.posts).toHaveLength(1);
    expect((await agent.get("/api/posts?q=hiring")).body.posts).toHaveLength(1);
    expect((await agent.get("/api/posts?q=nothing-here")).body.posts).toHaveLength(0);
  });

  it("custom fields: definitions, typed values, required only when scheduling", async () => {
    const { agent, workspaceId } = await newUser();
    const fb = await facebookPage(workspaceId, "1001", "Page");
    const budget = await agent.post("/api/custom-fields").send({ label: "Budget", type: "number" });
    expect(budget.status).toBe(201);
    expect(budget.body.key).toBe("budget");
    const channel = await agent.post("/api/custom-fields").send({ label: "Channel", type: "select", options: ["Organic", "Paid"], required: true });
    expect((await agent.post("/api/custom-fields").send({ label: "Bad", type: "select" })).status).toBe(400);
    const draft = await agent.post("/api/posts").send({ content: "x", connectedAccountIds: [fb], customValues: { [budget.body.id]: "1200" } });
    expect(draft.status).toBe(201); // required field not enforced on drafts
    expect(draft.body.customValues).toEqual({ [budget.body.id]: "1200" });
    const badNumber = await agent.patch(`/api/posts/${draft.body.id}`).send({ customValues: { [budget.body.id]: "lots" } });
    expect(badNumber.status).toBe(400);
    expect(badNumber.body.message).toContain("Budget");
    const missingRequired = await agent.patch(`/api/posts/${draft.body.id}`).send({ scheduledAt: inAnHour() });
    expect(missingRequired.status).toBe(400);
    expect(missingRequired.body.message).toContain("Channel is required");
    const badOption = await agent.patch(`/api/posts/${draft.body.id}`).send({ scheduledAt: inAnHour(), customValues: { [budget.body.id]: "1200", [channel.body.id]: "Print" } });
    expect(badOption.status).toBe(400);
    const ok = await agent.patch(`/api/posts/${draft.body.id}`).send({ scheduledAt: inAnHour(), customValues: { [budget.body.id]: "1200", [channel.body.id]: "Paid" } });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("scheduled");
    expect((await agent.delete(`/api/custom-fields/${channel.body.id}`)).status).toBe(204);
    expect((await agent.get(`/api/posts/${draft.body.id}`)).body.customValues).toEqual({ [budget.body.id]: "1200" });
  });

  it("mention groups: validated handles, unique names", async () => {
    const { agent } = await newUser();
    const group = await agent.post("/api/mention-groups").send({ name: "Partners", handles: ["acme", "@beta.co", "gamma_inc"] });
    expect(group.status).toBe(201);
    expect(group.body.handles).toEqual(["@acme", "@beta.co", "@gamma_inc"]);
    expect((await agent.post("/api/mention-groups").send({ name: "partners", handles: ["x"] })).status).toBe(409);
    expect((await agent.post("/api/mention-groups").send({ name: "Bad", handles: ["has space"] })).status).toBe(400);
    expect((await agent.patch(`/api/mention-groups/${group.body.id}`).send({ handles: ["only"] })).body.handles).toEqual(["@only"]);
    expect((await agent.get("/api/mention-groups")).body.groups).toHaveLength(1);
    expect((await agent.delete(`/api/mention-groups/${group.body.id}`)).status).toBe(204);
  });

  it("queues: schedule slots, add to queue takes the next free slot, reorder swaps times, paused queues refuse", async () => {
    const { agent, workspaceId } = await newUser();
    const fb = await facebookPage(workspaceId, "1001", "Queued Page");
    const noQueue = await agent.post("/api/posts").send({ content: "no slots yet", connectedAccountIds: [fb], queue: true });
    expect(noQueue.status).toBe(400);
    expect(noQueue.body.message).toContain("no posting schedule");
    expect((await agent.put(`/api/queues/${fb}`).send({ timezone: "Mars/Olympus", slots: [] })).status).toBe(400);
    const saved = await agent.put(`/api/queues/${fb}`).send({ timezone: "Asia/Kolkata", slots: [{ weekday: 0, time: "09:00" }, { weekday: 1, time: "09:00" }, { weekday: 2, time: "09:00" }, { weekday: 3, time: "09:00" }, { weekday: 4, time: "09:00" }, { weekday: 5, time: "09:00" }, { weekday: 6, time: "09:00" }, { weekday: 3, time: "15:00" }, { weekday: 3, time: "15:00" }] });
    expect(saved.status).toBe(200);
    expect(saved.body.slots).toHaveLength(8); // duplicate dropped
    expect(saved.body.nextSlots).toHaveLength(5);
    const first = await agent.post("/api/posts").send({ content: "first in queue", connectedAccountIds: [fb], queue: true });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("scheduled");
    expect(first.body.scheduledAt).toBe(saved.body.nextSlots[0]);
    const second = await agent.post("/api/posts").send({ content: "second in queue", connectedAccountIds: [fb], queue: true });
    expect(second.body.scheduledAt).toBe(saved.body.nextSlots[1]);
    const queued = await agent.get(`/api/queues/${fb}/posts`);
    expect(queued.body.posts.map((p: { content: string }) => p.content)).toEqual(["first in queue", "second in queue"]);
    const reordered = await agent.post(`/api/queues/${fb}/reorder`).send({ postIds: [second.body.id, first.body.id] });
    expect(reordered.body.posts.map((p: { content: string; scheduledAt: string }) => [p.content, p.scheduledAt])).toEqual([["second in queue", saved.body.nextSlots[0]], ["first in queue", saved.body.nextSlots[1]]]);
    await agent.put(`/api/queues/${fb}`).send({ timezone: "Asia/Kolkata", paused: true, slots: saved.body.slots.map((s: { weekday: number; time: string }) => ({ weekday: s.weekday, time: s.time })) });
    const paused = await agent.post("/api/posts").send({ content: "while paused", connectedAccountIds: [fb], queue: true });
    expect(paused.status).toBe(400);
    expect(paused.body.message).toContain("paused");
    expect((await agent.get("/api/queues")).body.queues.find((q: { connectedAccountId: string }) => q.connectedAccountId === fb).paused).toBe(true);
    // Another workspace can't see or change this queue.
    const other = await newUser();
    expect((await other.agent.get(`/api/queues/${fb}`)).status).toBe(404);
    expect((await other.agent.put(`/api/queues/${fb}`).send({ timezone: "UTC", slots: [] })).status).toBe(404);
  });

  it("recurring posts: create materializes the first occurrence, preview, pause removes it, resume recreates it, delete cleans up", async () => {
    const { agent, workspaceId } = await newUser();
    const fb = await facebookPage(workspaceId, "1001", "Repeat Page");
    const today = new Date();
    const startDate = new Date(today.getTime() + 86_400_000).toISOString().slice(0, 10);
    const preview = await agent.post("/api/recurrences/preview").send({ frequency: "daily", time: "10:00", timezone: "UTC", startDate, maxOccurrences: 3 });
    expect(preview.body.dates).toHaveLength(3);
    const bad = await agent.post("/api/recurrences").send({ frequency: "weekly", weekdays: [], time: "10:00", timezone: "UTC", startDate, content: "x", connectedAccountIds: [fb] });
    expect(bad.status).toBe(400);
    const rule = await agent.post("/api/recurrences").send({ frequency: "daily", time: "10:00", timezone: "UTC", startDate, content: "Daily tip #tips", connectedAccountIds: [fb], maxOccurrences: 3, platformContent: { facebook: "FB daily tip" } });
    expect(rule.status).toBe(201);
    expect(rule.body.occurrencesCreated).toBe(1);
    expect(rule.body.upcoming).toHaveLength(2);
    const detail = await agent.get(`/api/recurrences/${rule.body.id}`);
    expect(detail.body.posts).toHaveLength(1);
    expect(detail.body.posts[0]).toMatchObject({ status: "scheduled", content: "Daily tip #tips", recurrenceId: rule.body.id, platformContent: { facebook: "FB daily tip" } });
    expect(detail.body.posts[0].scheduledAt).toBe(preview.body.dates[0]);

    const paused = await agent.patch(`/api/recurrences/${rule.body.id}`).send({ paused: true });
    expect(paused.body.paused).toBe(true);
    expect((await agent.get(`/api/recurrences/${rule.body.id}`)).body.posts).toHaveLength(0);
    const resumed = await agent.patch(`/api/recurrences/${rule.body.id}`).send({ paused: false });
    expect(resumed.body.paused).toBe(false);
    expect((await agent.get(`/api/recurrences/${rule.body.id}`)).body.posts).toHaveLength(1);

    // Editing the text applies to the recreated occurrence.
    const edited = await agent.patch(`/api/recurrences/${rule.body.id}`).send({ content: "Daily tip v2" });
    expect(edited.status).toBe(200);
    expect((await agent.get(`/api/recurrences/${rule.body.id}`)).body.posts[0].content).toBe("Daily tip v2");

    expect((await agent.delete(`/api/recurrences/${rule.body.id}`)).status).toBe(204);
    const remaining = await db.select().from(postsTable).where(eq(postsTable.recurrenceId, rule.body.id));
    expect(remaining).toHaveLength(0);
  });
});

describe.skipIf(!tablesExist || !isolatedTestDb)("Recurring posts through the scheduler (test DB only)", () => {
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("creates each occurrence once even when the cycle runs repeatedly, and publishes it when due", async () => {
    const { agent, workspaceId } = await newUser();
    const fb = await facebookPage(workspaceId, "1001", "Cycle Page");
    const startDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const rule = await agent.post("/api/recurrences").send({ frequency: "daily", time: "10:00", timezone: "UTC", startDate, content: "Every day", connectedAccountIds: [fb], maxOccurrences: 2 });
    expect(rule.status).toBe(201);
    installFakeGraph();
    await runPublishCycle();
    await runPublishCycle();
    let posts = await db.select().from(postsTable).where(eq(postsTable.recurrenceId, rule.body.id));
    // Only the occurrences inside the 7-day horizon exist, each exactly once.
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((p) => p.occurrenceIndex))).toEqual(new Set([0, 1]));
    const [row] = await db.select().from(recurrencesTable).where(eq(recurrencesTable.id, rule.body.id));
    expect(row!.occurrencesCreated).toBe(2);
    expect(row!.nextRunAt).toBeNull(); // max reached

    // Make the first occurrence due and run the scheduler: it publishes with the rule's text.
    const first = posts.find((p) => p.occurrenceIndex === 0)!;
    await db.update(postsTable).set({ scheduledAt: new Date(Date.now() - 1000) }).where(eq(postsTable.id, first.id));
    const { feedPosts } = installFakeGraph();
    await runPublishCycle();
    posts = await db.select().from(postsTable).where(eq(postsTable.id, first.id));
    expect(posts[0]!.status).toBe("published");
    expect(feedPosts[0]!.body.get("message")).toBe("Every day");
    const [target] = await db.select().from(postTargetsTable).where(eq(postTargetsTable.postId, first.id));
    expect(target!.status).toBe("published");
    await db.delete(connectedAccountsTable).where(and(eq(connectedAccountsTable.id, fb)));
  });
});
