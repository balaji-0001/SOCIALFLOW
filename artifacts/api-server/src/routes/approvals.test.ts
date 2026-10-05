import cookieParser from "cookie-parser";
import { inArray, sql } from "drizzle-orm";
import express from "express";
import pinoHttp from "pino-http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, pool, postsTable, tableExists, usersTable, workspacesTable } from "@workspace/db";

// Approvals workflow. Self-contained: applies its own migration and mounts the routers it needs on a small app, and adds
// the approvals:* permissions in memory when the integrator hasn't added them to lib/permissions.ts yet.

// Until lib/db/src/schema/index.ts re-exports ./approvals, splice the tables into @workspace/db for the code under test.
vi.mock("@workspace/db", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...(await import("../../../../lib/db/src/schema/approvals")) }));

const sent: Array<{ to: string; subject: string; text: string }> = [];
vi.mock("../lib/mail", () => ({
  mailMode: () => "smtp",
  sendMail: async (message: { to: string; subject: string; text: string }) => {
    if ((globalThis as { __failMail?: boolean }).__failMail) throw new Error("smtp down");
    sent.push(message);
  },
}));

const { ROLE_PERMISSIONS } = await import("../lib/permissions");
const grants: Record<string, string[]> = {
  owner: ["approvals:read", "approvals:request", "approvals:decide", "approvals:manage"],
  admin: ["approvals:read", "approvals:request", "approvals:decide", "approvals:manage"],
  editor: ["approvals:read", "approvals:request"],
  approver: ["approvals:read", "approvals:decide"],
  viewer: ["approvals:read"],
};
for (const [role, perms] of Object.entries(grants)) {
  const list = (ROLE_PERMISSIONS as Record<string, string[]>)[role]!;
  // owner and admin may share one array; only push what is missing.
  for (const p of perms) if (!list.includes(p)) list.push(p);
}

const { default: authRouter } = await import("./auth");
const { default: teamRouter } = await import("./team");
const { default: approvalsRouter } = await import("./approvals");
const { isPublishBlockedByApproval, resetApprovalOnEdit } = await import("../lib/approvals");

const app = express();
app.use(pinoHttp({ logger: (await import("../lib/logger")).logger }));
app.use(cookieParser(process.env.SESSION_SECRET));
app.use(express.json());
app.use("/api", authRouter, teamRouter, approvalsRouter);

const baseTablesExist = await tableExists("socialflow_invitations").catch(() => false);

type Agent = ReturnType<typeof request.agent>;
const userIds = new Set<string>();
const workspaceIds = new Set<string>();
let counter = 0;
const PASSWORD = "correct horse battery staple";

async function signup() {
  const agent = request.agent(app);
  const email = `appr-test-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2)}@socialflow.test`;
  const res = await agent.post("/api/auth/signup").send({ email, password: PASSWORD, displayName: "Tester" });
  expect(res.status).toBe(201);
  userIds.add(res.body.user.id);
  workspaceIds.add(res.body.workspace.id);
  return { agent, email, userId: res.body.user.id as string, workspaceId: res.body.workspace.id as string };
}
async function addMember(owner: Awaited<ReturnType<typeof signup>>, role: string) {
  const member = await signup();
  const invite = await owner.agent.post("/api/team/invitations").send({ email: member.email, role });
  expect(invite.status).toBe(201);
  const token = /token=([A-Za-z0-9_-]+)/.exec(invite.body.inviteUrl)![1]!;
  expect((await member.agent.post(`/api/invitations/${token}/accept`)).status).toBe(200);
  return member as { agent: Agent; email: string; userId: string; workspaceId: string };
}
async function newPost(workspaceId: string, userId: string, status: "draft" | "scheduled" | "published" = "draft") {
  const [post] = await db.insert(postsTable).values({ workspaceId, createdByUserId: userId, content: "hello", status, scheduledAt: status === "scheduled" ? new Date(Date.now() + 3600_000) : null }).returning();
  return post!.id;
}

beforeAll(async () => {
  if (!baseTablesExist) return;
});
afterAll(async () => {
  if (workspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...workspaceIds]));
  if (userIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...userIds]));
});

describe.skipIf(!baseTablesExist)("Approvals (database)", () => {
  it("settings are owner/admin only and default to not required", async () => {
    const owner = await signup();
    const editor = await addMember(owner, "editor");
    expect((await owner.agent.get("/api/approvals/settings")).body.required).toBe(false);
    expect((await editor.agent.put("/api/approvals/settings").send({ required: true })).status).toBe(403);
    expect((await owner.agent.put("/api/approvals/settings").send({ required: "yes" })).status).toBe(400);
    const res = await owner.agent.put("/api/approvals/settings").send({ required: true });
    expect(res.status).toBe(200);
    expect(res.body.required).toBe(true);
  });

  it("blocks publishing until approved, and editing resets an approval", async () => {
    const owner = await signup();
    const editor = await addMember(owner, "editor");
    const approver = await addMember(owner, "approver");
    const postId = await newPost(owner.workspaceId, editor.userId, "scheduled");

    expect(await isPublishBlockedByApproval(postId)).toBe(false);
    await owner.agent.put("/api/approvals/settings").send({ required: true });
    expect(await isPublishBlockedByApproval(postId)).toBe(true);

    const requested = await editor.agent.post(`/api/posts/${postId}/approval`).send({ note: "please check" });
    expect(requested.status).toBe(201);
    expect(requested.body.status).toBe("pending");
    expect((await editor.agent.post(`/api/posts/${postId}/approval`).send({})).status).toBe(409);
    expect(await isPublishBlockedByApproval(postId)).toBe(true);

    expect((await editor.agent.post(`/api/approvals/${requested.body.id}/approve`).send({})).status).toBe(403);
    const approved = await approver.agent.post(`/api/approvals/${requested.body.id}/approve`).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    expect(await isPublishBlockedByApproval(postId)).toBe(false);
    expect(sent.some((m) => m.to === editor.email)).toBe(true);
    expect((await approver.agent.post(`/api/approvals/${requested.body.id}/approve`).send({})).status).toBe(409);

    expect(await resetApprovalOnEdit(postId)).toBe(true);
    expect(await isPublishBlockedByApproval(postId)).toBe(true);
    expect(await resetApprovalOnEdit(postId)).toBe(false);
  });

  it("requester cannot approve their own request even as admin; another admin can", async () => {
    const owner = await signup();
    const admin = await addMember(owner, "admin");
    const postId = await newPost(owner.workspaceId, admin.userId);
    const requested = await admin.agent.post(`/api/posts/${postId}/approval`).send({});
    expect(requested.status).toBe(201);
    const own = await admin.agent.post(`/api/approvals/${requested.body.id}/approve`).send({});
    expect(own.status).toBe(403);
    expect(own.body.error).toBe("own_request");
    expect((await owner.agent.post(`/api/approvals/${requested.body.id}/approve`).send({})).status).toBe(200);
  });

  it("reject and request-changes need a note, then the requester can ask again", async () => {
    const owner = await signup();
    const editor = await addMember(owner, "editor");
    const postId = await newPost(owner.workspaceId, editor.userId);
    const a = (await editor.agent.post(`/api/posts/${postId}/approval`).send({})).body;
    expect((await owner.agent.post(`/api/approvals/${a.id}/reject`).send({})).status).toBe(400);
    const changes = await owner.agent.post(`/api/approvals/${a.id}/request-changes`).send({ note: "fix the link" });
    expect(changes.body.status).toBe("changes_requested");
    expect(changes.body.note).toBe("fix the link");
    const again = await editor.agent.post(`/api/posts/${postId}/approval`).send({});
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(a.id);
    expect(again.body.status).toBe("pending");
    expect((await owner.agent.post(`/api/approvals/${a.id}/reject`).send({ note: "no" })).body.status).toBe("rejected");
  });

  it("only draft or scheduled posts can be sent for approval; other workspaces' posts are not found", async () => {
    const owner = await signup();
    const other = await signup();
    const published = await newPost(owner.workspaceId, owner.userId, "published");
    expect((await owner.agent.post(`/api/posts/${published}/approval`).send({})).status).toBe(409);
    const foreign = await newPost(other.workspaceId, other.userId);
    expect((await owner.agent.post(`/api/posts/${foreign}/approval`).send({})).status).toBe(404);
    expect((await owner.agent.post("/api/posts/not-a-uuid/approval").send({})).status).toBe(404);
  });

  it("list scopes: approvers see the queue, editors only their own; status filter works", async () => {
    const owner = await signup();
    const e1 = await addMember(owner, "editor");
    const e2 = await addMember(owner, "editor");
    const approver = await addMember(owner, "approver");
    await e1.agent.post(`/api/posts/${await newPost(owner.workspaceId, e1.userId)}/approval`).send({});
    await e2.agent.post(`/api/posts/${await newPost(owner.workspaceId, e2.userId)}/approval`).send({});
    const queue = await approver.agent.get("/api/approvals?status=pending");
    expect(queue.body.scope).toBe("queue");
    expect(queue.body.approvals).toHaveLength(2);
    const own = await e1.agent.get("/api/approvals");
    expect(own.body.scope).toBe("own");
    expect(own.body.approvals).toHaveLength(1);
    expect((await approver.agent.get("/api/approvals?status=approved")).body.approvals).toHaveLength(0);
    expect((await approver.agent.get("/api/approvals?status=bogus")).status).toBe(400);
    const theirs = queue.body.approvals.find((x: { requestedBy: string }) => x.requestedBy === e1.userId);
    expect((await e2.agent.get(`/api/approvals/${theirs.id}`)).status).toBe(404);
  });

  it("comments and withdraw", async () => {
    const owner = await signup();
    const editor = await addMember(owner, "editor");
    const postId = await newPost(owner.workspaceId, editor.userId);
    const a = (await editor.agent.post(`/api/posts/${postId}/approval`).send({})).body;
    expect((await editor.agent.post(`/api/approvals/${a.id}/comments`).send({ body: "  " })).status).toBe(400);
    expect((await owner.agent.post(`/api/approvals/${a.id}/comments`).send({ body: "Looks good" })).status).toBe(201);
    const detail = await editor.agent.get(`/api/approvals/${a.id}`);
    expect(detail.body.comments).toHaveLength(1);
    expect(detail.body.comments[0].body).toBe("Looks good");
    const withdrawn = await editor.agent.post(`/api/approvals/${a.id}/withdraw`).send({});
    expect(withdrawn.body.status).toBe("withdrawn");
    expect((await owner.agent.post(`/api/approvals/${a.id}/approve`).send({})).status).toBe(409);
  });

  it("emails approvers (not the requester) on a new request, and mail failure does not fail it", async () => {
    vi.stubEnv("OAUTH_REDIRECT_BASE_URL", "http://localhost:5000");
    const owner = await signup();
    const admin = await addMember(owner, "admin");
    const approver = await addMember(owner, "approver");
    const editor = await addMember(owner, "editor");
    const viewer = await addMember(owner, "viewer");
    const postId = await newPost(owner.workspaceId, editor.userId);
    sent.length = 0;
    const res = await editor.agent.post(`/api/posts/${postId}/approval`).send({ note: "check pls" });
    expect(res.status).toBe(201);
    const to = sent.map((m) => m.to).sort();
    expect(to).toEqual([owner.email, admin.email, approver.email].sort());
    expect(to).not.toContain(editor.email);
    expect(to).not.toContain(viewer.email);
    expect(sent[0]!.subject).toBe("Approval needed: hello");
    expect(sent[0]!.text).toContain("check pls");
    expect(sent[0]!.text).toContain("http://localhost:5000/approvals");

    // Requester who can also decide is excluded; a failing transport doesn't fail a re-request.
    await owner.agent.post(`/api/approvals/${res.body.id}/request-changes`).send({ note: "redo" });
    (globalThis as { __failMail?: boolean }).__failMail = true;
    try {
      sent.length = 0;
      const again = await editor.agent.post(`/api/posts/${postId}/approval`).send({});
      expect(again.status).toBe(201);
      expect(sent).toHaveLength(0);
    } finally {
      (globalThis as { __failMail?: boolean }).__failMail = false;
      vi.unstubAllEnvs();
    }
  });

  it("requires sign-in", async () => {
    expect((await request(app).get("/api/approvals")).status).toBe(401);
  });
});
