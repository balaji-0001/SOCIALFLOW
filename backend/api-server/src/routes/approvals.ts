import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Response } from "express";
import {
  approvalSettingsTable,
  approvalStatuses,
  db,
  postApprovalCommentsTable,
  postApprovalsTable,
  postsTable,
  usersTable,
  type ApprovalStatus,
} from "@workspace/db";
import { requireAccess } from "../lib/access";
import { notify, notifyApprovers } from "../lib/approvals";
import { recordAudit } from "../lib/audit";
import { jsonError } from "../lib/http-errors";
import { can, type Permission } from "../lib/permissions";
import type { WorkspaceContext } from "../lib/session";

/* Post approval workflow: request, decide, withdraw, comment, and the workspace "approvals required" setting. */

const router: IRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const P = (name: string) => name as Permission; // approvals:* are added to lib/permissions.ts by the integrator
const MAX_TEXT = 2000;

const cleanText = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT) : null);

/** Deciders and managers see the whole queue; everyone else sees only their own requests. */
const seesQueue = (role: WorkspaceContext["role"]) => can(role, P("approvals:decide")) || can(role, P("approvals:manage"));

async function serialize(rows: Array<typeof postApprovalsTable.$inferSelect>) {
  if (rows.length === 0) return [];
  const postIds = rows.map((r) => r.postId);
  const posts = await db.select({ id: postsTable.id, content: postsTable.content, status: postsTable.status, scheduledAt: postsTable.scheduledAt }).from(postsTable).where(inArray(postsTable.id, postIds));
  const userIds = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy]).filter((v): v is string => !!v))];
  const users = userIds.length ? await db.select({ id: usersTable.id, name: usersTable.displayName, email: usersTable.email }).from(usersTable).where(inArray(usersTable.id, userIds)) : [];
  const nameOf = (id: string | null) => { const u = users.find((x) => x.id === id); return u ? (u.name ?? u.email) : null; };
  return rows.map((r) => {
    const post = posts.find((p) => p.id === r.postId);
    return {
      id: r.id, postId: r.postId, status: r.status as ApprovalStatus,
      requestedBy: r.requestedBy, requestedByName: nameOf(r.requestedBy), requestedAt: r.requestedAt,
      decidedBy: r.decidedBy, decidedByName: nameOf(r.decidedBy), decidedAt: r.decidedAt, note: r.note,
      post: post ? { id: post.id, content: post.content, status: post.status, scheduledAt: post.scheduledAt } : null,
    };
  });
}

async function loadOwn(res: Response, ctx: WorkspaceContext, id: string) {
  if (!UUID.test(id)) { jsonError(res, 404, "not_found", "Approval not found."); return null; }
  const [row] = await db.select().from(postApprovalsTable).where(and(eq(postApprovalsTable.id, id), eq(postApprovalsTable.workspaceId, ctx.workspaceId))).limit(1);
  if (!row) { jsonError(res, 404, "not_found", "Approval not found."); return null; }
  if (!seesQueue(ctx.role) && row.requestedBy !== ctx.userId) { jsonError(res, 404, "not_found", "Approval not found."); return null; }
  return row;
}

const settingsBody = async (workspaceId: string) => {
  const [row] = await db.select().from(approvalSettingsTable).where(eq(approvalSettingsTable.workspaceId, workspaceId)).limit(1);
  return { required: row?.required ?? false, updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ?? null };
};

router.get("/approvals/settings", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, P("approvals:read"));
  if (!ctx) return;
  res.json(await settingsBody(ctx.workspaceId));
});

router.put("/approvals/settings", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, P("approvals:manage"));
  if (!ctx) return;
  if (typeof req.body?.required !== "boolean") return jsonError(res, 400, "invalid_body", "required must be true or false.");
  await db
    .insert(approvalSettingsTable)
    .values({ workspaceId: ctx.workspaceId, required: req.body.required, updatedBy: ctx.userId })
    .onConflictDoUpdate({ target: approvalSettingsTable.workspaceId, set: { required: req.body.required, updatedBy: ctx.userId, updatedAt: new Date() } });
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "approvals.settings_changed", detail: { required: req.body.required } });
  res.json(await settingsBody(ctx.workspaceId));
});

router.get("/approvals", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, P("approvals:read"));
  if (!ctx) return;
  const status = req.query.status;
  if (status !== undefined && !(typeof status === "string" && (approvalStatuses as readonly string[]).includes(status))) {
    return jsonError(res, 400, "invalid_status", "Unknown approval status.");
  }
  const conditions = [eq(postApprovalsTable.workspaceId, ctx.workspaceId)];
  if (typeof status === "string") conditions.push(eq(postApprovalsTable.status, status as ApprovalStatus));
  if (!seesQueue(ctx.role)) conditions.push(eq(postApprovalsTable.requestedBy, ctx.userId));
  const rows = await db.select().from(postApprovalsTable).where(and(...conditions)).orderBy(desc(postApprovalsTable.requestedAt)).limit(200);
  res.json({ approvals: await serialize(rows), scope: seesQueue(ctx.role) ? "queue" : "own" });
});

router.get("/approvals/:id", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, P("approvals:read"));
  if (!ctx) return;
  const row = await loadOwn(res, ctx, req.params.id!);
  if (!row) return;
  const comments = await db
    .select({ id: postApprovalCommentsTable.id, userId: postApprovalCommentsTable.userId, body: postApprovalCommentsTable.body, createdAt: postApprovalCommentsTable.createdAt, name: usersTable.displayName, email: usersTable.email })
    .from(postApprovalCommentsTable)
    .leftJoin(usersTable, eq(usersTable.id, postApprovalCommentsTable.userId))
    .where(eq(postApprovalCommentsTable.approvalId, row.id))
    .orderBy(asc(postApprovalCommentsTable.createdAt));
  const [approval] = await serialize([row]);
  res.json({ ...approval!, comments: comments.map((c) => ({ id: c.id, userId: c.userId, author: c.name ?? c.email ?? "Someone", body: c.body, createdAt: c.createdAt })) });
});

router.post("/posts/:postId/approval", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, P("approvals:request"));
  if (!ctx) return;
  const postId = req.params.postId!;
  if (!UUID.test(postId)) return jsonError(res, 404, "not_found", "Post not found.");
  const [post] = await db.select({ id: postsTable.id, status: postsTable.status, content: postsTable.content }).from(postsTable).where(and(eq(postsTable.id, postId), eq(postsTable.workspaceId, ctx.workspaceId))).limit(1);
  if (!post) return jsonError(res, 404, "not_found", "Post not found.");
  if (post.status !== "draft" && post.status !== "scheduled") return jsonError(res, 409, "post_not_approvable", "Only draft or scheduled posts can be sent for approval.");
  const note = cleanText(req.body?.note);
  const [existing] = await db.select().from(postApprovalsTable).where(eq(postApprovalsTable.postId, postId)).limit(1);
  if (existing?.status === "pending") return jsonError(res, 409, "already_pending", "This post is already waiting for approval.");
  if (existing?.status === "approved") return jsonError(res, 409, "already_approved", "This post is already approved.");
  const values = { status: "pending" as const, requestedBy: ctx.userId, requestedAt: new Date(), decidedBy: null, decidedAt: null, note };
  const [row] = existing
    ? await db.update(postApprovalsTable).set(values).where(eq(postApprovalsTable.id, existing.id)).returning()
    : await db.insert(postApprovalsTable).values({ postId, workspaceId: ctx.workspaceId, ...values }).returning();
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "approval.requested", target: postId, detail: { approvalId: row!.id } });
  const [approval] = await serialize([row!]);
  await notifyApprovers({ workspaceId: ctx.workspaceId, requesterId: ctx.userId, postContent: post.content ?? "", note });
  res.status(201).json(approval);
});

type Decision = { path: string; status: Extract<ApprovalStatus, "approved" | "rejected" | "changes_requested">; action: string; verb: string };
const decisions: Decision[] = [
  { path: "approve", status: "approved", action: "approval.approved", verb: "approved" },
  { path: "reject", status: "rejected", action: "approval.rejected", verb: "rejected" },
  { path: "request-changes", status: "changes_requested", action: "approval.changes_requested", verb: "asked for changes on" },
];

for (const d of decisions) {
  router.post(`/approvals/:id/${d.path}`, async (req, res): Promise<void> => {
    const ctx = await requireAccess(req, res, P("approvals:decide"));
    if (!ctx) return;
    const row = await loadOwn(res, ctx, req.params.id!);
    if (!row) return;
    if (row.requestedBy === ctx.userId) return jsonError(res, 403, "own_request", "You can't decide on your own approval request.");
    const note = cleanText(req.body?.note);
    if (d.status !== "approved" && !note) return jsonError(res, 400, "note_required", "Add a note explaining what needs to change.");
    // Conditional update so two deciders can't both win.
    const [updated] = await db
      .update(postApprovalsTable)
      .set({ status: d.status, decidedBy: ctx.userId, decidedAt: new Date(), note })
      .where(and(eq(postApprovalsTable.id, row.id), eq(postApprovalsTable.status, "pending")))
      .returning();
    if (!updated) return jsonError(res, 409, "not_pending", "This request is no longer pending.");
    await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: d.action, target: row.postId, detail: { approvalId: row.id } });
    if (row.requestedBy) {
      const [requester] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, row.requestedBy)).limit(1);
      await notify(requester?.email, `Your post was ${d.status.replace("_", " ")}`, `A reviewer ${d.verb} your post.${note ? `\n\nNote: ${note}` : ""}`);
    }
    const [approval] = await serialize([updated]);
    res.json(approval);
  });
}

router.post("/approvals/:id/withdraw", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, P("approvals:request"));
  if (!ctx) return;
  const row = await loadOwn(res, ctx, req.params.id!);
  if (!row) return;
  if (row.requestedBy !== ctx.userId && !can(ctx.role, P("approvals:manage"))) return jsonError(res, 403, "forbidden", "Only the requester or an admin can withdraw this request.");
  const [updated] = await db
    .update(postApprovalsTable)
    .set({ status: "withdrawn", decidedBy: ctx.userId, decidedAt: new Date() })
    .where(and(eq(postApprovalsTable.id, row.id), inArray(postApprovalsTable.status, ["pending", "changes_requested"])))
    .returning();
  if (!updated) return jsonError(res, 409, "not_withdrawable", "Only pending or changes-requested approvals can be withdrawn.");
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "approval.withdrawn", target: row.postId, detail: { approvalId: row.id } });
  const [approval] = await serialize([updated]);
  res.json(approval);
});

router.post("/approvals/:id/comments", async (req, res): Promise<void> => {
  const ctx = await requireAccess(req, res, P("approvals:read"));
  if (!ctx) return;
  const row = await loadOwn(res, ctx, req.params.id!);
  if (!row) return;
  const body = cleanText(req.body?.body);
  if (!body) return jsonError(res, 400, "invalid_body", "Write a comment first.");
  const [comment] = await db.insert(postApprovalCommentsTable).values({ approvalId: row.id, userId: ctx.userId, body }).returning();
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "approval.commented", target: row.postId, detail: { approvalId: row.id } });
  res.status(201).json({ id: comment!.id, userId: comment!.userId, body: comment!.body, createdAt: comment!.createdAt });
});

export default router;
