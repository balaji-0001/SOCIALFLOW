import { signedCookie } from "cookie-parser";
import { eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  connectedAccountsTable,
  db,
  sessionsTable,
  workspacesTable,
} from "@workspace/db";
import app from "../app";
import { sha256 } from "../lib/crypto";
import { installFakeGraph } from "../test/fake-graph";

// End-to-end test of the OAuth routes against the real database, with only
// the Facebook Graph API faked. Skipped until the schema has been pushed
// (`pnpm --filter @workspace/db run push`).
const tablesExist = await db
  .execute(sql`select to_regclass('public.socialflow_connected_accounts') as t`)
  .then((r) => Boolean((r.rows[0] as { t: string | null }).t))
  .catch(() => false);

type Agent = ReturnType<typeof request.agent>;
const sessionTokens = new Set<string>();

function newAgent(): Agent {
  const agent = request.agent(app);
  // Remember every session this test creates so afterAll can clean them up.
  agent.on("response", (res: { headers: Record<string, string[] | undefined> }) => {
    for (const header of res.headers["set-cookie"] ?? []) {
      const match = /^sf_session=([^;]+)/.exec(header);
      const raw = match ? signedCookie(decodeURIComponent(match[1]!), process.env.SESSION_SECRET!) : false;
      if (raw) sessionTokens.add(raw);
    }
  });
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
    // Remove every workspace created by this test's sessions (cascades).
    const tokenHashes = [...sessionTokens].map(sha256);
    if (tokenHashes.length > 0) {
      const sessions = await db.select().from(sessionsTable).where(inArray(sessionsTable.tokenHash, tokenHashes));
      const ids = sessions.map((s) => s.workspaceId);
      if (ids.length > 0) await db.delete(workspacesTable).where(inArray(workspacesTable.id, ids));
    }
  });

  it("reports Facebook as configured and the others as not implemented", async () => {
    const res = await request(app).get("/api/connections/providers");
    expect(res.status).toBe(200);
    const facebook = res.body.providers.find((p: { platform: string }) => p.platform === "facebook");
    expect(facebook).toMatchObject({
      configured: true,
      implemented: true,
      missingConfiguration: [],
      callbackUrl: "https://socialflow.test/api/connections/facebook/callback",
    });
    expect(res.body.providers.filter((p: { implemented: boolean }) => !p.implemented)).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toContain("test-app-secret");
  });

  it("runs connect → select → list → verify → disconnect, storing tokens encrypted", async () => {
    const agent = newAgent();
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
    const agent = newAgent();
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
    const agent = newAgent();
    installFakeGraph();
    const { state } = await startFlow(agent);

    // A different browser (no session cookie) cannot use this state.
    const other = newAgent();
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
    const agent = newAgent();
    const { state } = await startFlow(agent);
    const res = await agent.get(
      `/api/connections/facebook/callback?error=access_denied&error_reason=user_denied&error_description=Permissions+error&state=${state}`,
    );
    expect(redirectParams(res).get("connection_error")).toBe("access_denied");
  });

  it("reports declined required permissions", async () => {
    const agent = newAgent();
    installFakeGraph({ granted: ["pages_show_list"], declined: ["pages_manage_posts", "pages_read_engagement"] });
    const { state } = await startFlow(agent);
    const params = redirectParams(await agent.get(`/api/connections/facebook/callback?code=C&state=${state}`));
    expect(params.get("connection_error")).toBe("missing_scopes");
    expect(params.get("missing")?.split(",").sort()).toEqual(["pages_manage_posts", "pages_read_engagement"]);
  });

  it("marks revoked accounts on verify and restores them via reconnect", async () => {
    const agent = newAgent();
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
    const agent = newAgent();
    const account = await connectFirstPage(agent);
    installFakeGraph({ pages: [{ id: "9999", name: "Other", access_token: "T", tasks: ["CREATE_CONTENT"] }] });
    const { state } = await startFlow(agent, `?reconnect=${account.id}`);
    expect(redirectParams(await agent.get(`/api/connections/facebook/callback?code=C&state=${state}`)).get("connection_error")).toBe(
      "account_not_granted",
    );
  });

  it("isolates workspaces", async () => {
    const owner = newAgent();
    const account = await connectFirstPage(owner);
    const intruder = newAgent();
    await intruder.get("/api/connections/facebook/start"); // gets its own workspace
    expect((await intruder.get("/api/connections")).body.accounts).toHaveLength(0);
    expect((await intruder.post(`/api/connections/${account.id}/verify`)).status).toBe(404);
    expect((await intruder.delete(`/api/connections/${account.id}`)).status).toBe(404);
    expect((await owner.get("/api/connections")).body.accounts).toHaveLength(1);
  });

  it("refuses to start when credentials are missing instead of faking a connection", async () => {
    vi.stubEnv("FACEBOOK_APP_SECRET", "");
    try {
      const res = await newAgent().get("/api/connections/facebook/start");
      expect(redirectParams(res).get("connection_error")).toBe("not_configured");
      const providers = await request(app).get("/api/connections/providers");
      const facebook = providers.body.providers.find((p: { platform: string }) => p.platform === "facebook");
      expect(facebook.configured).toBe(false);
      expect(facebook.missingConfiguration).toContain("FACEBOOK_APP_SECRET");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns not_configured for platforms that aren't implemented yet", async () => {
    const res = await newAgent().get("/api/connections/linkedin/start");
    expect(redirectParams(res).get("connection_error")).toBe("not_configured");
  });
});
