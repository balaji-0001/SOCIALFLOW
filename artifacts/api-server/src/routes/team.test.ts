import { and, eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, invitationsTable, tableExists, usersTable, workspaceMembersTable, workspacesTable } from "@workspace/db";
import { canManage, grantableRoles, can } from "../lib/permissions";

// Team: roles and permissions, invitations, membership changes, workspace switching, and that access stays isolated.

const sent: Array<{ to: string; subject: string; text: string }> = [];
const mail = vi.hoisted(() => ({ mode: "smtp" as "smtp" | "off" }));
vi.mock("../lib/mail", () => ({
  mailMode: () => mail.mode,
  sendMail: async (message: { to: string; subject: string; text: string }) => { sent.push(message); },
}));

const { default: app } = await import("../app");

const tablesExist = await tableExists("socialflow_invitations").catch(() => false);

type Agent = ReturnType<typeof request.agent>;
const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
let counter = 0;
const PASSWORD = "correct horse battery staple";

async function signup(): Promise<{ agent: Agent; email: string; userId: string; workspaceId: string }> {
  const agent = request.agent(app);
  const email = `team-test-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2)}@socialflow.test`;
  const res = await agent.post("/api/auth/signup").send({ email, password: PASSWORD, displayName: "Tester" });
  expect(res.status).toBe(201);
  createdUserIds.add(res.body.user.id);
  createdWorkspaceIds.add(res.body.workspace.id);
  return { agent, email, userId: res.body.user.id, workspaceId: res.body.workspace.id };
}
const tokenFrom = (text: string) => /accept-invite\?token=([A-Za-z0-9_-]+)/.exec(text)![1]!;

/** Owner invites `email` as `role`; the person signs up and accepts. Returns their agent. */
async function addMember(owner: Awaited<ReturnType<typeof signup>>, role: string) {
  const member = await signup();
  const invite = await owner.agent.post("/api/team/invitations").send({ email: member.email, role });
  expect(invite.status).toBe(201);
  const token = /token=([A-Za-z0-9_-]+)/.exec(invite.body.inviteUrl)![1]!;
  const accepted = await member.agent.post(`/api/invitations/${token}/accept`);
  expect(accepted.status).toBe(200);
  return member;
}

describe("role rules", () => {
  it("defines what each role can do, and who may manage whom", () => {
    expect(can("owner", "team:manage")).toBe(true);
    expect(can("editor", "posts:publish")).toBe(true);
    expect(can("editor", "accounts:manage")).toBe(false);
    expect(can("editor", "team:manage")).toBe(false);
    expect(can("viewer", "posts:write")).toBe(false);
    expect(can("viewer", "analytics:read")).toBe(true);
    expect(can("approver", "posts:write")).toBe(false);
    expect(grantableRoles("owner")).toEqual(["admin", "editor", "approver", "viewer"]);
    expect(grantableRoles("admin")).toEqual(["editor", "approver", "viewer"]);
    expect(grantableRoles("editor")).toEqual([]);
    expect(canManage("owner", "admin")).toBe(true);
    expect(canManage("admin", "admin")).toBe(false);
    expect(canManage("admin", "owner")).toBe(false);
    expect(canManage("owner", "owner")).toBe(false);
  });
});

describe.skipIf(!tablesExist)("Team (database)", () => {
  beforeEach(() => { sent.length = 0; mail.mode = "smtp"; });
  afterAll(async () => {
    if (createdWorkspaceIds.size) await db.delete(workspacesTable).where(inArray(workspacesTable.id, [...createdWorkspaceIds]));
    if (createdUserIds.size) await db.delete(usersTable).where(inArray(usersTable.id, [...createdUserIds]));
  });

  it("a new account is the owner of its workspace and sees its team", async () => {
    const owner = await signup();
    const me = await owner.agent.get("/api/auth/me");
    expect(me.body.role).toBe("owner");
    expect(me.body.permissions).toContain("team:manage");
    expect(me.body.workspaces).toHaveLength(1);
    const team = await owner.agent.get("/api/team");
    expect(team.status).toBe(200);
    expect(team.body.members).toHaveLength(1);
    expect(team.body.members[0]).toMatchObject({ email: owner.email, role: "owner" });
    expect(team.body.me).toMatchObject({ role: "owner", canManage: true });
    expect(team.body.roles.map((r: { role: string }) => r.role)).toEqual(["owner", "admin", "editor", "approver", "viewer"]);
    expect((await request(app).get("/api/team")).status).toBe(401);
  });

  it("invites by email, shows the link, and the invitee joins with the chosen role", async () => {
    const owner = await signup();
    const invitee = await signup();
    const invite = await owner.agent.post("/api/team/invitations").send({ email: invitee.email.toUpperCase(), role: "editor" });
    expect(invite.status).toBe(201);
    expect(invite.body.emailSent).toBe(true);
    expect(invite.body.inviteUrl).toContain("https://socialflow.test/accept-invite?token=");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(invitee.email);
    const token = tokenFrom(sent[0]!.text);

    // Only the hash is stored.
    const rows = await db.select().from(invitationsTable).where(eq(invitationsTable.workspaceId, owner.workspaceId));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect((await owner.agent.get("/api/team")).body.invitations).toHaveLength(1);

    // Public preview needs the token; garbage is refused.
    const info = await request(app).get(`/api/invitations/${token}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ role: "editor", roleLabel: "Editor", email: invitee.email, hasAccount: true });
    expect((await request(app).get(`/api/invitations/${"x".repeat(43)}`)).status).toBe(404);

    // Not signed in, or the wrong account, can't accept.
    expect((await request(app).post(`/api/invitations/${token}/accept`)).status).toBe(401);
    const stranger = await signup();
    const wrong = await stranger.agent.post(`/api/invitations/${token}/accept`);
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe("wrong_account");

    const accepted = await invitee.agent.post(`/api/invitations/${token}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.role).toBe("editor");
    // The invitee now works in the invited workspace, and can still switch back to their own.
    const me = await invitee.agent.get("/api/auth/me");
    expect(me.body.workspaceId).toBe(owner.workspaceId);
    expect(me.body.role).toBe("editor");
    expect(me.body.workspaces).toHaveLength(2);
    const team = await owner.agent.get("/api/team");
    expect(team.body.members.map((m: { role: string }) => m.role).sort()).toEqual(["editor", "owner"]);
    expect(team.body.invitations).toHaveLength(0);
    expect(team.body.activity.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(["member.invited", "member.joined"]));
    // Single use.
    const again = await invitee.agent.post(`/api/invitations/${token}/accept`);
    expect(again.status).toBe(410);
  });

  it("still gives the inviter a link when email isn't configured", async () => {
    mail.mode = "off";
    const owner = await signup();
    const invite = await owner.agent.post("/api/team/invitations").send({ email: "nobody-yet@socialflow.test", role: "viewer" });
    expect(invite.status).toBe(201);
    expect(invite.body.emailSent).toBe(false);
    expect(invite.body.inviteUrl).toContain("/accept-invite?token=");
    expect(sent).toHaveLength(0);
    expect((await owner.agent.get("/api/team")).body.mailConfigured).toBe(false);
  });

  it("validates who can be invited and to what", async () => {
    const owner = await signup();
    expect((await owner.agent.post("/api/team/invitations").send({ email: "nope", role: "editor" })).body.error).toBe("invalid_email");
    expect((await owner.agent.post("/api/team/invitations").send({ email: "a@socialflow.test", role: "owner" })).body.error).toBe("invalid_role");
    expect((await owner.agent.post("/api/team/invitations").send({ email: "a@socialflow.test", role: "wizard" })).body.error).toBe("invalid_role");
    expect((await owner.agent.post("/api/team/invitations").send({ email: owner.email, role: "editor" })).status).toBe(409);
    // A newer invitation replaces the older one for the same address.
    await owner.agent.post("/api/team/invitations").send({ email: "twice@socialflow.test", role: "viewer" });
    await owner.agent.post("/api/team/invitations").send({ email: "twice@socialflow.test", role: "editor" });
    const pending = (await owner.agent.get("/api/team")).body.invitations.filter((i: { email: string }) => i.email === "twice@socialflow.test");
    expect(pending).toHaveLength(1);
    expect(pending[0].role).toBe("editor");
  });

  it("expired and revoked invitations don't work; resend gives a fresh link", async () => {
    const owner = await signup();
    const invitee = await signup();
    const first = await owner.agent.post("/api/team/invitations").send({ email: invitee.email, role: "viewer" });
    const token1 = /token=([A-Za-z0-9_-]+)/.exec(first.body.inviteUrl)![1]!;
    const resent = await owner.agent.post(`/api/team/invitations/${first.body.id}/resend`);
    expect(resent.status).toBe(200);
    const token2 = /token=([A-Za-z0-9_-]+)/.exec(resent.body.inviteUrl)![1]!;
    expect(token2).not.toBe(token1);
    expect((await request(app).get(`/api/invitations/${token1}`)).status).toBe(404); // the old link is dead
    await db.execute(sql`update socialflow_invitations set expires_at = now(3) - interval 1 minute where id = ${first.body.id}`);
    expect((await request(app).get(`/api/invitations/${token2}`)).status).toBe(410);
    expect((await invitee.agent.post(`/api/invitations/${token2}/accept`)).status).toBe(410);
    const second = await owner.agent.post("/api/team/invitations").send({ email: invitee.email, role: "viewer" });
    const token3 = /token=([A-Za-z0-9_-]+)/.exec(second.body.inviteUrl)![1]!;
    expect((await owner.agent.delete(`/api/team/invitations/${second.body.id}`)).status).toBe(204);
    expect((await invitee.agent.post(`/api/invitations/${token3}/accept`)).status).toBe(404);
  });

  it("enforces the role on every area: viewers read, editors write, only admins manage accounts and people", async () => {
    const owner = await signup();
    const viewer = await addMember(owner, "viewer");
    const editor = await addMember(owner, "editor");
    const admin = await addMember(owner, "admin");

    // Viewer: can read, can't write anything.
    expect((await viewer.agent.get("/api/posts")).status).toBe(200);
    expect((await viewer.agent.get("/api/connections")).status).toBe(200);
    expect((await viewer.agent.get("/api/team")).status).toBe(200);
    expect((await viewer.agent.get("/api/analytics")).status).toBe(200);
    const denied = await viewer.agent.post("/api/posts").send({ content: "no", connectedAccountIds: [] });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("forbidden");
    expect((await viewer.agent.post("/api/tags").send({ name: "x" })).status).toBe(403);
    expect((await viewer.agent.put("/api/queues/00000000-0000-4000-8000-000000000000").send({ timezone: "UTC", slots: [] })).status).toBe(403);
    expect((await viewer.agent.post("/api/team/invitations").send({ email: "a@socialflow.test", role: "viewer" })).status).toBe(403);
    expect((await viewer.agent.post("/api/analytics/refresh")).status).toBe(403);

    // Editor: full post workflow, but not accounts or people.
    const post = await editor.agent.post("/api/posts").send({ content: "Editors can write", connectedAccountIds: [] });
    expect(post.status).toBe(201);
    expect((await editor.agent.post("/api/tags").send({ name: "Campaign" })).status).toBe(201);
    expect((await editor.agent.delete(`/api/posts/${post.body.id}`)).status).toBe(204);
    expect((await editor.agent.delete("/api/connections/00000000-0000-4000-8000-000000000000")).status).toBe(403);
    expect((await editor.agent.post("/api/team/invitations").send({ email: "a@socialflow.test", role: "viewer" })).status).toBe(403);

    // Everyone sees the same workspace data.
    const ownerPost = await owner.agent.post("/api/posts").send({ content: "Shared", connectedAccountIds: [] });
    expect((await viewer.agent.get(`/api/posts/${ownerPost.body.id}`)).status).toBe(200);

    // Admin manages people below them but not peers or the owner.
    expect((await admin.agent.post("/api/team/invitations").send({ email: "x@socialflow.test", role: "editor" })).status).toBe(201);
    expect((await admin.agent.post("/api/team/invitations").send({ email: "y@socialflow.test", role: "admin" })).status).toBe(400);
    expect((await admin.agent.patch(`/api/team/members/${owner.userId}`).send({ role: "viewer" })).status).toBe(403);
    expect((await admin.agent.patch(`/api/team/members/${viewer.userId}`).send({ role: "editor" })).status).toBe(200);
    expect((await viewer.agent.get("/api/auth/me")).body.role).toBe("editor");
  });

  it("changes roles and removes members within the rules", async () => {
    const owner = await signup();
    const member = await addMember(owner, "editor");
    expect((await owner.agent.patch(`/api/team/members/${owner.userId}`).send({ role: "admin" })).status).toBe(400); // own role
    expect((await owner.agent.patch(`/api/team/members/${member.userId}`).send({ role: "owner" })).status).toBe(400);
    const changed = await owner.agent.patch(`/api/team/members/${member.userId}`).send({ role: "approver" });
    expect(changed.status).toBe(200);
    expect(changed.body.members.find((m: { userId: string }) => m.userId === member.userId).role).toBe("approver");
    expect((await member.agent.post("/api/posts").send({ content: "x", connectedAccountIds: [] })).status).toBe(403);
    // The owner can't be removed and can't leave.
    expect((await owner.agent.delete(`/api/team/members/${owner.userId}`)).status).toBe(400);
    // Removing the member ends their access to that workspace but not their own.
    expect((await owner.agent.delete(`/api/team/members/${member.userId}`)).status).toBe(204);
    const me = await member.agent.get("/api/auth/me");
    expect(me.body.workspaceId).toBe(member.workspaceId);
    expect(me.body.role).toBe("owner");
    expect((await owner.agent.get("/api/team")).body.activity.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(["member.role_changed", "member.removed"]));
  });

  it("a member can leave; switching workspaces changes what they see", async () => {
    const owner = await signup();
    const member = await addMember(owner, "editor");
    await owner.agent.post("/api/posts").send({ content: "Owner's post", connectedAccountIds: [] });
    expect((await member.agent.get("/api/posts")).body.posts.map((p: { content: string }) => p.content)).toEqual(["Owner's post"]);
    // Switch to their own workspace: empty there.
    expect((await member.agent.post(`/api/workspaces/${member.workspaceId}/switch`)).status).toBe(204);
    expect((await member.agent.get("/api/posts")).body.posts).toEqual([]);
    expect((await member.agent.get("/api/auth/me")).body.workspaceId).toBe(member.workspaceId);
    // Can't switch into a workspace they don't belong to.
    const outsider = await signup();
    expect((await member.agent.post(`/api/workspaces/${outsider.workspaceId}/switch`)).status).toBe(404);
    // Back in, then leave.
    await member.agent.post(`/api/workspaces/${owner.workspaceId}/switch`);
    expect((await member.agent.delete(`/api/team/members/${member.userId}`)).status).toBe(204);
    expect((await member.agent.get("/api/auth/me")).body.workspaceId).toBe(member.workspaceId);
    const list = await member.agent.get("/api/workspaces");
    expect(list.body.workspaces).toHaveLength(1);
    const remaining = await db.select().from(workspaceMembersTable).where(and(eq(workspaceMembersTable.workspaceId, owner.workspaceId), eq(workspaceMembersTable.userId, member.userId)));
    expect(remaining).toHaveLength(0);
  });

  it("keeps workspaces isolated from each other", async () => {
    const a = await signup();
    const b = await signup();
    const post = await a.agent.post("/api/posts").send({ content: "A's secret", connectedAccountIds: [] });
    expect((await b.agent.get(`/api/posts/${post.body.id}`)).status).toBe(404);
    expect((await b.agent.get("/api/team")).body.members.map((m: { email: string }) => m.email)).toEqual([b.email]);
    // An invitation link for one workspace can't be used by a different email to join it.
    const invite = await a.agent.post("/api/team/invitations").send({ email: "someone-else@socialflow.test", role: "viewer" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(invite.body.inviteUrl)![1]!;
    expect((await b.agent.post(`/api/invitations/${token}/accept`)).status).toBe(403);
  });
});
