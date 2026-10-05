import { and, eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedAccountsTable, db, postsTable, postTargetsTable, tableExists, usersTable, workspacesTable } from "@workspace/db";
import app from "../app";
import { installFakeGraph } from "../test/fake-graph";
import { saveConnectedAccount } from "./oauth/accounts";
import { claimDuePosts, runPublishCycle } from "./publisher";

// Publishing engine + publish-now route against a real Postgres, with only the
// Facebook Graph API faked.
//
// SAFETY: the publisher operates on *every* due post in the database (that's its
// job), and these tests deliberately create due, overdue and stuck posts. Running
// them against a database with real users' data would publish, fail or rewrite
// those posts. So they only run against a database whose name ends in "_test":
//   CREATE DATABASE socialflow_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;   (the test setup creates the tables)
//   DATABASE_URL=mysql://.../socialflow_test pnpm --filter @workspace/api-server run test
const isolatedTestDb = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").pathname.replace("/", "").endsWith("_test");
  } catch {
    return false;
  }
})();

const tablesExist = isolatedTestDb && await tableExists("socialflow_posts").catch(() => false);

type Agent = ReturnType<typeof request.agent>;
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;

async function newUser(): Promise<{ agent: Agent; workspaceId: string }> {
  const agent = request.agent(app);
  const email = `publisher-test-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2)}@socialflow.test`;
  const res = await agent.post("/api/auth/signup").send({ email, password: "correct horse battery staple" });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return { agent, workspaceId: res.body.workspace.id };
}

/** A connected account whose tokens are stored exactly as the real OAuth flow stores them. */
async function connect(workspaceId: string, platform: "facebook" | "instagram", externalId: string, name: string, status: "active" | "revoked" = "active"): Promise<string> {
  const row = await saveConnectedAccount(
    db,
    workspaceId,
    platform,
    {
      externalAccountId: externalId,
      accountType: platform === "facebook" ? "facebook_page" : "instagram_business",
      displayName: name,
      username: null,
      avatarUrl: null,
      accessToken: `PAGE_TOKEN_${externalId}`,
      refreshToken: null,
      tokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
      metadata: {},
      selectable: true,
      warnings: [],
    },
    "fb-user",
  );
  if (status !== "active") await db.update(connectedAccountsTable).set({ status }).where(eq(connectedAccountsTable.id, row.id));
  return row.id;
}

const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

/** Schedules through the real API, then moves the time into the past (the API refuses past times). */
async function scheduleDue(agent: Agent, accountIds: string[], content = "Hello from Socialflow", minutesAgo = 1): Promise<string> {
  const res = await agent.post("/api/posts").send({ content, connectedAccountIds: accountIds, scheduledAt: inAnHour() });
  expect(res.status).toBe(201);
  await db.update(postsTable).set({ scheduledAt: new Date(Date.now() - minutesAgo * 60_000) }).where(eq(postsTable.id, res.body.id));
  return res.body.id as string;
}

async function loadPost(id: string) {
  const [post] = await db.select().from(postsTable).where(eq(postsTable.id, id));
  const targets = await db.select().from(postTargetsTable).where(eq(postTargetsTable.postId, id));
  return { post: post!, targets };
}

describe.skipIf(!tablesExist)("Publishing engine (database, test DB only)", () => {
  beforeEach(() => {
    // Safe only because this suite is restricted to a *_test database (see above).
    return db.update(postsTable).set({ status: "failed" }).where(and(eq(postsTable.status, "scheduled"), sql`${postsTable.scheduledAt} < now()`));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("publishes a due post to a Facebook Page and records the result", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
    const postId = await scheduleDue(agent, [account], "Fresh loaves at 8am");
    const { feedPosts } = installFakeGraph();

    const result = await runPublishCycle();
    expect(result.claimed).toBeGreaterThanOrEqual(1);

    expect(feedPosts).toHaveLength(1);
    expect(feedPosts[0]!.pageId).toBe("1001");
    expect(feedPosts[0]!.body.get("message")).toBe("Fresh loaves at 8am");
    expect(feedPosts[0]!.body.get("access_token")).toBe("PAGE_TOKEN_1001");
    expect(feedPosts[0]!.body.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);

    const { post, targets } = await loadPost(postId);
    expect(post.status).toBe("published");
    expect(post.publishedAt).toBeInstanceOf(Date);
    expect(targets[0]).toMatchObject({ status: "published", errorMessage: null });
    expect(targets[0]!.externalPostId).toMatch(/^1001_/);

    const api = await agent.get(`/api/posts/${postId}`);
    expect(api.body.status).toBe("published");
    expect(api.body.targets[0].postUrl).toBe(`https://www.facebook.com/${targets[0]!.externalPostId}`);
    expect(JSON.stringify(api.body)).not.toContain("PAGE_TOKEN");
  });

  it("does not publish a post before its scheduled time", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
    const created = await agent.post("/api/posts").send({ content: "Later", connectedAccountIds: [account], scheduledAt: inAnHour() });
    const { fetchMock } = installFakeGraph();

    await runPublishCycle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await loadPost(created.body.id)).post.status).toBe("scheduled");
  });

  it("marks the target failed and the account revoked when Facebook rejects the token", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
    const postId = await scheduleDue(agent, [account]);
    installFakeGraph({ publishErrors: { "1001": { code: 190, error_subcode: 460, message: "Error validating access token: The session has been invalidated." } } });

    await runPublishCycle();

    const { post, targets } = await loadPost(postId);
    expect(post.status).toBe("failed");
    expect(targets[0]!.status).toBe("failed");
    expect(targets[0]!.errorMessage).toContain("session has been invalidated");
    const [acct] = await db.select().from(connectedAccountsTable).where(eq(connectedAccountsTable.id, account));
    expect(acct!.status).toBe("revoked");
  });

  it("reports Facebook's own reason when a post is rejected for another reason", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
    const postId = await scheduleDue(agent, [account]);
    installFakeGraph({ publishErrors: { "1001": { code: 368, message: "You're temporarily blocked from posting duplicate content." } } });

    await runPublishCycle();
    const { post, targets } = await loadPost(postId);
    expect(post.status).toBe("failed");
    expect(targets[0]!.errorMessage).toContain("temporarily blocked");
    const [acct] = await db.select().from(connectedAccountsTable).where(eq(connectedAccountsTable.id, account));
    expect(acct!.status).toBe("active");
  });

  it("fails a post that is far past its time instead of sending it late", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
    const postId = await scheduleDue(agent, [account], "Stale", 3 * 60);
    const { fetchMock } = installFakeGraph();

    await runPublishCycle();
    expect(fetchMock).not.toHaveBeenCalled();
    const { post, targets } = await loadPost(postId);
    expect(post.status).toBe("failed");
    expect(targets[0]!.errorMessage).toContain("wasn't sent within");
  });

  it("does not post to an account that needs reconnecting", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
    const postId = await scheduleDue(agent, [account]);
    await db.update(connectedAccountsTable).set({ status: "revoked", statusDetail: "Access was revoked." }).where(eq(connectedAccountsTable.id, account));
    const { fetchMock } = installFakeGraph();

    await runPublishCycle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await loadPost(postId)).targets[0]!.errorMessage).toContain("needs to be reconnected");
  });

  it("never lets two claimers take the same post", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
    const postId = await scheduleDue(agent, [account]);

    const claims = await Promise.all([claimDuePosts(50), claimDuePosts(50), claimDuePosts(50)]);
    const holders = claims.filter((ids) => ids.includes(postId));
    expect(holders).toHaveLength(1);
    expect((await loadPost(postId)).post.status).toBe("publishing");
  });

  it("does not send a post twice when two cycles overlap", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
    await scheduleDue(agent, [account]);
    const { feedPosts } = installFakeGraph({ publishDelayMs: 150 });

    await Promise.all([runPublishCycle(), runPublishCycle()]);
    await runPublishCycle();
    expect(feedPosts).toHaveLength(1);
  });

  it("fails a post interrupted mid-publish instead of retrying it (which could duplicate it)", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
    const postId = await scheduleDue(agent, [account]);
    await db.update(postsTable).set({ status: "publishing", updatedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(postsTable.id, postId));
    await db.update(postTargetsTable).set({ status: "publishing" }).where(eq(postTargetsTable.postId, postId));
    const { fetchMock } = installFakeGraph();

    const result = await runPublishCycle();
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const { post, targets } = await loadPost(postId);
    expect(post.status).toBe("failed");
    expect(targets[0]!.errorMessage).toContain("interrupted");
  });

  it("treats an interrupted post whose accounts all published as published, not failed", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
    const postId = await scheduleDue(agent, [account]);
    // The process died after the network accepted the post and the target was recorded, before the post was finalized.
    await db.update(postsTable).set({ status: "publishing", updatedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(postsTable.id, postId));
    await db.update(postTargetsTable).set({ status: "published", externalPostId: "1001_777" }).where(eq(postTargetsTable.postId, postId));
    const { fetchMock } = installFakeGraph();

    await runPublishCycle();
    expect(fetchMock).not.toHaveBeenCalled();
    const { post } = await loadPost(postId);
    expect(post.status).toBe("published");
    expect(post.publishedAt).toBeInstanceOf(Date);
  });

  it("will not delete a post that is being published, and reports why", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
    const postId = await scheduleDue(agent, [account]);
    await db.update(postsTable).set({ status: "publishing" }).where(eq(postsTable.id, postId));
    const res = await agent.delete(`/api/posts/${postId}`);
    expect(res.status).toBe(400);
    expect((await loadPost(postId)).post.status).toBe("publishing");
    expect((await agent.delete(`/api/posts/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it("does not touch a post that is still legitimately publishing", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
    const postId = await scheduleDue(agent, [account]);
    await db.update(postsTable).set({ status: "publishing" }).where(eq(postsTable.id, postId));
    await db.update(postTargetsTable).set({ status: "publishing" }).where(eq(postTargetsTable.postId, postId));
    installFakeGraph();

    await runPublishCycle();
    expect((await loadPost(postId)).post.status).toBe("publishing");
  });

  describe("Publish now", () => {
    it("publishes a draft immediately and returns the result", async () => {
      const { agent, workspaceId } = await newUser();
      const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
      const draft = await agent.post("/api/posts").send({ content: "Straight to the page", connectedAccountIds: [account] });
      const { feedPosts } = installFakeGraph();

      const res = await agent.post(`/api/posts/${draft.body.id}/publish`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("published");
      expect(res.body.targets[0]).toMatchObject({ status: "published", errorMessage: null });
      expect(res.body.targets[0].postUrl).toContain("facebook.com/1001_");
      expect(feedPosts).toHaveLength(1);

      const again = await agent.post(`/api/posts/${draft.body.id}/publish`);
      expect(again.status).toBe(400);
      expect(feedPosts).toHaveLength(1);
    });

    it("returns 200 with a failed status and the reason when the network rejects it", async () => {
      const { agent, workspaceId } = await newUser();
      const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
      const draft = await agent.post("/api/posts").send({ content: "Will be rejected", connectedAccountIds: [account] });
      installFakeGraph({ publishErrors: { "1001": { code: 368, message: "Blocked for spam." } } });

      const res = await agent.post(`/api/posts/${draft.body.id}/publish`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("failed");
      expect(res.body.targets[0].errorMessage).toContain("Blocked for spam.");
    });

    it("retries only the accounts that failed, never re-sending the ones that succeeded", async () => {
      const { agent, workspaceId } = await newUser();
      const a = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
      const b = await connect(workspaceId, "facebook", "1002", "Acme Fans");
      const draft = await agent.post("/api/posts").send({ content: "Two pages", connectedAccountIds: [a, b] });
      const first = installFakeGraph({ pages: [{ id: "1001", name: "A", access_token: "T1" }, { id: "1002", name: "B", access_token: "T2" }], publishErrors: { "1002": { code: 368, message: "Blocked." } } });

      const res1 = await agent.post(`/api/posts/${draft.body.id}/publish`);
      expect(res1.body.status).toBe("failed");
      expect(res1.body.targets.map((t: { status: string }) => t.status).sort()).toEqual(["failed", "published"]);
      expect(first.feedPosts.map((p) => p.pageId).sort()).toEqual(["1001", "1002"]);

      vi.unstubAllGlobals();
      const second = installFakeGraph({ pages: [{ id: "1001", name: "A", access_token: "T1" }, { id: "1002", name: "B", access_token: "T2" }] });
      const res2 = await agent.post(`/api/posts/${draft.body.id}/publish`);
      expect(res2.body.status).toBe("published");
      expect(second.feedPosts.map((p) => p.pageId)).toEqual(["1002"]);
    });

    it("refuses to edit a post that already went out to some accounts", async () => {
      const { agent, workspaceId } = await newUser();
      const a = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
      const b = await connect(workspaceId, "facebook", "1002", "Acme Fans");
      const draft = await agent.post("/api/posts").send({ content: "Two pages", connectedAccountIds: [a, b] });
      installFakeGraph({ pages: [{ id: "1001", name: "A", access_token: "T1" }, { id: "1002", name: "B", access_token: "T2" }], publishErrors: { "1002": { code: 368, message: "Blocked." } } });
      await agent.post(`/api/posts/${draft.body.id}/publish`);

      const edit = await agent.patch(`/api/posts/${draft.body.id}`).send({ content: "changed", scheduledAt: inAnHour() });
      expect(edit.status).toBe(400);
      expect(edit.body.message).toContain("already went out");
    });

    it("cannot publish, edit or delete another user's post", async () => {
      const alice = await newUser();
      const bob = await newUser();
      const account = await connect(alice.workspaceId, "facebook", "1001", "Acme Bakery");
      const draft = await alice.agent.post("/api/posts").send({ content: "Mine", connectedAccountIds: [account] });
      const { fetchMock } = installFakeGraph();

      expect((await bob.agent.post(`/api/posts/${draft.body.id}/publish`)).status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await request(app).post(`/api/posts/${draft.body.id}/publish`)).status).toBe(401);
    });

    it("rejects publishing an empty post, one with no accounts, or one for a media-only network", async () => {
      const { agent, workspaceId } = await newUser();
      const fb = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
      const ig = await connect(workspaceId, "instagram", "ig-1", "acme.bakery");
      const { fetchMock } = installFakeGraph();

      const empty = await agent.post("/api/posts").send({ content: "   ", connectedAccountIds: [fb] });
      expect((await agent.post(`/api/posts/${empty.body.id}/publish`)).status).toBe(400);
      const noAccounts = await agent.post("/api/posts").send({ content: "Hi", connectedAccountIds: [] });
      expect((await agent.post(`/api/posts/${noAccounts.body.id}/publish`)).status).toBe(400);
      const media = await agent.post("/api/posts").send({ content: "A photo caption", connectedAccountIds: [ig] });
      const res = await agent.post(`/api/posts/${media.body.id}/publish`);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Instagram");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("won't edit or delete a post while it is being published", async () => {
      const { agent, workspaceId } = await newUser();
      const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
      const draft = await agent.post("/api/posts").send({ content: "In flight", connectedAccountIds: [account] });
      await db.update(postsTable).set({ status: "publishing" }).where(eq(postsTable.id, draft.body.id));

      expect((await agent.patch(`/api/posts/${draft.body.id}`).send({ content: "x" })).status).toBe(400);
      expect((await agent.delete(`/api/posts/${draft.body.id}`)).status).toBe(400);
      expect((await agent.post(`/api/posts/${draft.body.id}/publish`)).status).toBe(400);
    });
  });

  it("refuses to schedule a post for Instagram, which needs media, but allows saving a draft", async () => {
    const { agent, workspaceId } = await newUser();
    const ig = await connect(workspaceId, "instagram", "ig-1", "acme.bakery");
    const scheduled = await agent.post("/api/posts").send({ content: "Caption", connectedAccountIds: [ig], scheduledAt: inAnHour() });
    expect(scheduled.status).toBe(400);
    expect(scheduled.body.message).toContain("Instagram");
    const draft = await agent.post("/api/posts").send({ content: "Caption", connectedAccountIds: [ig] });
    expect(draft.status).toBe(201);
  });
  it("publishes a link post to a Facebook Page as a real link post", async () => {
    const { agent, workspaceId } = await newUser();
    const account = await connect(workspaceId, "facebook", "1001", "Acme Bakery");
    const created = await agent.post("/api/posts").send({ content: "New menu", connectedAccountIds: [account], scheduledAt: inAnHour(), link: { url: "https://example.com/menu", title: "Menu", description: null, imageUrl: null } });
    expect(created.status).toBe(201);
    await db.update(postsTable).set({ scheduledAt: new Date(Date.now() - 60_000) }).where(eq(postsTable.id, created.body.id));
    const { feedPosts } = installFakeGraph();
    await runPublishCycle();
    const sent = feedPosts.filter((p) => p.body.get("message") === "New menu");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.get("link")).toBe("https://example.com/menu");
    expect((await loadPost(created.body.id)).post.status).toBe("published");
  });
});
