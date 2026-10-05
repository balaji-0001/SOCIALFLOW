import { inArray } from "drizzle-orm";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { connectedAccountsTable, db, tableExists, usersTable, workspacesTable } from "@workspace/db";
import app from "../app";
import { encryptSecret } from "../lib/crypto";

const tablesExist = await tableExists("socialflow_posts").catch(() => false);

type Agent = ReturnType<typeof request.agent>;
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;

async function newUser(): Promise<{ agent: Agent; workspaceId: string }> {
  const agent = request.agent(app);
  const email = `posts-test-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2)}@socialflow.test`;
  const res = await agent.post("/api/auth/signup").send({ email, password: "correct horse battery staple" });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return { agent, workspaceId: res.body.workspace.id };
}

async function addAccount(workspaceId: string, name: string, status: "active" | "revoked" = "active"): Promise<string> {
  const [row] = await db
    .insert(connectedAccountsTable)
    .values({
      workspaceId,
      platform: "facebook",
      accountType: "facebook_page",
      externalAccountId: `ext-${Math.random().toString(36).slice(2)}`,
      displayName: name,
      accessTokenEncrypted: encryptSecret("token", "test"),
      status,
    })
    .returning({ id: connectedAccountsTable.id });
  return row!.id;
}

const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe.skipIf(!tablesExist)("Post routes (database)", () => {
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("requires sign-in", async () => {
    expect((await request(app).get("/api/posts")).status).toBe(401);
    expect((await request(app).post("/api/posts").send({ content: "x", connectedAccountIds: [] })).status).toBe(401);
  });

  it("saves a draft without accounts or a time, and a scheduled post with both", async () => {
    const { agent, workspaceId } = await newUser();
    const accountId = await addAccount(workspaceId, "Acme Page");

    const draft = await agent.post("/api/posts").send({ content: "", connectedAccountIds: [] });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ status: "draft", scheduledAt: null, targets: [] });

    const when = inAnHour();
    const scheduled = await agent.post("/api/posts").send({ content: "Launch day", connectedAccountIds: [accountId], scheduledAt: when });
    expect(scheduled.status).toBe(201);
    expect(scheduled.body.status).toBe("scheduled");
    expect(new Date(scheduled.body.scheduledAt).toISOString()).toBe(when);
    expect(scheduled.body.targets).toEqual([expect.objectContaining({ connectedAccountId: accountId, accountName: "Acme Page", platform: "facebook", status: "scheduled" })]);
  });

  it("rejects scheduling an empty post, a post with no accounts, or a time in the past", async () => {
    const { agent, workspaceId } = await newUser();
    const accountId = await addAccount(workspaceId, "Acme Page");
    const past = new Date(Date.now() - 60_000).toISOString();

    expect((await agent.post("/api/posts").send({ content: "  ", connectedAccountIds: [accountId], scheduledAt: inAnHour() })).status).toBe(400);
    expect((await agent.post("/api/posts").send({ content: "Hi", connectedAccountIds: [], scheduledAt: inAnHour() })).status).toBe(400);
    expect((await agent.post("/api/posts").send({ content: "Hi", connectedAccountIds: [accountId], scheduledAt: past })).status).toBe(400);
  });

  it("refuses accounts from another workspace and accounts that need reconnecting", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const bobsAccount = await addAccount(bob.workspaceId, "Bob's Page");
    const revoked = await addAccount(alice.workspaceId, "Broken Page", "revoked");

    const crossTenant = await alice.agent.post("/api/posts").send({ content: "Hi", connectedAccountIds: [bobsAccount], scheduledAt: inAnHour() });
    expect(crossTenant.status).toBe(400);
    const unhealthy = await alice.agent.post("/api/posts").send({ content: "Hi", connectedAccountIds: [revoked], scheduledAt: inAnHour() });
    expect(unhealthy.status).toBe(400);
    expect(unhealthy.body.message).toContain("reconnected");
  });

  it("filters by date range and status, and only returns the caller's posts", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const account = await addAccount(alice.workspaceId, "Acme Page");
    const soon = new Date(Date.now() + 2 * 3600_000).toISOString();
    const later = new Date(Date.now() + 10 * 86_400_000).toISOString();

    await alice.agent.post("/api/posts").send({ content: "soon", connectedAccountIds: [account], scheduledAt: soon });
    await alice.agent.post("/api/posts").send({ content: "later", connectedAccountIds: [account], scheduledAt: later });
    await alice.agent.post("/api/posts").send({ content: "draft", connectedAccountIds: [] });
    await bob.agent.post("/api/posts").send({ content: "bob draft", connectedAccountIds: [] });

    const all = await alice.agent.get("/api/posts");
    expect(all.body.posts.map((p: { content: string }) => p.content).sort()).toEqual(["draft", "later", "soon"]);

    const window = await alice.agent.get("/api/posts").query({ from: new Date().toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() });
    expect(window.body.posts.map((p: { content: string }) => p.content)).toEqual(["soon"]);

    const drafts = await alice.agent.get("/api/posts").query({ status: "draft" });
    expect(drafts.body.posts.map((p: { content: string }) => p.content)).toEqual(["draft"]);

    expect((await alice.agent.get("/api/posts").query({ status: "bogus" })).status).toBe(400);
  });

  it("reschedules, converts to draft and back, and changes accounts", async () => {
    const { agent, workspaceId } = await newUser();
    const a = await addAccount(workspaceId, "A");
    const b = await addAccount(workspaceId, "B");
    const created = await agent.post("/api/posts").send({ content: "Hello", connectedAccountIds: [a], scheduledAt: inAnHour() });
    const id = created.body.id as string;

    const newTime = new Date(Date.now() + 5 * 3600_000).toISOString();
    const moved = await agent.patch(`/api/posts/${id}`).send({ scheduledAt: newTime });
    expect(moved.status).toBe(200);
    expect(new Date(moved.body.scheduledAt).toISOString()).toBe(newTime);

    const asDraft = await agent.patch(`/api/posts/${id}`).send({ scheduledAt: null });
    expect(asDraft.body).toMatchObject({ status: "draft", scheduledAt: null });
    expect(asDraft.body.targets[0].status).toBe("draft");

    const rescheduled = await agent.patch(`/api/posts/${id}`).send({ scheduledAt: newTime, connectedAccountIds: [a, b], content: "Edited" });
    expect(rescheduled.body.status).toBe("scheduled");
    expect(rescheduled.body.content).toBe("Edited");
    expect(rescheduled.body.targets).toHaveLength(2);

    const past = await agent.patch(`/api/posts/${id}`).send({ scheduledAt: new Date(Date.now() - 1000).toISOString() });
    expect(past.status).toBe(400);
  });

  it("cannot read, edit or delete another user's post", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const post = await alice.agent.post("/api/posts").send({ content: "mine", connectedAccountIds: [] });
    const id = post.body.id as string;

    expect((await bob.agent.get(`/api/posts/${id}`)).status).toBe(404);
    expect((await bob.agent.patch(`/api/posts/${id}`).send({ content: "hijack" })).status).toBe(404);
    expect((await bob.agent.delete(`/api/posts/${id}`)).status).toBe(404);
    expect((await alice.agent.get(`/api/posts/${id}`)).body.content).toBe("mine");
  });

  it("deletes a post", async () => {
    const { agent } = await newUser();
    const post = await agent.post("/api/posts").send({ content: "bye", connectedAccountIds: [] });
    expect((await agent.delete(`/api/posts/${post.body.id}`)).status).toBe(204);
    expect((await agent.get(`/api/posts/${post.body.id}`)).status).toBe(404);
  });
  it("stores an attached link, returns it, edits it and removes it", async () => {
    const { agent, workspaceId } = await newUser();
    const accountId = await addAccount(workspaceId, "Acme Page");
    const link = { url: "https://example.com/story", title: "The story", description: "About it", imageUrl: "https://example.com/i.png" };
    const created = await agent.post("/api/posts").send({ content: "Read this", connectedAccountIds: [accountId], link });
    expect(created.status).toBe(201);
    expect(created.body.link).toEqual(link);
    expect((await agent.get(`/api/posts/${created.body.id}`)).body.link).toEqual(link);

    // Not sending link leaves it alone; edited title/description are kept.
    const untouched = await agent.patch(`/api/posts/${created.body.id}`).send({ content: "Read this now" });
    expect(untouched.status).toBe(200);
    expect(untouched.body.link).toEqual(link);
    expect(untouched.body.content).toBe("Read this now");
    const edited = await agent.patch(`/api/posts/${created.body.id}`).send({ link: { ...link, title: "My own title" } });
    expect(edited.body.link.title).toBe("My own title");
    expect(edited.body.content).toBe("Read this now");

    const removed = await agent.patch(`/api/posts/${created.body.id}`).send({ link: null });
    expect(removed.status).toBe(200);
    expect(removed.body.link).toBeNull();
    const plain = await agent.post("/api/posts").send({ content: "No link", connectedAccountIds: [] });
    expect(plain.body.link).toBeNull();
  });

  it("rejects an invalid link", async () => {
    const { agent } = await newUser();
    for (const link of [{ url: "ftp://x.test" }, { url: "javascript:alert(1)" }, { url: "https://x.test", imageUrl: "data:image/png;base64,AA" }, { url: "https://x.test", title: "t".repeat(301) }, { url: "https://x.test", description: "d".repeat(1001) }, "nope"]) {
      const res = await agent.post("/api/posts").send({ content: "x", connectedAccountIds: [], link });
      expect(res.status).toBe(400);
    }
  });
});
