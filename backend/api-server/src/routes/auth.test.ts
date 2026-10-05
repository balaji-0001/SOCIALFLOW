import { inArray } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, tableExists, usersTable, workspacesTable } from "@workspace/db";
import app from "../app";

const tablesExist = await tableExists("socialflow_users").catch(() => false);

const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();

function uniqueEmail(): string {
  return `auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}@socialflow.test`;
}

describe.skipIf(!tablesExist)("Authentication routes (database)", () => {
  beforeAll(() => {
    expect(process.env.NODE_ENV).toBe("test");
  });

  afterAll(async () => {
    if (createdWorkspaceIds.size > 0) {
      await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    }
    if (createdUserIds.size > 0) {
      await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
    }
  });

  it("signs up, returns a session cookie, and reports the new user via /auth/me", async () => {
    const agent = request.agent(app);
    const email = uniqueEmail();
    const signup = await agent.post("/api/auth/signup").send({ email, password: "correct horse battery staple", displayName: "Ada" });
    expect(signup.status).toBe(201);
    expect(signup.body.user).toMatchObject({ email, displayName: "Ada" });
    expect(signup.body.user.id).toBeTruthy();
    expect(signup.body.workspace.id).toBeTruthy();
    expect(JSON.stringify(signup.body)).not.toMatch(/password/i);
    createdUserIds.add(signup.body.user.id);
    createdWorkspaceIds.add(signup.body.workspace.id);

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.workspaceId).toBe(signup.body.workspace.id);
  });

  it("rejects a weak password and an invalid email", async () => {
    const shortPassword = await request(app).post("/api/auth/signup").send({ email: uniqueEmail(), password: "short" });
    expect(shortPassword.status).toBe(400);
    expect(shortPassword.body.error).toBe("weak_password");

    const badEmail = await request(app).post("/api/auth/signup").send({ email: "not-an-email", password: "correct horse battery staple" });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.error).toBe("invalid_email");
  });

  it("rejects signing up twice with the same email (case-insensitively)", async () => {
    const email = uniqueEmail();
    const first = await request(app).post("/api/auth/signup").send({ email, password: "correct horse battery staple" });
    expect(first.status).toBe(201);
    createdUserIds.add(first.body.user.id);
    createdWorkspaceIds.add(first.body.workspace.id);

    const second = await request(app).post("/api/auth/signup").send({ email: email.toUpperCase(), password: "another strong password" });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("email_taken");
  });

  it("logs in with correct credentials and rejects wrong ones", async () => {
    const email = uniqueEmail();
    const signup = await request(app).post("/api/auth/signup").send({ email, password: "correct horse battery staple" });
    createdUserIds.add(signup.body.user.id);
    createdWorkspaceIds.add(signup.body.workspace.id);

    const wrongPassword = await request(app).post("/api/auth/login").send({ email, password: "totally wrong password" });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.error).toBe("invalid_credentials");

    const unknownEmail = await request(app).post("/api/auth/login").send({ email: uniqueEmail(), password: "correct horse battery staple" });
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body.error).toBe("invalid_credentials");

    const agent = request.agent(app);
    const ok = await agent.post("/api/auth/login").send({ email, password: "correct horse battery staple" });
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe(email);

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
  });

  it("logs out and invalidates the session", async () => {
    const agent = request.agent(app);
    const email = uniqueEmail();
    const signup = await agent.post("/api/auth/signup").send({ email, password: "correct horse battery staple" });
    createdUserIds.add(signup.body.user.id);
    createdWorkspaceIds.add(signup.body.workspace.id);

    expect((await agent.post("/api/auth/logout")).status).toBe(204);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("reports unauthorized for /auth/me without a session", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });
});
