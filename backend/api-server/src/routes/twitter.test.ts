import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { connectedAccountsTable, db, tableExists, usersTable, workspacesTable } from "@workspace/db";
import app from "../app";
import { metricSupport } from "../lib/analytics";
import { mediaProblemForPlatform } from "../lib/media-rules";
import { ensureFreshToken, readCredentials } from "../lib/oauth/accounts";
import { inboxSupport, mentionsSupport, messagingSupport } from "../lib/oauth/inbox-adapters";
import { getAdapter } from "../lib/oauth/registry";
import { postUrl } from "../lib/publisher";
import { DEFAULT_TWITTER_USER, installFakeTwitter } from "../test/fake-twitter";

// X (Twitter) end to end through the real routes and the test database, with only X's HTTP faked:
// connect, publish with a first comment, the 280 limit when scheduling, and refresh tokens that work once.

const tablesExist = await tableExists("socialflow_connected_accounts").catch(() => false);
type Agent = ReturnType<typeof request.agent>;
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;

async function newAgent(): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email: `x-test-${Date.now()}-${counter++}@socialflow.test`, password: "correct horse battery staple" });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return agent;
}

/** Runs the whole connect flow and returns the connected account as the API lists it. */
async function connect(agent: Agent) {
  const start = await agent.get("/api/connections/twitter/start");
  expect(start.status).toBe(302);
  const dialog = new URL(start.headers.location as string);
  const callback = await agent.get(`/api/connections/twitter/callback?code=CODE&state=${dialog.searchParams.get("state")}`);
  expect(callback.status).toBe(302);
  const pendingId = new URL(callback.headers.location as string, "https://x").searchParams.get("pending")!;
  const complete = await agent.post(`/api/connections/pending/${pendingId}/complete`).send({ externalAccountIds: [DEFAULT_TWITTER_USER.id] });
  expect(complete.status).toBe(200);
  return { account: complete.body.accounts[0] as { id: string; platform: string; displayName: string; username: string; status: string; firstComment: string; accountType: string }, dialog };
}

const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

describe("X rules that need no database", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts up to four photos, or one GIF, or one video", () => {
    const jpg = { kind: "image" as const, mimeType: "image/jpeg", sizeBytes: 1000 };
    const gif = { kind: "image" as const, mimeType: "image/gif", sizeBytes: 1000 };
    const mp4 = { kind: "video" as const, mimeType: "video/mp4", sizeBytes: 1000 };
    expect(mediaProblemForPlatform("twitter", [])).toBeNull();
    expect(mediaProblemForPlatform("twitter", [jpg, jpg, jpg, jpg])).toBeNull();
    expect(mediaProblemForPlatform("twitter", [jpg, jpg, jpg, jpg, jpg])).toMatch(/up to 4 photos/);
    expect(mediaProblemForPlatform("twitter", [gif])).toBeNull();
    expect(mediaProblemForPlatform("twitter", [gif, jpg])).toMatch(/GIF has to be posted on its own/);
    expect(mediaProblemForPlatform("twitter", [mp4])).toBeNull();
    expect(mediaProblemForPlatform("twitter", [mp4, jpg])).toMatch(/photos or one video/);
    expect(mediaProblemForPlatform("twitter", [mp4, mp4])).toMatch(/one video/);
    expect(mediaProblemForPlatform("twitter", [{ kind: "video", mimeType: "video/webm" }])).toMatch(/MP4 and MOV/);
    expect(mediaProblemForPlatform("twitter", [{ ...jpg, sizeBytes: 6 * 1024 * 1024 }])).toMatch(/up to 5 MB/);
    expect(mediaProblemForPlatform("twitter", [{ ...gif, sizeBytes: 16 * 1024 * 1024 }])).toMatch(/up to 15 MB/);
  });

  it("says honestly what isn't read from X", () => {
    expect(inboxSupport("twitter", [], true)).toMatchObject({ state: "unavailable" });
    expect(messagingSupport("twitter", [], true)).toMatchObject({ state: "unavailable" });
    expect(mentionsSupport("twitter", [], true)).toMatchObject({ state: "unavailable" });
    expect(inboxSupport("twitter", [], true).reason).toMatch(/doesn't read replies, messages or mentions from X/);
  });

  it("reports numbers as unavailable until collecting is switched on", () => {
    expect(metricSupport("twitter", []).likes).toMatchObject({ available: false });
    expect(metricSupport("twitter", []).likes.reason).toMatch(/TWITTER_ANALYTICS_ENABLED/);
    vi.stubEnv("TWITTER_ANALYTICS_ENABLED", "true");
    expect(metricSupport("twitter", [])).toMatchObject({ followers: { available: true }, likes: { available: true }, impressions: { available: true }, saves: { available: true }, reach: { available: false }, views: { available: false } });
  });

  it("links to the post on X", () => {
    expect(postUrl("twitter", "1900000000000000001")).toBe("https://x.com/i/web/status/1900000000000000001");
  });
});

describe.skipIf(!tablesExist)("X connection and publishing (database)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (createdWorkspaceIds.size > 0) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size > 0) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("is listed as a provider with its own callback address, without leaking the client secret", async () => {
    const res = await request(app).get("/api/connections/providers");
    const provider = res.body.providers.find((p: { platform: string }) => p.platform === "twitter");
    expect(provider).toMatchObject({ platform: "twitter", name: "X (Twitter)", implemented: true, configured: true, missingConfiguration: [], callbackUrl: "https://socialflow.test/api/connections/twitter/callback" });
    expect(JSON.stringify(res.body)).not.toContain("test-twitter-secret");
  });

  it("connects an account: sign-in with PKCE, tokens stored encrypted, first comments supported", async () => {
    const agent = await newAgent();
    const { tokenCalls } = installFakeTwitter();
    const { account, dialog } = await connect(agent);

    expect(dialog.origin + dialog.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(dialog.searchParams.get("redirect_uri")).toBe("https://socialflow.test/api/connections/twitter/callback");
    expect(dialog.searchParams.get("code_challenge_method")).toBe("S256");
    // The verifier that matches the challenge is what the callback sends, and only to X.
    expect(tokenCalls[0]!.body.get("code_verifier")).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);

    expect(account).toMatchObject({ platform: "twitter", accountType: "twitter_account", displayName: "Acme Studio", username: "acmestudio", status: "active", firstComment: "supported" });
    const listed = await agent.get("/api/connections");
    expect(listed.body.accounts.map((a: { id: string }) => a.id)).toEqual([account.id]);
    expect(JSON.stringify(listed.body)).not.toContain("X_ACCESS_1");

    const [stored] = await db.select().from(connectedAccountsTable).where(eq(connectedAccountsTable.id, account.id));
    expect(stored!.accessTokenEncrypted).not.toContain("X_ACCESS_1");
    expect(stored!.refreshTokenEncrypted).not.toContain("X_REFRESH_1");
    expect(readCredentials(stored!)).toMatchObject({ accessToken: "X_ACCESS_1", refreshToken: "X_REFRESH_1" });
    expect(stored!.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 3600_000);
  });

  it("publishes a post and its first comment (a reply), and shows where it went", async () => {
    const agent = await newAgent();
    const { posts } = installFakeTwitter();
    const { account } = await connect(agent);

    const draft = await agent.post("/api/posts").send({ content: "Launch day 🚀 https://example.com/launch", connectedAccountIds: [account.id], firstComment: "More in the thread" });
    expect(draft.status).toBe(201);
    const sent = await agent.post(`/api/posts/${draft.body.id}/publish`);
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe("published");
    expect(sent.body.targets[0]).toMatchObject({ platform: "twitter", status: "published", postUrl: `https://x.com/i/web/status/${posts[0]!.id}`, firstCommentStatus: "published", errorMessage: null });

    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toEqual({ text: "Launch day 🚀 https://example.com/launch" });
    expect(posts[1]!.body).toEqual({ text: "More in the thread", reply: { in_reply_to_tweet_id: posts[0]!.id } });
    expect(posts.every((post) => post.authorization === "Bearer X_ACCESS_1")).toBe(true);
  });

  it("holds scheduled posts to 280 as X counts it, and lets a shorter X version through", async () => {
    const agent = await newAgent();
    installFakeTwitter();
    const { account } = await connect(agent);
    const long = "word ".repeat(70).trim(); // 349 characters

    const refused = await agent.post("/api/posts").send({ content: long, connectedAccountIds: [account.id], scheduledAt: inAnHour() });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/349 characters the way X counts it, and X allows 280/);

    // A draft may be any length; it is checked when it is scheduled or published.
    expect((await agent.post("/api/posts").send({ content: long, connectedAccountIds: [account.id] })).status).toBe(201);
    // A long link doesn't count in full: 250 + 1 + 23.
    expect((await agent.post("/api/posts").send({ content: `${"a".repeat(250)} https://example.com/${"x".repeat(150)}`, connectedAccountIds: [account.id], scheduledAt: inAnHour() })).status).toBe(201);
    // The per-network text for X is what is measured when there is one.
    const withVersion = await agent.post("/api/posts").send({ content: long, connectedAccountIds: [account.id], scheduledAt: inAnHour(), platformContent: { twitter: "The short version for X" } });
    expect(withVersion.status).toBe(201);
    expect(withVersion.body.platformContent).toEqual({ twitter: "The short version for X" });
    const tooLongVersion = await agent.post("/api/posts").send({ content: "Short", connectedAccountIds: [account.id], scheduledAt: inAnHour(), platformContent: { twitter: "字".repeat(141) } });
    expect(tooLongVersion.status).toBe(400);
  });

  it("reports a post X refuses on the post, and keeps the account usable", async () => {
    const agent = await newAgent();
    installFakeTwitter();
    const { account } = await connect(agent);
    installFakeTwitter({ postError: { status: 403, body: { title: "Forbidden", detail: "You are not allowed to create a Tweet with duplicate content.", status: 403 } } });
    const draft = await agent.post("/api/posts").send({ content: "Same again", connectedAccountIds: [account.id] });
    const sent = await agent.post(`/api/posts/${draft.body.id}/publish`);
    expect(sent.body.status).toBe("failed");
    expect(sent.body.targets[0].errorMessage).toMatch(/duplicate content/);
    const listed = await agent.get("/api/connections");
    expect(listed.body.accounts[0].status).toBe("active");
  });

  it("refreshes an expiring token once, however many things ask at the same moment, and keeps the new refresh token", async () => {
    const agent = await newAgent();
    const { tokenCalls } = installFakeTwitter();
    const { account } = await connect(agent);
    await db.update(connectedAccountsTable).set({ tokenExpiresAt: new Date(Date.now() - 60_000) }).where(eq(connectedAccountsTable.id, account.id));
    const [stale] = await db.select().from(connectedAccountsTable).where(eq(connectedAccountsTable.id, account.id));
    const adapter = getAdapter("twitter");

    const results = await Promise.all(Array.from({ length: 5 }, () => ensureFreshToken(stale!, adapter)));
    expect(tokenCalls.filter((call) => call.body.get("grant_type") === "refresh_token")).toHaveLength(1);
    expect(results.every((row) => row.status === "active")).toBe(true);
    expect(new Set(results.map((row) => readCredentials(row).accessToken))).toEqual(new Set(["X_ACCESS_2"]));

    const [stored] = await db.select().from(connectedAccountsTable).where(eq(connectedAccountsTable.id, account.id));
    expect(readCredentials(stored!)).toMatchObject({ accessToken: "X_ACCESS_2", refreshToken: "X_REFRESH_2" });

    // A copy of the account read before the refresh still carries the retired refresh token. It must not be sent again.
    const again = await ensureFreshToken(stale!, adapter);
    expect(readCredentials(again).accessToken).toBe("X_ACCESS_2");
    expect(tokenCalls.filter((call) => call.body.get("grant_type") === "refresh_token")).toHaveLength(1);
    expect((await agent.get("/api/connections")).body.accounts[0].status).toBe("active");
  });

  it("marks the account for reconnecting when X no longer accepts its refresh token", async () => {
    const agent = await newAgent();
    installFakeTwitter();
    const { account } = await connect(agent);
    await db.update(connectedAccountsTable).set({ tokenExpiresAt: new Date(Date.now() - 60_000) }).where(eq(connectedAccountsTable.id, account.id));
    // A fresh fake knows nothing of the stored refresh token, as X would after access was revoked there.
    installFakeTwitter();
    const draft = await agent.post("/api/posts").send({ content: "Will not go out", connectedAccountIds: [account.id] });
    const sent = await agent.post(`/api/posts/${draft.body.id}/publish`);
    expect(sent.body.status).toBe("failed");
    expect(sent.body.targets[0].errorMessage).toMatch(/needs to be reconnected/);
    expect((await agent.get("/api/connections")).body.accounts[0].status).toBe("revoked");
  });
});
