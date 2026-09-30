import cookieParser from "cookie-parser";
import { eq, inArray } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, usersTable, workspacesTable } from "@workspace/db";
import { collectWorkspace, inboxItemsTable, inboxRepliesTable } from "../lib/inbox";
import { saveConnectedAccount } from "../lib/oauth/accounts";
import { fetchConversations, fetchMentions, mentionReplySupport, mentionsSupport, messagingSupport, replyToMention, replyWindow, sendDirectMessage } from "../lib/oauth/inbox-adapters";

// Inbox direct messages and mentions: adapters against faked Graph responses, the 24-hour window, gating, filters, isolation and replies.

vi.mock("../lib/mail", () => ({ mailMode: () => "smtp", sendMail: async () => {} }));

const { default: app } = await import("../app");
const { default: inboxRouter } = await import("./inbox");
const mini = express();
mini.use(cookieParser(process.env.SESSION_SECRET));
mini.use(express.json());
mini.use("/api", inboxRouter);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MESSAGING_SCOPES_ENABLED;
});

const FB_MSG = ["pages_messaging", "pages_manage_metadata"];
const FB_ALL = [...FB_MSG, "pages_read_engagement", "pages_manage_engagement"];
const IG_MSG = "instagram_business_manage_messages";
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe("messaging support and the 24-hour window", () => {
  it("gates messaging by network, permission and the server switch", () => {
    expect(messagingSupport("facebook", FB_MSG, true)).toEqual({ state: "available", reason: null });
    expect(messagingSupport("instagram", [IG_MSG], true).state).toBe("available");
    const missing = messagingSupport("facebook", ["pages_messaging"], true);
    expect(missing.state).toBe("permission_needed");
    expect(missing.reason).toContain("pages_manage_metadata");
    expect(messagingSupport("facebook", FB_MSG, false).reason).toContain("MESSAGING_SCOPES_ENABLED");
    expect(messagingSupport("youtube", [], true)).toMatchObject({ state: "unavailable" });
    expect(messagingSupport("linkedin", [], true).state).toBe("unavailable");
    expect(mentionsSupport("facebook", ["pages_read_engagement"], true).state).toBe("available");
    expect(mentionsSupport("instagram", ["instagram_business_basic"], false).state).toBe("permission_needed");
    expect(mentionsSupport("youtube", [], true).reason).toContain("YouTube");
    expect(mentionReplySupport("facebook").supported).toBe(true);
    expect(mentionReplySupport("instagram")).toMatchObject({ supported: false });
  });

  it("computes the window from the last inbound message", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    const inside = replyWindow(new Date("2026-09-09T13:00:00Z"), now);
    expect(inside.canReply).toBe(true);
    expect(inside.replyWindowEndsAt?.toISOString()).toBe("2026-09-10T13:00:00.000Z");
    expect(replyWindow(new Date("2026-09-09T11:59:00Z"), now).canReply).toBe(false);
    expect(replyWindow(new Date("2026-09-09T12:00:00Z"), now).canReply).toBe(false);
    expect(replyWindow(null, now)).toEqual({ canReply: false, replyWindowEndsAt: null });
  });
});

describe("messaging adapters", () => {
  it("reads Facebook conversations and tells the Page's own messages apart", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return json({ data: [{ id: "t_1", participants: { data: [{ id: "PG1", name: "Us" }, { id: "U1", name: "Ann" }] }, messages: { data: [
        { id: "m2", message: "We can help", from: { id: "PG1", name: "Us" }, created_time: "2026-09-01T11:00:00+0000" },
        { id: "m1", message: "Hi there", from: { id: "U1", name: "Ann" }, created_time: "2026-09-01T10:00:00+0000" },
        { id: "m0", from: { id: "U1", name: "Ann" }, created_time: "2026-09-01T09:00:00+0000" },
      ] } }] });
    }));
    const threads = await fetchConversations("facebook", { externalAccountId: "PG1", accessToken: "TOKEN", scopes: FB_MSG, appSecret: "s" });
    expect(calls[0]).toContain("/PG1/conversations");
    expect(calls[0]).toContain("participants");
    expect(calls[0]).toContain("appsecret_proof=");
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ threadId: "t_1", participantId: "U1", participantName: "Ann" });
    expect(threads[0]!.messages.map((m) => [m.externalId, m.fromSelf])).toEqual([["m2", true], ["m1", false]]);
  });

  it("reads Instagram conversations with a list call and one call per conversation", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/me/conversations")) return json({ data: [{ id: "c1" }, { id: "c2" }] });
      return json({ participants: { data: [{ id: "IG1", username: "brand" }, { id: "F1", username: "fan" }] }, messages: { data: [{ id: `${url.includes("/c1") ? "a" : "b"}1`, message: "hello", from: { id: "F1", username: "fan" }, created_time: "2026-09-01T10:00:00+0000" }] } });
    }));
    const threads = await fetchConversations("instagram", { externalAccountId: "IG1", accessToken: "T", scopes: [IG_MSG], username: "brand" });
    expect(calls[0]).toContain("graph.instagram.com/me/conversations");
    expect(calls[0]).toContain("platform=instagram");
    expect(calls).toHaveLength(3);
    expect(threads.map((t) => [t.threadId, t.participantId, t.messages[0]!.fromSelf])).toEqual([["c1", "F1", false], ["c2", "F1", false]]);
  });

  it("maps a permission error and refuses networks without a message API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: 10, message: "(#10) needs pages_messaging" } }, 403)));
    await expect(fetchConversations("facebook", { externalAccountId: "P", accessToken: "T", scopes: [] })).rejects.toMatchObject({ code: "insufficient_permissions" });
    await expect(fetchConversations("youtube", { externalAccountId: "Y", accessToken: "T", scopes: [] })).rejects.toBeTruthy();
  });

  it("sends a Facebook message as a RESPONSE and an Instagram one to /me/messages", async () => {
    const calls: Array<{ url: string; body: string; headers: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body), headers: init?.headers });
      return json({ recipient_id: "U1", message_id: "mid.1" });
    }));
    expect(await sendDirectMessage("facebook", { externalAccountId: "PG1", accessToken: "T", scopes: [] }, { recipientId: "U1", text: "Hello" })).toEqual({ externalId: "mid.1" });
    expect(calls[0]!.url).toContain("/PG1/messages");
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("messaging_type")).toBe("RESPONSE");
    expect(JSON.parse(form.get("recipient")!)).toEqual({ id: "U1" });
    expect(JSON.parse(form.get("message")!)).toEqual({ text: "Hello" });
    expect(await sendDirectMessage("instagram", { externalAccountId: "IG1", accessToken: "T", scopes: [] }, { recipientId: "F1", text: "Yo" })).toEqual({ externalId: "mid.1" });
    expect(calls[1]!.url).toBe("https://graph.instagram.com/me/messages");
    expect(JSON.parse(calls[1]!.body)).toEqual({ recipient: { id: "F1" }, message: { text: "Yo" } });
    await expect(sendDirectMessage("youtube", { externalAccountId: "Y", accessToken: "T", scopes: [] }, { recipientId: "x", text: "y" })).rejects.toBeTruthy();
  });

  it("reads Facebook tagged posts and Instagram tagged media without inventing anything", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      if (String(input).includes("/tagged")) {
        return json({ data: [
          { id: "PG1_5", message: "Shoutout @us", created_time: "2026-09-01T10:00:00+0000", permalink_url: "https://fb/p/5", from: { id: "U9", name: "Zoe" } },
          { id: "PG1_6", created_time: "2026-09-01T11:00:00+0000", from: { id: "PG1", name: "Us" } },
        ] });
      }
      return json({ data: [{ id: "med1", caption: "with @brand", permalink: "https://ig/p/1", timestamp: "2026-09-02T10:00:00+0000", username: "fan" }, { id: "med2", timestamp: "2026-09-02T11:00:00+0000", username: "brand" }, { id: "bad" }] });
    }));
    const fb = await fetchMentions("facebook", { externalAccountId: "PG1", accessToken: "T", scopes: [] });
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ externalId: "PG1_5", authorName: "Zoe", body: "Shoutout @us", permalink: "https://fb/p/5" });
    const ig = await fetchMentions("instagram", { externalAccountId: "IG1", accessToken: "T", scopes: [], username: "brand" });
    expect(ig.map((m) => [m.externalId, m.body, m.permalink])).toEqual([["med1", "with @brand", "https://ig/p/1"]]);
    await expect(fetchMentions("youtube", { externalAccountId: "Y", accessToken: "T", scopes: [] })).rejects.toBeTruthy();
    await expect(replyToMention("instagram", { externalAccountId: "IG1", accessToken: "T", scopes: [] }, { externalPostId: "med1", text: "x" })).rejects.toBeTruthy();
  });
});

type Agent = ReturnType<typeof request.agent>;
interface Person { agent: Agent; cookies: string[]; email: string; userId: string; workspaceId: string }
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;

async function signup(): Promise<Person> {
  const agent = request.agent(app);
  const email = `inbox-dm-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2)}@socialflow.test`;
  const res = await agent.post("/api/auth/signup").send({ email, password: "correct horse battery staple", displayName: "Tester" });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return { agent, cookies: (res.headers["set-cookie"] as unknown as string[]).map((c) => c.split(";")[0]!), email, userId: res.body.user.id, workspaceId: res.body.workspace.id };
}

const call = (who: Person, method: "get" | "post" | "patch", path: string) => request(mini)[method](`/api${path}`).set("Cookie", who.cookies);

async function account(workspaceId: string, platform: "facebook" | "instagram" | "youtube" | "linkedin", id: string, scopes: string[], username: string | null = null) {
  return saveConnectedAccount(db, workspaceId, platform, {
    externalAccountId: id, accountType: `${platform}_test`, displayName: `${platform} ${id}`, username, avatarUrl: null, accessToken: `TOKEN_${id}`,
    refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes, metadata: {}, selectable: true, warnings: [],
  }, "u");
}

const fbConversations = (pageId: string) => json({ data: [
  { id: "t_fresh", participants: { data: [{ id: pageId, name: "Us" }, { id: "U1", name: "Ann" }] }, messages: { data: [
    { id: "m3", message: "Is it in stock?", from: { id: "U1", name: "Ann" }, created_time: hoursAgo(2) },
    { id: "m2", message: "Hello Ann", from: { id: pageId, name: "Us" }, created_time: hoursAgo(3) },
    { id: "m1", message: "Hi", from: { id: "U1", name: "Ann" }, created_time: hoursAgo(4) },
  ] } },
  { id: "t_old", participants: { data: [{ id: pageId, name: "Us" }, { id: "U2", name: "Bo" }] }, messages: { data: [
    { id: "o1", message: "Hello?", from: { id: "U2", name: "Bo" }, created_time: hoursAgo(30) },
  ] } },
] });
const fbTagged = () => json({ data: [{ id: "PGX_7", message: "Great work @us", created_time: hoursAgo(5), permalink_url: "https://fb/7", from: { id: "U3", name: "Cy" } }] });

describe("Inbox messages and mentions (database)", () => {
  beforeEach(() => { process.env.MESSAGING_SCOPES_ENABLED = "true"; });
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("collects conversations and mentions, upserts by id, and shows one row per conversation", async () => {
    const owner = await signup();
    const fb = await account(owner.workspaceId, "facebook", "PGX", FB_ALL);
    const stub = vi.fn(async (input: unknown) => (String(input).includes("/conversations") ? fbConversations("PGX") : fbTagged()));
    vi.stubGlobal("fetch", stub);
    const [outcome] = await collectWorkspace(owner.workspaceId);
    expect(outcome).toMatchObject({ accountId: fb.id, newMessages: 3, newMentions: 1, newItems: 4, messagesReason: null, mentionsReason: null });

    const again = await collectWorkspace(owner.workspaceId);
    expect(again[0]).toMatchObject({ newMessages: 0, newMentions: 0 });
    expect(await db.select().from(inboxItemsTable).where(eq(inboxItemsTable.connectedAccountId, fb.id))).toHaveLength(5);

    const all = await call(owner, "get", "/inbox");
    expect(all.body.items.map((i: { externalId: string }) => i.externalId).sort()).toEqual(["PGX_7", "o1", "m3"].sort());
    const messages = await call(owner, "get", "/inbox?kind=message");
    expect(messages.body.items).toHaveLength(2);
    const fresh = messages.body.items.find((i: { threadId: string }) => i.threadId === "t_fresh");
    const old = messages.body.items.find((i: { threadId: string }) => i.threadId === "t_old");
    expect(fresh).toMatchObject({ kind: "message", externalId: "m3", authorName: "Ann", canReply: true });
    expect(new Date(fresh.replyWindowEndsAt).getTime()).toBeGreaterThan(Date.now());
    expect(old).toMatchObject({ canReply: false });
    expect(old.replyBlockedReason).toContain("24-hour");
    const mentions = await call(owner, "get", "/inbox?kind=mention");
    expect(mentions.body.items).toEqual([expect.objectContaining({ kind: "mention", externalId: "PGX_7", permalink: "https://fb/7", canReply: true })]);
    expect((await call(owner, "get", "/inbox?kind=comment")).body.items).toEqual([]);
    expect((await call(owner, "get", "/inbox?kind=bogus")).status).toBe(400);

    const thread = await call(owner, "get", "/inbox/threads/t_fresh");
    expect(thread.status).toBe(200);
    expect(thread.body).toMatchObject({ threadId: "t_fresh", platform: "facebook", participantName: "Ann", canReply: true, itemId: fresh.id });
    expect(thread.body.messages.map((m: { externalId: string; fromPage: boolean }) => [m.externalId, m.fromPage])).toEqual([["m1", false], ["m2", true], ["m3", false]]);
    expect((await call(owner, "get", "/inbox/threads/nope")).status).toBe(404);

    // Working a conversation applies to the whole thread.
    const resolved = await call(owner, "patch", `/inbox/${fresh.id}`).send({ status: "resolved", read: true });
    expect(resolved.body).toMatchObject({ status: "resolved", read: true });
    const rows = await db.select().from(inboxItemsTable).where(eq(inboxItemsTable.threadId, "t_fresh"));
    expect(rows.filter((r) => !r.fromPage).every((r) => r.status === "resolved")).toBe(true);

    const summary = await call(owner, "get", "/inbox/summary");
    expect(summary.body.kinds).toEqual({ comment: { open: 0, unread: 0 }, message: { open: 1, unread: 1 }, mention: { open: 1, unread: 1 } });
    expect(summary.body).toMatchObject({ open: 2, resolved: 1 });
    const state = summary.body.accounts.find((a: { accountId: string }) => a.accountId === fb.id);
    expect(state.messaging).toMatchObject({ state: "available", reason: null, replyWindowHours: 24 });
    expect(state.mentions).toMatchObject({ state: "available", canReply: true });
  });

  it("answers a message inside the window, records it in the thread, and refuses outside the window without calling the network", async () => {
    const owner = await signup();
    await account(owner.workspaceId, "facebook", "PGY", FB_ALL);
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => (String(input).includes("/conversations") ? fbConversations("PGY") : fbTagged())));
    await collectWorkspace(owner.workspaceId);
    const list = (await call(owner, "get", "/inbox?kind=message")).body.items;
    const fresh = list.find((i: { threadId: string }) => i.threadId === "t_fresh");
    const old = list.find((i: { threadId: string }) => i.threadId === "t_old");

    const posted: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => { posted.push({ url: String(input), body: String(init?.body) }); return json({ recipient_id: "U1", message_id: "mid.sent" }); }));
    const ok = await call(owner, "post", `/inbox/${fresh.id}/reply`).send({ body: "  Yes, in stock  " });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: "sent", body: "Yes, in stock", externalId: "mid.sent" });
    expect(posted[0]!.url).toContain("/PGY/messages");
    expect(JSON.parse(new URLSearchParams(posted[0]!.body).get("recipient")!)).toEqual({ id: "U1" });
    const thread = await call(owner, "get", "/inbox/threads/t_fresh");
    expect(thread.body.messages.at(-1)).toMatchObject({ externalId: "mid.sent", fromPage: true, body: "Yes, in stock" });
    expect((await call(owner, "get", "/inbox?kind=message")).body.items.find((i: { threadId: string }) => i.threadId === "t_fresh")).toMatchObject({ replied: true, externalId: "m3" });

    const spy = vi.fn(async (_input: unknown) => json({ message_id: "no" }));
    vi.stubGlobal("fetch", spy);
    const closed = await call(owner, "post", `/inbox/${old.id}/reply`).send({ body: "Sorry for the wait" });
    expect(closed.status).toBe(409);
    expect(closed.body.error).toBe("window_closed");
    expect(closed.body.message).toContain("24-hour");
    expect(spy).not.toHaveBeenCalled();
    expect(await db.select().from(inboxRepliesTable).where(eq(inboxRepliesTable.itemId, old.id))).toHaveLength(0);
    expect((await call(owner, "post", `/inbox/${fresh.id}/reply`).send({ body: "x".repeat(2001) })).status).toBe(400);

    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: 10, message: "(#10) nope" } }, 403)));
    const failed = await call(owner, "post", `/inbox/${fresh.id}/reply`).send({ body: "again" });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe("reply_failed");
    expect(JSON.stringify(await db.select().from(inboxRepliesTable).where(eq(inboxRepliesTable.itemId, fresh.id)))).not.toContain("TOKEN_");
  });

  it("answers a Facebook mention as a comment and explains why an Instagram one can't be answered", async () => {
    const owner = await signup();
    await account(owner.workspaceId, "facebook", "PGZ", FB_ALL);
    const ig = await account(owner.workspaceId, "instagram", "IGZ", [IG_MSG, "instagram_business_basic"], "brand");
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/tagged")) return fbTagged();
      if (url.includes("/conversations")) return json({ data: [] });
      if (url.includes("/me/tags")) return json({ data: [{ id: "med9", caption: "hey @brand", permalink: "https://ig/9", timestamp: hoursAgo(1), username: "fan" }] });
      return json({ data: [] });
    }));
    const outcomes = await collectWorkspace(owner.workspaceId);
    expect(outcomes.reduce((sum, o) => sum + (o.newMentions ?? 0), 0)).toBe(2);
    const mentions = (await call(owner, "get", "/inbox?kind=mention")).body.items;
    const fbMention = mentions.find((m: { platform: string }) => m.platform === "facebook");
    const igMention = mentions.find((m: { platform: string }) => m.platform === "instagram");
    expect(igMention).toMatchObject({ canReply: false });
    expect(igMention.replyBlockedReason).toContain("Instagram");

    const posted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => { posted.push(String(input)); return json({ id: "cmt1" }); }));
    const ok = await call(owner, "post", `/inbox/${fbMention.id}/reply`).send({ body: "Thank you!" });
    expect(ok.status).toBe(201);
    expect(posted[0]).toContain("/PGX_7/comments");
    posted.length = 0;
    const blocked = await call(owner, "post", `/inbox/${igMention.id}/reply`).send({ body: "Thanks" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("unavailable");
    expect(posted).toHaveLength(0);
    expect(ig.id).toBeTruthy();
  });

  it("reports gating per account: permission needed, unavailable networks, reconnect, and switched off", async () => {
    const owner = await signup();
    const other = await signup();
    const noScope = await account(owner.workspaceId, "facebook", "PGN", ["pages_read_engagement"]);
    const yt = await account(owner.workspaceId, "youtube", "UCN", []);
    const li = await account(owner.workspaceId, "linkedin", "LIN", []);
    const spy = vi.fn(async (_input: unknown) => json({ data: [] }));
    vi.stubGlobal("fetch", spy);
    const outcomes = await collectWorkspace(owner.workspaceId);
    expect(spy).toHaveBeenCalledTimes(1); // only the Page's mentions; no messaging permission, no comment permission, nothing for YouTube or LinkedIn
    expect(String(spy.mock.calls[0]![0])).toContain("/tagged");
    const byId = new Map(outcomes.map((o) => [o.accountId, o]));
    expect(byId.get(noScope.id)!.messagesReason).toContain("pages_messaging");
    expect(byId.get(yt.id)!.messagesReason).toContain("YouTube");

    const summary = await call(owner, "get", "/inbox/summary");
    const accounts = new Map(summary.body.accounts.map((a: { accountId: string }) => [a.accountId, a]));
    expect((accounts.get(noScope.id) as { messaging: { state: string } }).messaging.state).toBe("permission_needed");
    expect((accounts.get(noScope.id) as { mentions: { state: string } }).mentions.state).toBe("available");
    expect((accounts.get(yt.id) as { mentions: { state: string; reason: string } }).mentions).toMatchObject({ state: "unavailable" });
    expect((accounts.get(li.id) as { messaging: { state: string; replyWindowHours: number | null } }).messaging).toMatchObject({ state: "unavailable", replyWindowHours: null });

    // Switched off: nothing is collected and the summary says how to turn it on.
    delete process.env.MESSAGING_SCOPES_ENABLED;
    spy.mockClear();
    const off = await collectWorkspace(owner.workspaceId);
    expect(spy).not.toHaveBeenCalled();
    expect(off[0]!.newMessages).toBeUndefined();
    const offSummary = await call(owner, "get", "/inbox/summary");
    expect(offSummary.body.accounts[0].messaging.reason).toContain("MESSAGING_SCOPES_ENABLED");

    // Another workspace sees none of it.
    expect((await call(other, "get", "/inbox?kind=message")).body.items).toEqual([]);
    expect((await call(other, "get", "/inbox/threads/t_fresh")).status).toBe(404);
  });

  it("keeps conversations of one workspace away from another", async () => {
    const a = await signup();
    const b = await signup();
    await account(a.workspaceId, "facebook", "PGA", FB_ALL);
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => (String(input).includes("/conversations") ? fbConversations("PGA") : json({ data: [] }))));
    await collectWorkspace(a.workspaceId);
    expect((await call(a, "get", "/inbox/threads/t_fresh")).status).toBe(200);
    expect((await call(b, "get", "/inbox/threads/t_fresh")).status).toBe(404);
    const item = (await call(a, "get", "/inbox?kind=message")).body.items[0];
    expect((await call(b, "post", `/inbox/${item.id}/reply`).send({ body: "hi" })).status).toBe(404);
    expect((await call(b, "patch", `/inbox/${item.id}`).send({ read: true })).status).toBe(404);
  });
});
