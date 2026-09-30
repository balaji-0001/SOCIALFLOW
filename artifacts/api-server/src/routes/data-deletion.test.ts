import { createHmac } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedAccountsTable, dataDeletionsTable, db, usersTable, workspacesTable } from "@workspace/db";
import app from "../app";
import { verifySignedRequest } from "../lib/meta-signed-request";
import { saveConnectedAccount } from "../lib/oauth/accounts";

// Meta's data deletion callback. Requests are signed with the app secret exactly as Meta signs them.

const b64url = (buffer: Buffer | string) => Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function sign(payload: Record<string, unknown>, secret: string): string {
  const body = b64url(JSON.stringify({ algorithm: "HMAC-SHA256", issued_at: 1_700_000_000, ...payload }));
  return `${b64url(createHmac("sha256", secret).update(body).digest())}.${body}`;
}

beforeEach(() => {
  vi.stubEnv("FACEBOOK_APP_SECRET", "fb-secret-for-tests");
  vi.stubEnv("INSTAGRAM_APP_SECRET", "ig-secret-for-tests");
  vi.stubEnv("OAUTH_REDIRECT_BASE_URL", "https://socialflow.test");
});
afterEach(() => vi.unstubAllEnvs());

describe("verifySignedRequest", () => {
  it("accepts a correctly signed request and reads the user id", () => {
    expect(verifySignedRequest(sign({ user_id: "123" }, "s3cret"), "s3cret")).toMatchObject({ user_id: "123" });
  });
  it("refuses a wrong secret, a tampered payload, a wrong algorithm and junk", () => {
    const good = sign({ user_id: "123" }, "s3cret");
    expect(verifySignedRequest(good, "other")).toBeNull();
    const [sig] = good.split(".");
    expect(verifySignedRequest(`${sig}.${b64url(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "999" }))}`, "s3cret")).toBeNull();
    expect(verifySignedRequest(sign({ user_id: "1", algorithm: "HMAC-SHA1" }, "s3cret"), "s3cret")).toBeNull();
    for (const junk of [undefined, null, 5, "", "abc", "a.b.c", ".", `${sig}.`]) expect(verifySignedRequest(junk, "s3cret")).toBeNull();
    expect(verifySignedRequest(good, "")).toBeNull();
  });
});

const tablesExist = await db.execute(sql`select to_regclass('public.socialflow_data_deletions') as t`).then((r) => Boolean((r.rows[0] as { t: string | null }).t)).catch(() => false);
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
const createdCodes = new Set<string>();

async function workspace() {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email: `deletion-${Date.now()}-${Math.random().toString(36).slice(2)}@socialflow.test`, password: "correct horse battery staple" });
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return res.body.workspace.id as string;
}
const connect = (workspaceId: string, platform: "facebook" | "instagram", externalId: string, authorizedBy: string) =>
  saveConnectedAccount(db, workspaceId, platform, {
    externalAccountId: externalId, accountType: platform === "facebook" ? "facebook_page" : "instagram_business", displayName: `Acct ${externalId}`, username: null, avatarUrl: null,
    accessToken: `TOKEN_${externalId}`, refreshToken: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: [], metadata: {}, selectable: true, warnings: [],
  }, authorizedBy);

describe.skipIf(!tablesExist)("POST /api/data-deletion/meta (database, test DB only)", () => {
  afterAll(async () => {
    if (createdCodes.size) await db.delete(dataDeletionsTable).where(inArray(dataDeletionsTable.confirmationCode, [...createdCodes]));
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("deletes only the accounts that Facebook user authorised, and returns a confirmation link and code", async () => {
    const ws = await workspace();
    const other = await workspace();
    const mine = await connect(ws, "facebook", "page-1", "fb-user-A");
    const alsoMine = await connect(other, "facebook", "page-2", "fb-user-A");
    const theirs = await connect(ws, "facebook", "page-3", "fb-user-B");
    const instagram = await connect(ws, "instagram", "ig-1", "fb-user-A"); // an Instagram account that happens to share the id string

    const res = await request(app).post("/api/data-deletion/meta").type("form").send({ signed_request: sign({ user_id: "fb-user-A" }, "fb-secret-for-tests") });
    expect(res.status).toBe(200);
    expect(res.body.confirmation_code).toMatch(/^[0-9A-F]{16}$/);
    expect(res.body.url).toBe(`https://socialflow.test/data-deletion?code=${res.body.confirmation_code}`);
    createdCodes.add(res.body.confirmation_code);

    const remaining = (await db.select({ id: connectedAccountsTable.id }).from(connectedAccountsTable).where(inArray(connectedAccountsTable.id, [mine.id, alsoMine.id, theirs.id, instagram.id]))).map((r) => r.id).sort();
    expect(remaining).toEqual([theirs.id, instagram.id].sort()); // both of A's Facebook accounts gone; B's and the Instagram one untouched

    const status = await request(app).get(`/api/data-deletion/status/${res.body.confirmation_code}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ code: res.body.confirmation_code, status: "completed", accountsRemoved: 2 });
    expect(status.body.completedAt).toBeTruthy();
    expect(JSON.stringify(status.body)).not.toContain("fb-user-A"); // the status page never echoes the person's id
  });

  it("uses the Instagram app secret for Instagram requests", async () => {
    const ws = await workspace();
    const account = await connect(ws, "instagram", "ig-9", "ig-user-1");
    const res = await request(app).post("/api/data-deletion/meta").type("form").send({ signed_request: sign({ user_id: "ig-user-1" }, "ig-secret-for-tests") });
    expect(res.status).toBe(200);
    createdCodes.add(res.body.confirmation_code);
    expect(await db.select().from(connectedAccountsTable).where(eq(connectedAccountsTable.id, account.id))).toHaveLength(0);
  });

  it("refuses a request signed with the wrong secret, tampered or missing, and deletes nothing", async () => {
    const ws = await workspace();
    const account = await connect(ws, "facebook", "page-7", "fb-user-Z");
    for (const body of [{ signed_request: sign({ user_id: "fb-user-Z" }, "not-our-secret") }, { signed_request: "garbage" }, {}]) {
      const res = await request(app).post("/api/data-deletion/meta").type("form").send(body);
      expect(res.status).toBe(400);
    }
    expect(await db.select().from(connectedAccountsTable).where(eq(connectedAccountsTable.id, account.id))).toHaveLength(1);
  });

  it("answers a valid request for a person with nothing stored, and status 404 for unknown codes", async () => {
    const res = await request(app).post("/api/data-deletion/meta").type("form").send({ signed_request: sign({ user_id: "nobody" }, "fb-secret-for-tests") });
    expect(res.status).toBe(200);
    createdCodes.add(res.body.confirmation_code);
    expect((await request(app).get(`/api/data-deletion/status/${res.body.confirmation_code}`)).body.accountsRemoved).toBe(0);
    expect((await request(app).get("/api/data-deletion/status/0000000000000000")).status).toBe(404);
    expect((await request(app).get("/api/data-deletion/status/not-a-code")).status).toBe(404);
  });
});
