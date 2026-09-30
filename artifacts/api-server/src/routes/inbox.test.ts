import cookieParser from "cookie-parser";
import { eq, inArray } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedAccountsTable, db, pool, postTargetsTable, postsTable, usersTable, workspacesTable } from "@workspace/db";
import { collectWorkspace, inboxItemsTable, inboxRepliesTable } from "../lib/inbox";
import { saveConnectedAccount } from "../lib/oauth/accounts";
import { fetchComments, inboxSupport, replyToComment } from "../lib/oauth/inbox-adapters";

// Inbox: network adapters against faked networks, the collector, and the routes (roles, filters, paging, replies).

const sent: Array<{ to: string; subject: string; text: string }> = [];
vi.mock("../lib/mail", () => ({
  mailMode: () => "smtp",
  sendMail: async (message: { to: string; subject: string; text: string }) => { sent.push(message); },
}));

const { default: app } = await import("../app");
const { default: inboxRouter } = await import("./inbox");

// The inbox router is mounted on its own small app (same session cookie handling as the real one), so these tests run
// whether or not the integrator has registered it in routes/index.ts yet. The migration is idempotent.
const mini = express();
mini.use(cookieParser(process.env.SESSION_SECRET));
mini.use(express.json());
mini.use("/api", inboxRouter);

const dbReady = await (async () => {
  try {
    return true;
  } catch {
    return false;
  }
})();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

const FB_SCOPE = "pages_manage_engagement";
const IG_SCOPE = "instagram_business_manage_comments";
const YT_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

describe("inbox support", () => {
  it("explains what each network allows", () => {
    expect(inboxSupport("facebook", [FB_SCOPE], true)).toEqual({ state: "available", reason: null });
    expect(inboxSupport("instagram", [IG_SCOPE], false).state).toBe("available");
    expect(inboxSupport("youtube", [YT_SCOPE], false).state).toBe("available");
    const needed = inboxSupport("facebook", ["pages_manage_posts"], true);
    expect(needed.state).toBe("permission_needed");
    expect(needed.reason).toContain(FB_SCOPE);
    expect(inboxSupport("facebook", [], false).reason).toContain("COMMENT_SCOPES_ENABLED");
    expect(inboxSupport("linkedin", ["w_member_social"], true).state).toBe("unavailable");
  });
});

describe("network adapters", () => {
  it("reads Facebook comments, keeping replies with their parent and skipping the Page's own", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return json({ data: [
        { id: "c1", message: "Great post", created_time: "2026-09-01T10:00:00+0000", from: { id: "u1", name: "Ann", picture: { data: { url: "https://img/ann.jpg" } } } },
        { id: "c2", message: "Thanks!", created_time: "2026-09-01T11:00:00+0000", from: { id: "PAGE1", name: "Us" }, parent: { id: "c1" } },
        { id: "c3", created_time: "2026-09-01T12:00:00+0000", from: { id: "u2", name: "Bo" } },
      ] });
    }));
    const comments = await fetchComments("facebook", { externalAccountId: "PAGE1", accessToken: "TOKEN", scopes: [FB_SCOPE], appSecret: "secret" }, { externalPostId: "PAGE1_99" });
    expect(calls[0]).toContain("/PAGE1_99/comments");
    expect(calls[0]).toContain("appsecret_proof=");
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({ externalId: "c1", parentExternalId: null, authorName: "Ann", authorAvatar: "https://img/ann.jpg", fromSelf: false });
    expect(comments[1]).toMatchObject({ externalId: "c2", parentExternalId: "c1", fromSelf: true });
  });

  it("maps a Facebook permission error so the account is shown as needing permission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: 200, message: "(#200) Requires pages_read_user_content" } }, 403)));
    await expect(fetchComments("facebook", { externalAccountId: "P", accessToken: "T", scopes: [] }, { externalPostId: "P_1" })).rejects.toMatchObject({ code: "insufficient_permissions" });
  });

  it("replies on Facebook and Instagram under the comment", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body) });
      return json({ id: "reply-1" });
    }));
    expect(await replyToComment("facebook", { externalAccountId: "P", accessToken: "T", scopes: [] }, { externalCommentId: "c1", text: "Hi" })).toEqual({ externalId: "reply-1" });
    expect(calls[0]!.url).toContain("/c1/comments");
    expect(calls[0]!.body).toContain("message=Hi");
    expect(await replyToComment("instagram", { externalAccountId: "I", accessToken: "T", scopes: [] }, { externalCommentId: "ic1", text: "Yo" })).toEqual({ externalId: "reply-1" });
    expect(calls[1]!.url).toBe("https://graph.instagram.com/ic1/replies");
  });

  it("reads Instagram comments with their replies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [{ id: "i1", text: "Nice", timestamp: "2026-09-02T10:00:00+0000", username: "fan", replies: { data: [{ id: "i2", text: "Ta", timestamp: "2026-09-02T11:00:00+0000", username: "brand" }] } }] })));
    const comments = await fetchComments("instagram", { externalAccountId: "I", accessToken: "T", scopes: [], username: "Brand" }, { externalPostId: "m1" });
    expect(comments.map((c) => [c.externalId, c.parentExternalId, c.fromSelf])).toEqual([["i1", null, false], ["i2", "i1", true]]);
  });

  it("reads YouTube threads and replies under the top-level comment", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body as string | undefined });
      if (String(input).includes("commentThreads")) {
        return json({ items: [{ id: "t1", snippet: { topLevelComment: { id: "t1", snippet: { authorDisplayName: "Cy", authorProfileImageUrl: "https://img/cy", textDisplay: "Loved it", publishedAt: "2026-09-03T10:00:00Z", authorChannelId: { value: "UCother" } } } }, replies: { comments: [{ id: "t1.r1", snippet: { parentId: "t1", authorDisplayName: "Us", textDisplay: "Thanks", publishedAt: "2026-09-03T11:00:00Z", authorChannelId: { value: "UCme" } } }] } }] });
      }
      return json({ id: "yt-reply" });
    }));
    const creds = { externalAccountId: "UCme", accessToken: "T", scopes: [YT_SCOPE] };
    const comments = await fetchComments("youtube", creds, { externalPostId: "vid1" });
    expect(calls[0]!.url).toContain("videoId=vid1");
    expect(comments.map((c) => [c.externalId, c.parentExternalId, c.fromSelf])).toEqual([["t1", null, false], ["t1.r1", "t1", true]]);
    expect(await replyToComment("youtube", creds, { externalCommentId: "t1", text: "Cheers" })).toEqual({ externalId: "yt-reply" });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ snippet: { parentId: "t1", textOriginal: "Cheers" } });
  });

  it("treats a video with comments switched off as having none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: 403, errors: [{ reason: "commentsDisabled" }] } }, 403)));
    expect(await fetchComments("youtube", { externalAccountId: "UC", accessToken: "T", scopes: [] }, { externalPostId: "v" })).toEqual([]);
  });

  it("has nothing for LinkedIn", async () => {
    await expect(fetchComments("linkedin", { externalAccountId: "L", accessToken: "T", scopes: [] }, { externalPostId: "p" })).rejects.toBeTruthy();
  });
});

type Agent = ReturnType<typeof request.agent>;
interface Person { agent: Agent; cookies: string[]; email: string; userId: string; workspaceId: string }
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;
const PASSWORD = "correct horse battery staple";

async function signup(): Promise<Person> {
  const agent = request.agent(app);
  const email = `inbox-test-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2)}@socialflow.test`;
  const res = await agent.post("/api/auth/signup").send({ email, password: PASSWORD, displayName: "Tester" });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return { agent, cookies: (res.headers["set-cookie"] as unknown as string[]).map((c) => c.split(";")[0]!), email, userId: res.body.user.id, workspaceId: res.body.workspace.id };
}

/** Owner invites a new person into the workspace with `role`; returns them with the owner's workspace active. */
async function addMember(owner: Person, role: string): Promise<Person> {
  const member = await signup();
  const invite = await owner.agent.post("/api/team/invitations").send({ email: member.email, role });
  expect(invite.status).toBe(201);
  const token = /token=([A-Za-z0-9_-]+)/.exec(invite.body.inviteUrl)![1]!;
  const accepted = await member.agent.post(`/api/invitations/${token}/accept`);
  expect(accepted.status).toBe(200);
  const cookies = ((accepted.headers["set-cookie"] as unknown as string[] | undefined) ?? []).map((c) => c.split(";")[0]!);
  if (cookies.length) member.cookies = cookies;
  return member;
}

const call = (who: Person, method: "get" | "post" | "patch", path: string) => request(mini)[method](`/api${path}`).set("Cookie", who.cookies);

async function account(workspaceId: string, platform: "facebook" | "instagram" | "youtube" | "linkedin", id: string, scopes: string[]) {
  return saveConnectedAccount(db, workspaceId, platform, {
    externalAccountId: id, accountType: `${platform}_test`, displayName: `${platform} ${id}`, username: null, avatarUrl: null, accessToken: `TOKEN_${id}`,
    refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes, metadata: {}, selectable: true, warnings: [],
  }, "u");
}

async function published(workspaceId: string, accountId: string, externalPostId: string, daysAgo: number) {
  const publishedAt = new Date(Date.now() - daysAgo * 86_400_000);
  const [post] = await db.insert(postsTable).values({ workspaceId, content: "hello", status: "published", scheduledAt: publishedAt, publishedAt }).returning();
  const [target] = await db.insert(postTargetsTable).values({ postId: post!.id, connectedAccountId: accountId, status: "published", externalPostId }).returning();
  return target!;
}

const comment = (id: string, minutesAgo: number, extra: Record<string, unknown> = {}) => ({ id, message: `text ${id}`, created_time: new Date(Date.now() - minutesAgo * 60_000).toISOString(), from: { id: `user-${id}`, name: `Person ${id}` }, ...extra });

describe.skipIf(!dbReady)("Inbox (database)", () => {
  beforeEach(() => { sent.length = 0; });
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("collects comments for accounts with the permission and reports the rest honestly, without calling the network for them", async () => {
    const owner = await signup();
    const fb = await account(owner.workspaceId, "facebook", "PG1", [FB_SCOPE]);
    const noScope = await account(owner.workspaceId, "facebook", "PG2", ["pages_manage_posts"]);
    const li = await account(owner.workspaceId, "linkedin", "LI1", ["w_member_social"]);
    const target = await published(owner.workspaceId, fb.id, "PG1_100", 2);
    await published(owner.workspaceId, fb.id, "PG1_OLD", 40); // outside the 30 day window
    await published(owner.workspaceId, noScope.id, "PG2_1", 1);
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return json({ data: [comment("a1", 30), comment("a2", 20, { parent: { id: "a1" } }), comment("mine", 10, { from: { id: "PG1", name: "Us" } })] });
    }));
    const outcomes = await collectWorkspace(owner.workspaceId);
    const byId = new Map(outcomes.map((o) => [o.accountId, o]));
    expect(byId.get(fb.id)).toMatchObject({ state: "ok", ok: true, postsRead: 1, newItems: 2 });
    expect(byId.get(noScope.id)?.state).toBe("permission_needed");
    expect(byId.get(li.id)?.state).toBe("unavailable");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("PG1_100");
    const items = await db.select().from(inboxItemsTable).where(eq(inboxItemsTable.workspaceId, owner.workspaceId));
    expect(items.map((i) => i.externalId).sort()).toEqual(["a1", "a2"]);
    expect(items.find((i) => i.externalId === "a2")).toMatchObject({ parentExternalId: "a1", status: "open", readAt: null, replied: false, postTargetId: target.id });
  });

  it("keeps status, read marks and assignments when the same comments are collected again", async () => {
    const owner = await signup();
    const fb = await account(owner.workspaceId, "facebook", "PG3", [FB_SCOPE]);
    await published(owner.workspaceId, fb.id, "PG3_1", 1);
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [comment("b1", 5)] })));
    await collectWorkspace(owner.workspaceId);
    const [item] = await db.select().from(inboxItemsTable).where(eq(inboxItemsTable.connectedAccountId, fb.id));
    const patched = await call(owner, "patch", `/inbox/${item!.id}`).send({ status: "resolved", read: true, assignedToUserId: owner.userId });
    expect(patched.status).toBe(200);
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [{ ...comment("b1", 5), message: "edited" }, comment("b2", 1)] })));
    const again = await collectWorkspace(owner.workspaceId);
    expect(again[0]).toMatchObject({ newItems: 1 });
    const all = await db.select().from(inboxItemsTable).where(eq(inboxItemsTable.connectedAccountId, fb.id));
    expect(all).toHaveLength(2);
    expect(all.find((i) => i.externalId === "b1")).toMatchObject({ body: "edited", status: "resolved", assignedToUserId: owner.userId });
    expect(all.find((i) => i.externalId === "b1")!.readAt).not.toBeNull();
  });

  it("turns a network permission error into permission needed", async () => {
    const owner = await signup();
    const fb = await account(owner.workspaceId, "facebook", "PG4", [FB_SCOPE]);
    await published(owner.workspaceId, fb.id, "PG4_1", 1);
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: 200, message: "(#200) no" } }, 403)));
    const [outcome] = await collectWorkspace(owner.workspaceId);
    expect(outcome!.state).toBe("permission_needed");
    const summary = await call(owner, "get", "/inbox/summary");
    expect(summary.body.accounts.find((a: { accountId: string }) => a.accountId === fb.id)).toMatchObject({ state: "available" });
  });

  it("lists with filters and cursor paging, summarises, and keeps workspaces apart", async () => {
    const owner = await signup();
    const viewer = await addMember(owner, "viewer");
    const editor = await addMember(owner, "editor");
    const other = await signup();
    const fb = await account(owner.workspaceId, "facebook", "PG5", [FB_SCOPE]);
    const li = await account(owner.workspaceId, "linkedin", "LI5", []);
    await published(owner.workspaceId, fb.id, "PG5_1", 1);
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [comment("p1", 50), comment("p2", 40), comment("p3", 30), comment("p4", 20), comment("p5", 10)] })));
    await collectWorkspace(owner.workspaceId);

    const first = await call(viewer, "get", "/inbox?limit=2");
    expect(first.status).toBe(200);
    expect(first.body.items.map((i: { externalId: string }) => i.externalId)).toEqual(["p5", "p4"]);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await call(viewer, "get", `/inbox?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((i: { externalId: string }) => i.externalId)).toEqual(["p3", "p2"]);
    const third = await call(viewer, "get", `/inbox?limit=2&cursor=${second.body.nextCursor}`);
    expect(third.body.items.map((i: { externalId: string }) => i.externalId)).toEqual(["p1"]);
    expect(third.body.nextCursor).toBeNull();

    // A viewer can read, but not change or answer.
    const p5 = first.body.items[0];
    expect((await call(viewer, "patch", `/inbox/${p5.id}`).send({ read: true })).status).toBe(403);
    expect((await call(viewer, "post", `/inbox/${p5.id}/reply`).send({ body: "hi" })).status).toBe(403);
    expect((await call(viewer, "post", "/inbox/refresh").send({})).status).toBe(403);
    expect((await call({ ...owner, cookies: [] }, "get", "/inbox")).status).toBe(401);

    // Editor works the inbox: mark read, assign to a member, resolve.
    expect((await call(editor, "patch", `/inbox/${p5.id}`).send({ read: true })).status).toBe(200);
    const assigned = await call(editor, "patch", `/inbox/${first.body.items[1].id}`).send({ assignedToUserId: editor.userId, status: "resolved" });
    expect(assigned.body).toMatchObject({ assignedToUserId: editor.userId, status: "resolved" });
    expect((await call(editor, "patch", `/inbox/${p5.id}`).send({ assignedToUserId: other.userId })).status).toBe(400);
    expect((await call(editor, "patch", `/inbox/${p5.id}`).send({})).status).toBe(400);
    expect((await call(editor, "patch", `/inbox/${p5.id}`).send({ status: "nope" })).status).toBe(400);

    const unread = await call(owner, "get", "/inbox?unread=true");
    expect(unread.body.items).toHaveLength(4);
    const resolved = await call(owner, "get", "/inbox?status=resolved");
    expect(resolved.body.items).toHaveLength(1);
    const mine = await call(editor, "get", "/inbox?assigned=me");
    expect(mine.body.items).toHaveLength(1);
    expect((await call(owner, "get", "/inbox?platform=facebook")).body.items).toHaveLength(5);
    expect((await call(owner, "get", "/inbox?platform=youtube")).body.items).toHaveLength(0);
    expect((await call(owner, "get", `/inbox?accountId=${fb.id}`)).body.items).toHaveLength(5);
    expect((await call(owner, "get", "/inbox?status=bogus")).status).toBe(400);
    expect((await call(owner, "get", "/inbox?cursor=garbage")).status).toBe(400);

    const summary = await call(viewer, "get", "/inbox/summary");
    expect(summary.body).toMatchObject({ open: 4, resolved: 1, unread: 3, assignedToMe: 0 });
    const accounts = new Map(summary.body.accounts.map((a: { accountId: string }) => [a.accountId, a]));
    expect(accounts.get(fb.id)).toMatchObject({ state: "available", reason: null, open: 4, unread: 3 });
    expect(accounts.get(li.id)).toMatchObject({ state: "unavailable" });
    expect((accounts.get(li.id) as { reason: string }).reason).toContain("LinkedIn");

    // Another workspace sees none of it.
    expect((await call(other, "get", "/inbox")).body.items).toEqual([]);
    expect((await call(other, "patch", `/inbox/${p5.id}`).send({ read: false })).status).toBe(404);
    expect((await call(other, "post", `/inbox/${p5.id}/reply`).send({ body: "x" })).status).toBe(404);
  });

  it("sends a reply to the network under the top-level comment and records it, and records a failed attempt", async () => {
    const owner = await signup();
    const fb = await account(owner.workspaceId, "facebook", "PG6", [FB_SCOPE]);
    await published(owner.workspaceId, fb.id, "PG6_1", 1);
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [comment("r1", 30), comment("r2", 20, { parent: { id: "r1" } })] })));
    await collectWorkspace(owner.workspaceId);
    const list = await call(owner, "get", "/inbox");
    const nested = list.body.items.find((i: { externalId: string }) => i.externalId === "r2");

    const posted: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => { posted.push({ url: String(input), body: String(init?.body) }); return json({ id: "r1_reply" }); }));
    const ok = await call(owner, "post", `/inbox/${nested.id}/reply`).send({ body: "  Thanks so much  " });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: "sent", body: "Thanks so much", externalId: "r1_reply", userId: owner.userId });
    expect(posted[0]!.url).toContain("/r1/comments");
    const after = (await call(owner, "get", "/inbox")).body.items.find((i: { externalId: string }) => i.externalId === "r2");
    expect(after).toMatchObject({ replied: true, read: true });
    expect(after.replies).toHaveLength(1);

    // The reply comes back from the network as the Page's own comment: it isn't a new inbox item.
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [comment("r1", 30), comment("r2", 20, { parent: { id: "r1" } }), comment("r1_reply", 1, { parent: { id: "r1" }, from: { id: "someone", name: "x" } })] })));
    await collectWorkspace(owner.workspaceId);
    expect(await db.select().from(inboxItemsTable).where(eq(inboxItemsTable.connectedAccountId, fb.id))).toHaveLength(2);

    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: 200, message: "(#200) denied" } }, 403)));
    const failed = await call(owner, "post", `/inbox/${nested.id}/reply`).send({ body: "again" });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe("reply_failed");
    const rows = await db.select().from(inboxRepliesTable).where(eq(inboxRepliesTable.itemId, nested.id));
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "sent"]);
    expect(JSON.stringify(rows)).not.toContain("TOKEN_");

    expect((await call(owner, "post", `/inbox/${nested.id}/reply`).send({ body: "   " })).status).toBe(400);
    expect((await call(owner, "post", `/inbox/${nested.id}/reply`).send({ body: "x".repeat(9000) })).status).toBe(400);
  });

  it("refuses to reply for an account without the permission, without calling the network", async () => {
    const owner = await signup();
    const fb = await account(owner.workspaceId, "facebook", "PG7", ["pages_manage_posts"]);
    const [item] = await db.insert(inboxItemsTable).values({ workspaceId: owner.workspaceId, connectedAccountId: fb.id, platform: "facebook", externalId: "z1", authorName: "Zed", body: "hi", createdAtNetwork: new Date() }).returning();
    const fetchSpy = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await call(owner, "post", `/inbox/${item!.id}/reply`).send({ body: "hello" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("permission_needed");
    expect(res.body.message).toContain(FB_SCOPE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes on demand", async () => {
    const owner = await signup();
    const fb = await account(owner.workspaceId, "facebook", "PG8", [FB_SCOPE]);
    await published(owner.workspaceId, fb.id, "PG8_1", 1);
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [comment("f1", 5)] })));
    const res = await call(owner, "post", "/inbox/refresh").send({ accountId: fb.id });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ accountId: fb.id, state: "ok", ok: true, postsRead: 1, newItems: 1, reason: null }]);
    await db.delete(connectedAccountsTable).where(eq(connectedAccountsTable.id, fb.id));
  });
});
