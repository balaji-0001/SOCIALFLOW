import { eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  connectedAccountsTable,
  db,
  tableExists,
  usersTable,
  workspacesTable,
} from "@workspace/db";
import app from "../app";
import { installFakeGraph } from "../test/fake-graph";

// End-to-end test of the auth + OAuth routes against the real database, with
// only the Facebook Graph API faked. Skipped when the database has no tables
// (the test setup creates them from lib/db/src/migrate.ts).
const tablesExist = await tableExists("socialflow_connected_accounts").catch(() => false);

type Agent = ReturnType<typeof request.agent>;
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let emailCounter = 0;

/** A signed-up, signed-in agent with its own fresh user + workspace. */
async function newAgent(): Promise<Agent> {
  const agent = request.agent(app);
  const email = `oauth-test-${Date.now()}-${emailCounter++}-${Math.random().toString(36).slice(2)}@socialflow.test`;
  const res = await agent.post("/api/auth/signup").send({ email, password: "correct horse battery staple" });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return agent;
}

function redirectParams(res: request.Response): URLSearchParams {
  const location = res.headers.location as string;
  expect(res.status).toBe(302);
  expect(location.startsWith("/workspace?")).toBe(true);
  return new URL(location, "https://x").searchParams;
}

async function startFlow(agent: Agent, query = ""): Promise<{ state: string; dialog: URL }> {
  const res = await agent.get(`/api/connections/facebook/start${query}`);
  expect(res.status).toBe(302);
  const dialog = new URL(res.headers.location as string);
  expect(dialog.hostname).toBe("www.facebook.com");
  return { state: dialog.searchParams.get("state")!, dialog };
}

async function connectFirstPage(agent: Agent) {
  installFakeGraph();
  const { state } = await startFlow(agent);
  const callback = await agent.get(`/api/connections/facebook/callback?code=CODE&state=${state}`);
  const pendingId = redirectParams(callback).get("pending")!;
  const complete = await agent.post(`/api/connections/pending/${pendingId}/complete`).send({ externalAccountIds: ["1001"] });
  expect(complete.status).toBe(200);
  return complete.body.accounts[0] as { id: string };
}

describe.skipIf(!tablesExist)("OAuth connection routes (database)", () => {
  beforeAll(() => {
    expect(process.env.NODE_ENV).toBe("test");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    // Deleting workspaces cascades pending connections, OAuth states,
    // connected accounts and workspace-membership rows; deleting users
    // cascades their sessions.
    if (createdWorkspaceIds.size > 0) {
      await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    }
    if (createdUserIds.size > 0) {
      await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
    }
  });

  it("reports all four platforms as implemented and configured in the test environment", async () => {
    const res = await request(app).get("/api/connections/providers");
    expect(res.status).toBe(200);
    expect(res.body.providers).toHaveLength(4);
    for (const platform of ["facebook", "instagram", "linkedin", "youtube"]) {
      const provider = res.body.providers.find((p: { platform: string }) => p.platform === platform);
      expect(provider).toMatchObject({
        platform,
        configured: true,
        implemented: true,
        missingConfiguration: [],
        callbackUrl: `https://socialflow.test/api/connections/${platform}/callback`,
      });
    }
    const body = JSON.stringify(res.body);
    for (const secret of ["test-app-secret", "test-ig-app-secret", "test-linkedin-secret", "test-google-secret"]) {
      expect(body).not.toContain(secret);
    }
  });

  it("requires sign-in to start a connection, list, verify or disconnect", async () => {
    const anon = request.agent(app);
    const start = await anon.get("/api/connections/facebook/start");
    expect(start.status).toBe(302);
    expect(start.headers.location as string).toMatch(/^\/signin\?next=/);

    expect((await anon.get("/api/connections")).status).toBe(401);
    expect((await anon.post("/api/connections/00000000-0000-0000-0000-000000000000/verify")).status).toBe(401);
    expect((await anon.delete("/api/connections/00000000-0000-0000-0000-000000000000")).status).toBe(401);
  });

  it("resumes the connect flow's exact start URL, including query params, in the sign-in redirect", async () => {
    const anon = request.agent(app);
    const start = await anon.get("/api/connections/facebook/start?reconnect=abc");
    const location = start.headers.location as string;
    const next = new URL(location, "https://x").searchParams.get("next");
    expect(next).toBe("/api/connections/facebook/start?reconnect=abc");
  });

  it("runs connect → select → list → verify → disconnect, storing tokens encrypted", async () => {
    const agent = await newAgent();
    const { fetchMock } = installFakeGraph();
    const { state, dialog } = await startFlow(agent);
    expect(dialog.searchParams.get("redirect_uri")).toBe("https://socialflow.test/api/connections/facebook/callback");

    const callback = await agent.get(`/api/connections/facebook/callback?code=CODE&state=${state}`);
    const pendingId = redirectParams(callback).get("pending");
    expect(pendingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fetchMock).toHaveBeenCalled();

    const pending = await agent.get(`/api/connections/pending/${pendingId}`);
    expect(pending.status).toBe(200);
    expect(pending.body.candidates.map((c: { displayName: string; selectable: boolean }) => [c.displayName, c.selectable])).toEqual([
      ["Acme Bakery", true],
      ["Acme Fans", false],
    ]);
    expect(JSON.stringify(pending.body)).not.toContain("PAGE_TOKEN");

    // Accounts the user can't publish to are rejected.
    const bad = await agent.post(`/api/connections/pending/${pendingId}/complete`).send({ externalAccountIds: ["1002"] });
    expect(bad.status).toBe(400);

    const complete = await agent.post(`/api/connections/pending/${pendingId}/complete`).send({ externalAccountIds: ["1001"] });
    expect(complete.status).toBe(200);
    const account = complete.body.accounts[0];
    expect(account).toMatchObject({ platform: "facebook", displayName: "Acme Bakery", status: "active", missingScopes: [] });

    // The pending selection is single use.
    expect((await agent.get(`/api/connections/pending/${pendingId}`)).status).toBe(404);

    const list = await agent.get("/api/connections");
    expect(list.body.accounts).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/PAGE_TOKEN|access_token|Encrypted/i);

    const [row] = await db.select().from(connectedAccountsTable).where(eq(connectedAccountsTable.id, account.id));
    expect(row!.accessTokenEncrypted).toMatch(/^v1\./);
    expect(row!.accessTokenEncrypted).not.toContain("PAGE_TOKEN_1001");
    expect(row!.authorizedByExternalUserId).toBe("fb-user-42");

    const verify = await agent.post(`/api/connections/${account.id}/verify`);
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe("active");
    expect(verify.body.lastVerifiedAt).not.toBeNull();

    expect((await agent.delete(`/api/connections/${account.id}`)).status).toBe(204);
    expect((await agent.get("/api/connections")).body.accounts).toHaveLength(0);
  });

  it("supports multiple Pages in one workspace", async () => {
    const agent = await newAgent();
    installFakeGraph({
      pages: [
        { id: "2001", name: "Page A", access_token: "T_A", tasks: ["CREATE_CONTENT"] },
        { id: "2002", name: "Page B", access_token: "T_B", tasks: ["CREATE_CONTENT"] },
      ],
    });
    const { state } = await startFlow(agent);
    const pendingId = redirectParams(await agent.get(`/api/connections/facebook/callback?code=C&state=${state}`)).get("pending");
    await agent.post(`/api/connections/pending/${pendingId}/complete`).send({ externalAccountIds: ["2001", "2002"] });
    expect((await agent.get("/api/connections")).body.accounts.map((a: { displayName: string }) => a.displayName)).toEqual([
      "Page A",
      "Page B",
    ]);
  });

  it("rejects replayed, unknown and cross-browser state values", async () => {
    const agent = await newAgent();
    installFakeGraph();
    const { state } = await startFlow(agent);

    // A different signed-in browser cannot use this state.
    const other = await newAgent();
    expect(redirectParams(await other.get(`/api/connections/facebook/callback?code=C&state=${state}`)).get("connection_error")).toBe(
      "invalid_state",
    );
    // The failed attempt consumed the state, so the original browser can't reuse it either.
    expect(redirectParams(await agent.get(`/api/connections/facebook/callback?code=C&state=${state}`)).get("connection_error")).toBe(
      "invalid_state",
    );
    expect(redirectParams(await agent.get(`/api/connections/facebook/callback?code=C&state=made-up`)).get("connection_error")).toBe(
      "invalid_state",
    );
  });

  it("handles the user cancelling the dialog", async () => {
    const agent = await newAgent();
    const { state } = await startFlow(agent);
    const res = await agent.get(
      `/api/connections/facebook/callback?error=access_denied&error_reason=user_denied&error_description=Permissions+error&state=${state}`,
    );
    expect(redirectParams(res).get("connection_error")).toBe("access_denied");
  });

  it("reports declined required permissions", async () => {
    const agent = await newAgent();
    installFakeGraph({ granted: ["pages_show_list"], declined: ["pages_manage_posts", "pages_read_engagement"] });
    const { state } = await startFlow(agent);
    const params = redirectParams(await agent.get(`/api/connections/facebook/callback?code=C&state=${state}`));
    expect(params.get("connection_error")).toBe("missing_scopes");
    expect(params.get("missing")?.split(",").sort()).toEqual(["pages_manage_posts", "pages_read_engagement"]);
  });

  it("marks revoked accounts on verify and restores them via reconnect", async () => {
    const agent = await newAgent();
    const account = await connectFirstPage(agent);

    installFakeGraph({ debugToken: { is_valid: false, error: { code: 190, subcode: 460, message: "Password changed" } } });
    const verify = await agent.post(`/api/connections/${account.id}/verify`);
    expect(verify.body.status).toBe("revoked");

    installFakeGraph();
    const { dialog, state } = await startFlow(agent, `?reconnect=${account.id}`);
    expect(dialog.searchParams.get("auth_type")).toBe("rerequest");
    const params = redirectParams(await agent.get(`/api/connections/facebook/callback?code=C&state=${state}`));
    expect(params.get("reconnected")).toBe("1");

    const accounts = (await agent.get("/api/connections")).body.accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: account.id, status: "active" });
  });

  it("fails reconnect if the user didn't grant access to that Page again", async () => {
    const agent = await newAgent();
    const account = await connectFirstPage(agent);
    installFakeGraph({ pages: [{ id: "9999", name: "Other", access_token: "T", tasks: ["CREATE_CONTENT"] }] });
    const { state } = await startFlow(agent, `?reconnect=${account.id}`);
    expect(redirectParams(await agent.get(`/api/connections/facebook/callback?code=C&state=${state}`)).get("connection_error")).toBe(
      "account_not_granted",
    );
  });

  it("isolates workspaces between different users", async () => {
    const owner = await newAgent();
    const account = await connectFirstPage(owner);
    const intruder = await newAgent();
    expect((await intruder.get("/api/connections")).body.accounts).toHaveLength(0);
    expect((await intruder.post(`/api/connections/${account.id}/verify`)).status).toBe(404);
    expect((await intruder.delete(`/api/connections/${account.id}`)).status).toBe(404);
    expect((await owner.get("/api/connections")).body.accounts).toHaveLength(1);
  });

  it("refuses to start when credentials are missing instead of faking a connection", async () => {
    vi.stubEnv("FACEBOOK_APP_SECRET", "");
    try {
      const agent = await newAgent();
      const res = await agent.get("/api/connections/facebook/start");
      expect(redirectParams(res).get("connection_error")).toBe("not_configured");
      const providers = await request(app).get("/api/connections/providers");
      const facebook = providers.body.providers.find((p: { platform: string }) => p.platform === "facebook");
      expect(facebook.configured).toBe(false);
      expect(facebook.missingConfiguration).toContain("FACEBOOK_APP_SECRET");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns not_configured for a platform missing its credentials, never a fake connection", async () => {
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", "");
    try {
      const agent = await newAgent();
      const res = await agent.get("/api/connections/linkedin/start");
      expect(redirectParams(res).get("connection_error")).toBe("not_configured");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
