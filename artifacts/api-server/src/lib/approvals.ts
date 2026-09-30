import { and, eq, sql, type SQL } from "drizzle-orm";
import { db, postApprovalsTable, approvalSettingsTable, usersTable, workspaceMembersTable } from "@workspace/db";
import { logger } from "./logger";
import { getRedirectBaseUrl } from "./oauth/config";
import { can } from "./permissions";
import { mailMode, sendMail } from "./mail";

/* Approval workflow helpers. See docs/integration/approvals.md for how posts.ts and publisher.ts use them. */

export async function isApprovalRequired(workspaceId: string): Promise<boolean> {
  const [row] = await db.select({ required: approvalSettingsTable.required }).from(approvalSettingsTable).where(eq(approvalSettingsTable.workspaceId, workspaceId)).limit(1);
  return row?.required ?? false;
}

/**
 * SQL boolean expression, true when the post aliased `postAlias` (columns id, workspace_id) must NOT be published:
 * its workspace requires approval and the post has no approved approval. Alias is a trusted identifier, never user input.
 * Publisher usage: `where status = 'scheduled' and ... and not (${sql.raw(publishBlockedSql("socialflow_posts"))})`
 */
export function publishBlockedSql(postAlias = "socialflow_posts"): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(postAlias)) throw new Error("Invalid alias");
  return `(exists (select 1 from socialflow_approval_settings s where s.workspace_id = ${postAlias}.workspace_id and s.required)
    and not exists (select 1 from socialflow_post_approvals a where a.post_id = ${postAlias}.id and a.status = 'approved'))`;
}

/** Drizzle-friendly form of publishBlockedSql. */
export const publishBlockedCondition = (postAlias = "socialflow_posts"): SQL => sql.raw(publishBlockedSql(postAlias));

export async function isPublishBlockedByApproval(postId: string): Promise<boolean> {
  const result = await db.execute(sql`select ${sql.raw(publishBlockedSql("p"))} as blocked from socialflow_posts p where p.id = ${postId}`);
  const row = result.rows[0] as { blocked: boolean } | undefined;
  return row?.blocked ?? false;
}

/**
 * Call after a post's content, targets or schedule changes. An approved approval goes back to pending (approval covered
 * the old content); returns true if it was reset. Pending/other states are untouched.
 */
export async function resetApprovalOnEdit(postId: string): Promise<boolean> {
  const rows = await db
    .update(postApprovalsTable)
    .set({ status: "pending", decidedBy: null, decidedAt: null, note: "Edited after approval; approval needed again." })
    .where(and(eq(postApprovalsTable.postId, postId), eq(postApprovalsTable.status, "approved")))
    .returning({ id: postApprovalsTable.id });
  return rows.length > 0;
}

/**
 * Best-effort: emails every workspace member who can decide on approvals (except the requester) that a request is waiting.
 * Never throws; failures are logged without addresses. Returns how many emails were handed to the transport.
 */
export async function notifyApprovers(args: { workspaceId: string; requesterId: string; postContent: string; note: string | null }): Promise<number> {
  try {
    if (mailMode() === "off") return 0;
    const members = await db
      .select({ userId: workspaceMembersTable.userId, role: workspaceMembersTable.role, email: usersTable.email, name: usersTable.displayName })
      .from(workspaceMembersTable)
      .innerJoin(usersTable, eq(usersTable.id, workspaceMembersTable.userId))
      .where(eq(workspaceMembersTable.workspaceId, args.workspaceId));
    const requester = members.find((m) => m.userId === args.requesterId);
    let requesterName = requester?.name ?? requester?.email ?? null;
    if (!requesterName) {
      const [u] = await db.select({ name: usersTable.displayName, email: usersTable.email }).from(usersTable).where(eq(usersTable.id, args.requesterId)).limit(1);
      requesterName = u?.name ?? u?.email ?? "A teammate";
    }
    const base = getRedirectBaseUrl();
    const link = base ? `${base}/approvals` : null;
    const preview = args.postContent.replace(/\s+/g, " ").trim().slice(0, 60);
    const subject = `Approval needed: ${preview || "(no text)"}`;
    const text = [
      `${requesterName} sent a post for your approval.`,
      args.note ? `Note: ${args.note}` : null,
      link ? `Review it here: ${link}` : "Open the Approvals page in SocialFlow to review it.",
    ].filter(Boolean).join("\n\n");
    let count = 0;
    for (const m of members) {
      if (m.userId === args.requesterId || !m.email || !can(m.role, "approvals:decide")) continue;
      if (await notify(m.email, subject, text)) count++;
    }
    return count;
  } catch (error) {
    logger.warn({ err: error }, "Approver notification failed");
    return 0;
  }
}

/** Best-effort email; never throws. Returns whether mail was handed to the transport. */
export async function notify(to: string | null | undefined, subject: string, text: string): Promise<boolean> {
  if (!to || mailMode() === "off") return false;
  try {
    await sendMail({ to, subject, text });
    return true;
  } catch (error) {
    logger.warn({ err: error }, "Approval notification email failed");
    return false;
  }
}
