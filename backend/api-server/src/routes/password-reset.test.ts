import { inArray, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, passwordResetsTable, tableExists, usersTable, workspacesTable } from "@workspace/db";

// Email is captured instead of sent.
const sent: Array<{ to: string; subject: string; text: string }> = [];
const mail = vi.hoisted(() => ({ mode: "smtp" as "smtp" | "off", fail: false }));
vi.mock("../lib/mail", () => ({
  mailMode: () => mail.mode,
  sendMail: async (message: { to: string; subject: string; text: string }) => {
    if (mail.fail) throw new Error("SMTP down");
    sent.push(message);
  },
}));

const { default: app } = await import("../app");

const tablesExist = await tableExists("socialflow_password_resets").catch(() => false);

const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
const OLD = "correct horse battery staple";
const NEW = "a brand new passphrase";

async function newAccount() {
  const agent = request.agent(app);
  const email = `reset-test-${Date.now()}-${Math.random().toString(36).slice(2)}@socialflow.test`;
  const res = await agent.post("/api/auth/signup").send({ email, password: OLD });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return { agent, email, userId: res.body.user.id as string };
}

const tokenFrom = (text: string) => /reset-password\?token=([A-Za-z0-9_-]+)/.exec(text)![1]!;

describe.skipIf(!tablesExist)("Password reset (database)", () => {
  beforeEach(() => { sent.length = 0; mail.mode = "smtp"; mail.fail = false; });
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("emails a one-time link, resets the password, signs out old sessions, and burns the link", async () => {
    const { agent, email } = await newAccount();
    const asked = await request(app).post("/api/auth/forgot-password").send({ email: email.toUpperCase() });
    expect(asked.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);
    expect(sent[0]!.text).toContain("https://socialflow.test/reset-password?token=");
    const token = tokenFrom(sent[0]!.text);

    // Only the hash is stored.
    const rows = await db.select().from(passwordResetsTable);
    expect(JSON.stringify(rows)).not.toContain(token);

    expect((await agent.get("/api/auth/me")).status).toBe(200);
    const reset = await request(app).post("/api/auth/reset-password").send({ token, password: NEW });
    expect(reset.status).toBe(200);
    expect((await agent.get("/api/auth/me")).status).toBe(401); // the old session is gone

    expect((await request(app).post("/api/auth/login").send({ email, password: OLD })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email, password: NEW })).status).toBe(200);
    // The link can't be used again.
    const again = await request(app).post("/api/auth/reset-password").send({ token, password: "yet another passphrase" });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_token");
  });

  it("answers the same for unknown emails and sends nothing", async () => {
    const known = await newAccount();
    const a = await request(app).post("/api/auth/forgot-password").send({ email: known.email });
    const b = await request(app).post("/api/auth/forgot-password").send({ email: "nobody-here@socialflow.test" });
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(sent).toHaveLength(1);
  });

  it("rejects bad emails, weak passwords and made-up or expired tokens", async () => {
    expect((await request(app).post("/api/auth/forgot-password").send({ email: "nope" })).status).toBe(400);
    const { email, userId } = await newAccount();
    await request(app).post("/api/auth/forgot-password").send({ email });
    const token = tokenFrom(sent[0]!.text);
    expect((await request(app).post("/api/auth/reset-password").send({ token, password: "short" })).body.error).toBe("weak_password");
    expect((await request(app).post("/api/auth/reset-password").send({ token: "x".repeat(43), password: NEW })).body.error).toBe("invalid_token");
    expect((await request(app).post("/api/auth/reset-password").send({ password: NEW })).body.error).toBe("invalid_token");
    // Expire it.
    await db.execute(sql`update socialflow_password_resets set expires_at = now(3) - interval 1 minute where user_id = ${userId}`);
    expect((await request(app).post("/api/auth/reset-password").send({ token, password: NEW })).body.error).toBe("invalid_token");
    expect((await request(app).post("/api/auth/login").send({ email, password: OLD })).status).toBe(200); // unchanged
  });

  it("limits how often one account can be emailed, and a newer link replaces the older one", async () => {
    const { email, userId } = await newAccount();
    await request(app).post("/api/auth/forgot-password").send({ email });
    await request(app).post("/api/auth/forgot-password").send({ email });
    expect(sent).toHaveLength(1); // second request within a minute is quietly ignored
    await db.execute(sql`update socialflow_password_resets set created_at = now(3) - interval 2 minute where user_id = ${userId}`);
    await request(app).post("/api/auth/forgot-password").send({ email });
    expect(sent).toHaveLength(2);
    const [first, second] = [tokenFrom(sent[0]!.text), tokenFrom(sent[1]!.text)];
    expect((await request(app).post("/api/auth/reset-password").send({ token: first, password: NEW })).status).toBe(400);
    expect((await request(app).post("/api/auth/reset-password").send({ token: second, password: NEW })).status).toBe(200);
  });

  it("says so when email isn't configured, and cleans up when sending fails", async () => {
    const { email, userId } = await newAccount();
    mail.mode = "off";
    const off = await request(app).post("/api/auth/forgot-password").send({ email });
    expect(off.status).toBe(503);
    expect(off.body.error).toBe("email_not_configured");
    mail.mode = "smtp";
    mail.fail = true;
    const failed = await request(app).post("/api/auth/forgot-password").send({ email });
    expect(failed.status).toBe(503); // not 502: a proxy in front may replace a 502 answer and lose the message
    expect(failed.body.error).toBe("email_failed");
    expect(failed.body.message).toMatch(/couldn't send the email/);
    const left = await db.select().from(passwordResetsTable).where(sql`${passwordResetsTable.userId} = ${userId}`);
    expect(left).toHaveLength(0);
  });
});
