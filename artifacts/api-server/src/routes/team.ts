import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  auditLogTable,
  db,
  invitationsTable,
  sessionsTable,
  usersTable,
  workspaceMembersTable,
  workspacesTable,
  workspaceRoles,
  type WorkspaceRole,
} from "@workspace/db";
import { requireAccess } from "../lib/access";
import { recordAudit } from "../lib/audit";
import { jsonError } from "../lib/http-errors";
import { mailMode, sendMail } from "../lib/mail";
import { getRedirectBaseUrl } from "../lib/oauth/config";
import { normalizeEmail } from "../lib/password";
import { ALL_PERMISSIONS, ROLE_INFO, ROLE_PERMISSIONS, canManage, grantableRoles, isWorkspaceRole } from "../lib/permissions";
import { resolveUser, resolveWorkspace } from "../lib/session";
import { rateLimit } from "../middlewares/rate-limit";

/* Workspace members, invitations, roles, workspace switching and the activity log. */

const router: IRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITE_TTL_MS = 7 * 24 * 3600_000;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const inviteLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: Number(process.env.TEAM_INVITE_RATE_LIMIT ?? 30), keyPrefix: "team:invite" });

const serializeMember = (row: { userId: string; email: string; displayName: string | null; role: WorkspaceRole; createdAt: Date }) => ({
  userId: row.userId, email: row.email, displayName: row.displayName, role: row.role, joinedAt: row.createdAt,
});

async function loadTeam(workspaceId: string) {
  const members = await db
    .select({ userId: usersTable.id, email: usersTable.email, displayName: usersTable.displayName, role: workspaceMembersTable.role, createdAt: workspaceMembersTable.createdAt })
    .from(workspaceMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, workspaceMembersTable.userId))
    .where(eq(workspaceMembersTable.workspaceId, workspaceId))
    .orderBy(workspaceMembersTable.createdAt);
  const invitations = await db
    .select({ id: invitationsTable.id, email: invitationsTable.email, role: invitationsTable.role, expiresAt: invitationsTable.expiresAt, createdAt: invitationsTable.createdAt, invitedBy: usersTable.displayName, invitedByEmail: usersTable.email })
    .from(invitationsTable)
    .leftJoin(usersTable, eq(usersTable.id, invitationsTable.invitedByUserId))
    .where(and(eq(invitationsTable.workspaceId, workspaceId), isNull(invitationsTable.acceptedAt), isNull(invitationsTable.revokedAt)))
    .orderBy(desc(invitationsTable.createdAt));
  return { members: members.map(serializeMember), invitations: invitations.map((row) => ({ id: row.id, email: row.email, role: row.role, expiresAt: row.expiresAt, createdAt: row.createdAt, invitedBy: row.invitedBy ?? row.invitedByEmail ?? null, expired: row.expiresAt.getTime() < Date.now() })) };
}

router.get("/team", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "team:read");
  if (!ctx) return;
  const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, ctx.workspaceId)).limit(1);
  const { members, invitations } = await loadTeam(ctx.workspaceId);
  const activity = await db
    .select({ id: auditLogTable.id, action: auditLogTable.action, target: auditLogTable.target, detail: auditLogTable.detail, createdAt: auditLogTable.createdAt, actorName: usersTable.displayName, actorEmail: usersTable.email })
    .from(auditLogTable)
    .leftJoin(usersTable, eq(usersTable.id, auditLogTable.actorUserId))
    .where(eq(auditLogTable.workspaceId, ctx.workspaceId))
    .orderBy(desc(auditLogTable.createdAt))
    .limit(30);
  res.json({
    workspace: { id: workspace!.id, name: workspace!.name },
    me: { userId: ctx.userId, role: ctx.role, canManage: ctx.role === "owner" || ctx.role === "admin", grantableRoles: grantableRoles(ctx.role) },
    members,
    invitations,
    roles: workspaceRoles.map((role) => ({ role, label: ROLE_INFO[role].label, description: ROLE_INFO[role].description, permissions: ROLE_PERMISSIONS[role] })),
    permissions: ALL_PERMISSIONS,
    mailConfigured: mailMode() !== "off",
    activity: activity.map((row) => ({ id: row.id, action: row.action, target: row.target, detail: row.detail, createdAt: row.createdAt, actor: row.actorName ?? row.actorEmail ?? "Someone" })),
  });
});

function inviteLink(token: string): string | null {
  const base = getRedirectBaseUrl();
  return base ? `${base}/accept-invite?token=${token}` : null;
}

async function emailInvitation(email: string, role: WorkspaceRole, inviter: string, workspaceName: string, link: string): Promise<boolean> {
  if (mailMode() === "off") return false;
  try {
    await sendMail({
      to: email,
      subject: `${inviter} invited you to ${workspaceName} on Socialflow`,
      text: [
        `${inviter} invited you to join "${workspaceName}" on Socialflow as ${ROLE_INFO[role].label.toLowerCase()}.`,
        "",
        "Open this link to accept (it works for 7 days). You'll sign in or create an account with this email address first:",
        "",
        link,
        "",
        "If you weren't expecting this, you can ignore the email.",
      ].join("\n"),
    });
    return true;
  } catch {
    return false;
  }
}

/** Invites someone by email. The link is always returned to the inviter too, so it can be shared by hand if email can't be sent. */
router.post("/team/invitations", inviteLimiter, async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "team:manage");
  if (!ctx) return;
  const email = normalizeEmail(req.body?.email);
  const role = req.body?.role;
  if (!email) return jsonError(res, 400, "invalid_email", "Enter a valid email address.");
  if (!isWorkspaceRole(role) || !grantableRoles(ctx.role).includes(role)) return jsonError(res, 400, "invalid_role", "You can't give that role.");

  const [existingMember] = await db
    .select({ userId: usersTable.id })
    .from(usersTable)
    .innerJoin(workspaceMembersTable, and(eq(workspaceMembersTable.userId, usersTable.id), eq(workspaceMembersTable.workspaceId, ctx.workspaceId)))
    .where(eq(usersTable.email, email))
    .limit(1);
  if (existingMember) return jsonError(res, 409, "already_member", "That person is already in this workspace.");

  const token = randomBytes(32).toString("base64url");
  const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, ctx.workspaceId)).limit(1);
  const [inviter] = await db.select().from(usersTable).where(eq(usersTable.id, ctx.userId)).limit(1);
  const invitation = await db.transaction(async (tx) => {
    await tx.update(invitationsTable).set({ revokedAt: new Date() }).where(and(eq(invitationsTable.workspaceId, ctx.workspaceId), eq(invitationsTable.email, email), isNull(invitationsTable.acceptedAt), isNull(invitationsTable.revokedAt)));
    const [row] = await tx.insert(invitationsTable).values({ workspaceId: ctx.workspaceId, email, role, invitedByUserId: ctx.userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) }).returning();
    return row!;
  });
  const link = inviteLink(token);
  const emailed = link ? await emailInvitation(email, role, inviter?.displayName ?? inviter?.email ?? "A teammate", workspace!.name, link) : false;
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "member.invited", target: email, detail: { role, emailed } });
  res.status(201).json({ id: invitation.id, email, role, expiresAt: invitation.expiresAt, inviteUrl: link, emailSent: emailed });
});

router.post("/team/invitations/:invitationId/resend", inviteLimiter, async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "team:manage");
  if (!ctx) return;
  const id = String(req.params.invitationId);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "Invitation not found.");
  const [existing] = await db.select().from(invitationsTable).where(and(eq(invitationsTable.id, id), eq(invitationsTable.workspaceId, ctx.workspaceId), isNull(invitationsTable.acceptedAt), isNull(invitationsTable.revokedAt))).limit(1);
  if (!existing) return jsonError(res, 404, "not_found", "Invitation not found.");
  if (!isWorkspaceRole(existing.role) || !grantableRoles(ctx.role).includes(existing.role)) return jsonError(res, 403, "forbidden", "You can't manage that invitation.");
  const token = randomBytes(32).toString("base64url");
  await db.update(invitationsTable).set({ tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) }).where(eq(invitationsTable.id, id));
  const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, ctx.workspaceId)).limit(1);
  const [inviter] = await db.select().from(usersTable).where(eq(usersTable.id, ctx.userId)).limit(1);
  const link = inviteLink(token);
  const emailed = link ? await emailInvitation(existing.email, existing.role, inviter?.displayName ?? inviter?.email ?? "A teammate", workspace!.name, link) : false;
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "member.invite_resent", target: existing.email, detail: { emailed } });
  res.json({ id, email: existing.email, role: existing.role, inviteUrl: link, emailSent: emailed });
});

router.delete("/team/invitations/:invitationId", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "team:manage");
  if (!ctx) return;
  const id = String(req.params.invitationId);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "Invitation not found.");
  const [existing] = await db.select().from(invitationsTable).where(and(eq(invitationsTable.id, id), eq(invitationsTable.workspaceId, ctx.workspaceId), isNull(invitationsTable.acceptedAt), isNull(invitationsTable.revokedAt))).limit(1);
  if (!existing) return jsonError(res, 404, "not_found", "Invitation not found.");
  if (!isWorkspaceRole(existing.role) || !grantableRoles(ctx.role).includes(existing.role)) return jsonError(res, 403, "forbidden", "You can't manage that invitation.");
  await db.update(invitationsTable).set({ revokedAt: new Date() }).where(eq(invitationsTable.id, id));
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "member.invite_revoked", target: existing.email });
  res.sendStatus(204);
});

router.patch("/team/members/:userId", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, "team:manage");
  if (!ctx) return;
  const userId = String(req.params.userId);
  if (!UUID.test(userId)) return jsonError(res, 404, "not_found", "Member not found.");
  const role = req.body?.role;
  if (!isWorkspaceRole(role) || !grantableRoles(ctx.role).includes(role)) return jsonError(res, 400, "invalid_role", "You can't give that role.");
  if (userId === ctx.userId) return jsonError(res, 400, "invalid_change", "You can't change your own role.");
  const [target] = await db.select().from(workspaceMembersTable).where(and(eq(workspaceMembersTable.workspaceId, ctx.workspaceId), eq(workspaceMembersTable.userId, userId))).limit(1);
  if (!target) return jsonError(res, 404, "not_found", "Member not found.");
  if (!canManage(ctx.role, target.role)) return jsonError(res, 403, "forbidden", "You can't change this person's role.");
  await db.update(workspaceMembersTable).set({ role }).where(and(eq(workspaceMembersTable.workspaceId, ctx.workspaceId), eq(workspaceMembersTable.userId, userId)));
  const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "member.role_changed", target: user?.email ?? userId, detail: { from: target.role, to: role } });
  const { members } = await loadTeam(ctx.workspaceId);
  res.json({ members });
});

/** Removes a member, or lets someone leave. Owners can't leave: the workspace always has its owner. */
router.delete("/team/members/:userId", async (req, res): Promise<void> => {
  const ctx = await resolveWorkspace(req, res);
  if (!ctx) return jsonError(res, 401, "unauthorized", "Sign in to continue.");
  const userId = String(req.params.userId);
  if (!UUID.test(userId)) return jsonError(res, 404, "not_found", "Member not found.");
  const [target] = await db.select().from(workspaceMembersTable).where(and(eq(workspaceMembersTable.workspaceId, ctx.workspaceId), eq(workspaceMembersTable.userId, userId))).limit(1);
  if (!target) return jsonError(res, 404, "not_found", "Member not found.");
  const leaving = userId === ctx.userId;
  if (target.role === "owner") return jsonError(res, 400, "invalid_change", "The owner can't be removed or leave the workspace.");
  if (!leaving && !canManage(ctx.role, target.role)) return jsonError(res, 403, "forbidden", "You can't remove this person.");
  const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  await db.transaction(async (tx) => {
    await tx.delete(workspaceMembersTable).where(and(eq(workspaceMembersTable.workspaceId, ctx.workspaceId), eq(workspaceMembersTable.userId, userId)));
    // Their sessions stop pointing at a workspace they can no longer open.
    await tx.update(sessionsTable).set({ activeWorkspaceId: null }).where(and(eq(sessionsTable.userId, userId), eq(sessionsTable.activeWorkspaceId, ctx.workspaceId)));
  });
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: leaving ? "member.left" : "member.removed", target: user?.email ?? userId, detail: { role: target.role } });
  res.sendStatus(204);
});

/* ---------- Accepting an invitation ---------- */

async function findInvitation(token: unknown) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const [row] = await db.select().from(invitationsTable).where(eq(invitationsTable.tokenHash, sha256(token))).limit(1);
  return row ?? null;
}

/** What an invitation is for, so the accept page can say it before the person signs in. Reveals nothing without the token. */
router.get("/invitations/:token", async (req, res): Promise<void> => {
  const invitation = await findInvitation(req.params.token);
  if (!invitation || invitation.revokedAt) return jsonError(res, 404, "invalid_invitation", "This invitation isn't valid. Ask for a new one.");
  if (invitation.acceptedAt) return jsonError(res, 410, "invitation_used", "This invitation was already accepted.");
  if (invitation.expiresAt.getTime() < Date.now()) return jsonError(res, 410, "invitation_expired", "This invitation has expired. Ask for a new one.");
  const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, invitation.workspaceId)).limit(1);
  const [inviter] = invitation.invitedByUserId ? await db.select().from(usersTable).where(eq(usersTable.id, invitation.invitedByUserId)).limit(1) : [];
  const [existingUser] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, invitation.email)).limit(1);
  res.json({ workspaceName: workspace?.name ?? "a workspace", role: invitation.role, roleLabel: isWorkspaceRole(invitation.role) ? ROLE_INFO[invitation.role].label : invitation.role, email: invitation.email, invitedBy: inviter?.displayName ?? inviter?.email ?? null, hasAccount: Boolean(existingUser), expiresAt: invitation.expiresAt });
});

router.post("/invitations/:token/accept", async (req, res): Promise<void> => {
  const auth = await resolveUser(req);
  if (!auth) return jsonError(res, 401, "unauthorized", "Sign in with the invited email address to accept.");
  const invitation = await findInvitation(req.params.token);
  if (!invitation || invitation.revokedAt) return jsonError(res, 404, "invalid_invitation", "This invitation isn't valid. Ask for a new one.");
  if (invitation.acceptedAt) return jsonError(res, 410, "invitation_used", "This invitation was already accepted.");
  if (invitation.expiresAt.getTime() < Date.now()) return jsonError(res, 410, "invitation_expired", "This invitation has expired. Ask for a new one.");
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId)).limit(1);
  if (!user || user.email !== invitation.email) return jsonError(res, 403, "wrong_account", `This invitation is for ${invitation.email}. Sign in with that address.`);
  if (!isWorkspaceRole(invitation.role)) return jsonError(res, 400, "invalid_role", "This invitation has an unknown role.");
  await db.transaction(async (tx) => {
    // Claiming the invitation and joining are one transaction, so it can't be used twice.
    const claimed = await tx.update(invitationsTable).set({ acceptedAt: new Date() }).where(and(eq(invitationsTable.id, invitation.id), isNull(invitationsTable.acceptedAt), isNull(invitationsTable.revokedAt), gt(invitationsTable.expiresAt, new Date()))).returning({ id: invitationsTable.id });
    if (claimed.length === 0) throw new Error("invitation_unavailable");
    await tx.insert(workspaceMembersTable).values({ workspaceId: invitation.workspaceId, userId: auth.userId, role: invitation.role as WorkspaceRole }).onConflictDoNothing();
    await tx.update(sessionsTable).set({ activeWorkspaceId: invitation.workspaceId }).where(eq(sessionsTable.id, auth.sessionId));
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "invitation_unavailable") return null;
    throw error;
  });
  const [after] = await db.select({ id: workspaceMembersTable.id }).from(workspaceMembersTable).where(and(eq(workspaceMembersTable.workspaceId, invitation.workspaceId), eq(workspaceMembersTable.userId, auth.userId))).limit(1);
  if (!after) return jsonError(res, 410, "invitation_used", "This invitation is no longer available.");
  await recordAudit({ workspaceId: invitation.workspaceId, actorUserId: auth.userId, action: "member.joined", target: user.email, detail: { role: invitation.role } });
  res.json({ workspaceId: invitation.workspaceId, role: invitation.role });
});

/* ---------- Workspaces ---------- */

router.get("/workspaces", async (req, res): Promise<void> => {
  const ctx = await resolveWorkspace(req, res);
  if (!ctx) return jsonError(res, 401, "unauthorized", "Sign in to continue.");
  const rows = await db
    .select({ id: workspacesTable.id, name: workspacesTable.name, role: workspaceMembersTable.role })
    .from(workspaceMembersTable)
    .innerJoin(workspacesTable, eq(workspacesTable.id, workspaceMembersTable.workspaceId))
    .where(eq(workspaceMembersTable.userId, ctx.userId))
    .orderBy(workspaceMembersTable.createdAt);
  res.json({ workspaces: rows.map((row) => ({ ...row, current: row.id === ctx.workspaceId })) });
});

router.post("/workspaces/:workspaceId/switch", async (req: Request, res: Response): Promise<void> => {
  const auth = await resolveUser(req);
  if (!auth) return void jsonError(res, 401, "unauthorized", "Sign in to continue.");
  const id = String(req.params.workspaceId);
  if (!UUID.test(id)) return void jsonError(res, 404, "not_found", "Workspace not found.");
  const [membership] = await db.select({ id: workspaceMembersTable.id }).from(workspaceMembersTable).where(and(eq(workspaceMembersTable.userId, auth.userId), eq(workspaceMembersTable.workspaceId, id))).limit(1);
  if (!membership) return void jsonError(res, 404, "not_found", "Workspace not found.");
  await db.update(sessionsTable).set({ activeWorkspaceId: id }).where(eq(sessionsTable.id, auth.sessionId));
  res.sendStatus(204);
});

// Keeps the import used when the members query above is extended with filters.
void [inArray, ne];

export default router;
