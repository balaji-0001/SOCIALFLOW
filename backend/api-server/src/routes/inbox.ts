import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { connectedAccountsTable, db, inboxKinds, postTargetsTable, usersTable, workspaceMembersTable, type InboxKind, type WorkspaceRole } from "@workspace/db";
import { requireAccess } from "../lib/access";
import { recordAudit } from "../lib/audit";
import { jsonError } from "../lib/http-errors";
import { accountAvailability, collectWorkspace, inboxItemsTable, inboxRepliesTable, inboxSyncTable, mentionsAvailability, messagingAvailability, sendReply } from "../lib/inbox";
import { MESSAGE_MAX_LENGTH, MESSAGE_WINDOW_MS, REPLY_MAX_LENGTH, WINDOW_CLOSED_MESSAGE, mentionReplySupport, replyWindow } from "../lib/oauth/inbox-adapters";
import { platforms, type Platform } from "../lib/oauth/types";
import { ALL_PERMISSIONS, type Permission } from "../lib/permissions";
import { resolveWorkspace, type WorkspaceContext } from "../lib/session";
import { rateLimit } from "../middlewares/rate-limit";

/* Inbox: comments on published posts, collected from the networks; assign, resolve and answer them. */

const router: IRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

const refreshLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: Number(process.env.INBOX_REFRESH_RATE_LIMIT ?? 5), keyPrefix: "inbox:refresh" });

/*
 * Permission names used here: inbox:read (every role), inbox:reply and inbox:manage (owner, admin, editor). Until the
 * integrator adds them to lib/permissions.ts, the defaults below apply; once they are there, that table decides.
 */
type InboxPermission = "inbox:read" | "inbox:reply" | "inbox:manage";
const DEFAULT_ROLES: Record<InboxPermission, WorkspaceRole[]> = {
  "inbox:read": ["owner", "admin", "editor", "approver", "viewer"],
  "inbox:reply": ["owner", "admin", "editor"],
  "inbox:manage": ["owner", "admin", "editor"],
};

async function requireInbox(req: Request, res: Response, permission: InboxPermission): Promise<WorkspaceContext | null> {
  if (ALL_PERMISSIONS.includes(permission as unknown as Permission)) return requireAccess(req, res, permission as unknown as Permission);
  const ctx = await resolveWorkspace(req, res);
  if (!ctx) {
    jsonError(res, 401, "unauthorized", "Sign in to continue.");
    return null;
  }
  if (!DEFAULT_ROLES[permission].includes(ctx.role)) {
    jsonError(res, 403, "forbidden", "Your role in this workspace doesn't allow that. Ask an owner or admin.");
    return null;
  }
  return ctx;
}

// ---------------------------------------------------------------------------------------------- Loading items

/*
 * What the lists and counts show: comments, mentions, and one row per conversation (its latest message from the other person).
 * The account's own messages belong to the conversation (GET /inbox/threads/{threadId}) but are never inbox work.
 */
const visibleItem = sql`(socialflow_inbox_items.from_page = false and (socialflow_inbox_items.kind <> 'message' or not exists (
  select 1 from socialflow_inbox_items n
  where n.connected_account_id = socialflow_inbox_items.connected_account_id and n.thread_id = socialflow_inbox_items.thread_id
    and n.kind = 'message' and n.from_page = false
    and (n.created_at_network, n.id) > (socialflow_inbox_items.created_at_network, socialflow_inbox_items.id))))`;

/** What answering an item needs, from its kind: comments always; messages inside the 24-hour window; mentions where the network allows. */
function replyability(kind: InboxKind, platform: string, createdAtNetwork: Date, now = new Date()): { canReply: boolean; replyWindowEndsAt: Date | null; replyBlockedReason: string | null } {
  if (kind === "message") {
    const window = replyWindow(createdAtNetwork, now);
    return { canReply: window.canReply, replyWindowEndsAt: window.replyWindowEndsAt, replyBlockedReason: window.canReply ? null : WINDOW_CLOSED_MESSAGE };
  }
  if (kind === "mention") {
    const support = mentionReplySupport(platform as Platform);
    return { canReply: support.supported, replyWindowEndsAt: null, replyBlockedReason: support.reason };
  }
  return { canReply: true, replyWindowEndsAt: null, replyBlockedReason: null };
}

async function loadItems(workspaceId: string, where: SQL[], limit: number) {
  const rows = await db
    .select({
      kind: inboxItemsTable.kind,
      threadId: inboxItemsTable.threadId,
      permalink: inboxItemsTable.permalink,
      id: inboxItemsTable.id,
      accountId: inboxItemsTable.connectedAccountId,
      accountName: connectedAccountsTable.displayName,
      accountAvatar: connectedAccountsTable.avatarUrl,
      platform: inboxItemsTable.platform,
      postId: postTargetsTable.postId,
      postTargetId: inboxItemsTable.postTargetId,
      externalId: inboxItemsTable.externalId,
      parentExternalId: inboxItemsTable.parentExternalId,
      authorName: inboxItemsTable.authorName,
      authorAvatar: inboxItemsTable.authorAvatar,
      body: inboxItemsTable.body,
      createdAtNetwork: inboxItemsTable.createdAtNetwork,
      status: inboxItemsTable.status,
      readAt: inboxItemsTable.readAt,
      assignedToUserId: inboxItemsTable.assignedToUserId,
      assignedToName: usersTable.displayName,
      assignedToEmail: usersTable.email,
      replied: inboxItemsTable.replied,
    })
    .from(inboxItemsTable)
    .innerJoin(connectedAccountsTable, eq(connectedAccountsTable.id, inboxItemsTable.connectedAccountId))
    .leftJoin(postTargetsTable, eq(postTargetsTable.id, inboxItemsTable.postTargetId))
    .leftJoin(usersTable, eq(usersTable.id, inboxItemsTable.assignedToUserId))
    .where(and(eq(inboxItemsTable.workspaceId, workspaceId), ...where))
    .orderBy(desc(inboxItemsTable.createdAtNetwork), desc(inboxItemsTable.id))
    .limit(limit);
  const replies = rows.length
    ? await db.select().from(inboxRepliesTable).where(inArray(inboxRepliesTable.itemId, rows.map((row) => row.id))).orderBy(inboxRepliesTable.createdAt)
    : [];
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    threadId: row.threadId,
    permalink: row.permalink,
    ...replyability(row.kind, row.platform, row.createdAtNetwork),
    accountId: row.accountId,
    accountName: row.accountName,
    accountAvatar: row.accountAvatar,
    platform: row.platform,
    postId: row.postId ?? null,
    postTargetId: row.postTargetId,
    externalId: row.externalId,
    parentExternalId: row.parentExternalId,
    authorName: row.authorName,
    authorAvatar: row.authorAvatar,
    body: row.body,
    createdAtNetwork: row.createdAtNetwork,
    status: row.status,
    read: row.readAt !== null,
    readAt: row.readAt,
    assignedToUserId: row.assignedToUserId,
    assignedToName: row.assignedToUserId ? row.assignedToName ?? row.assignedToEmail : null,
    replied: row.replied,
    replies: replies.filter((reply) => reply.itemId === row.id).map((reply) => ({ id: reply.id, userId: reply.userId, body: reply.body, status: reply.status, error: reply.error, externalId: reply.externalId, createdAt: reply.createdAt })),
  }));
}

const encodeCursor = (createdAt: Date, id: string) => Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
function decodeCursor(value: string): { at: string; id: string } | null {
  const [at, id] = Buffer.from(value, "base64url").toString().split("|");
  if (!at || !id || Number.isNaN(new Date(at).getTime()) || !UUID.test(id)) return null;
  return { at, id };
}

router.get("/inbox", async (req, res): Promise<void> => {
  const ctx = await requireInbox(req, res, "inbox:read");
  if (!ctx) return;
  const q = req.query;
  const where: SQL[] = [visibleItem];
  if (typeof q.kind === "string" && q.kind) {
    if (!(inboxKinds as readonly string[]).includes(q.kind)) return jsonError(res, 400, "invalid_query", "Kind must be comment, message or mention.");
    where.push(eq(inboxItemsTable.kind, q.kind as InboxKind));
  }
  if (typeof q.status === "string" && q.status) {
    if (q.status !== "open" && q.status !== "resolved") return jsonError(res, 400, "invalid_query", "Status must be open or resolved.");
    where.push(eq(inboxItemsTable.status, q.status));
  }
  if (typeof q.platform === "string" && q.platform) {
    if (!(platforms as readonly string[]).includes(q.platform)) return jsonError(res, 400, "invalid_query", "Unknown platform.");
    where.push(eq(inboxItemsTable.platform, q.platform));
  }
  if (typeof q.accountId === "string" && q.accountId) {
    if (!UUID.test(q.accountId)) return jsonError(res, 400, "invalid_query", "Unknown account.");
    where.push(eq(inboxItemsTable.connectedAccountId, q.accountId));
  }
  if (typeof q.assigned === "string" && q.assigned) {
    if (q.assigned !== "me") return jsonError(res, 400, "invalid_query", "Assigned can only be me.");
    where.push(eq(inboxItemsTable.assignedToUserId, ctx.userId));
  }
  if (q.unread === "true" || q.unread === "1") where.push(isNull(inboxItemsTable.readAt));
  let limit = PAGE_SIZE;
  if (typeof q.limit === "string" && q.limit) {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return jsonError(res, 400, "invalid_query", `Limit must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  if (typeof q.cursor === "string" && q.cursor) {
    const cursor = decodeCursor(q.cursor);
    if (!cursor) return jsonError(res, 400, "invalid_query", "That page marker isn't valid.");
    where.push(sql`(${inboxItemsTable.createdAtNetwork}, ${inboxItemsTable.id}) < (${new Date(cursor.at)}, ${cursor.id})`);
  }
  const rows = await loadItems(ctx.workspaceId, where, limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  res.json({ items: page, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAtNetwork, last.id) : null });
});

router.get("/inbox/summary", async (req, res): Promise<void> => {
  const ctx = await requireInbox(req, res, "inbox:read");
  if (!ctx) return;
  const counts = await db
    .select({
      accountId: inboxItemsTable.connectedAccountId,
      // count(case when ... then 1 end) counts only the rows the condition holds for.
      open: sql<number>`count(case when ${inboxItemsTable.status} = 'open' then 1 end)`,
      resolved: sql<number>`count(case when ${inboxItemsTable.status} = 'resolved' then 1 end)`,
      unread: sql<number>`count(case when ${inboxItemsTable.status} = 'open' and ${inboxItemsTable.readAt} is null then 1 end)`,
      mine: sql<number>`count(case when ${inboxItemsTable.status} = 'open' and ${inboxItemsTable.assignedToUserId} = ${ctx.userId} then 1 end)`,
    })
    .from(inboxItemsTable)
    .where(and(eq(inboxItemsTable.workspaceId, ctx.workspaceId), visibleItem))
    .groupBy(inboxItemsTable.connectedAccountId);
  const byAccount = new Map(counts.map((row) => [row.accountId, row]));
  const kindCounts = await db
    .select({
      kind: inboxItemsTable.kind,
      open: sql<number>`count(case when ${inboxItemsTable.status} = 'open' then 1 end)`,
      unread: sql<number>`count(case when ${inboxItemsTable.status} = 'open' and ${inboxItemsTable.readAt} is null then 1 end)`,
    })
    .from(inboxItemsTable)
    .where(and(eq(inboxItemsTable.workspaceId, ctx.workspaceId), visibleItem))
    .groupBy(inboxItemsTable.kind);
  const kinds = Object.fromEntries(inboxKinds.map((kind) => {
    const row = kindCounts.find((r) => r.kind === kind);
    return [kind, { open: row?.open ?? 0, unread: row?.unread ?? 0 }];
  }));
  const accounts = await db
    .select({ account: connectedAccountsTable, lastSyncedAt: inboxSyncTable.lastSyncedAt, lastError: inboxSyncTable.lastError, messagesError: inboxSyncTable.messagesError, mentionsError: inboxSyncTable.mentionsError, messagesSyncedAt: inboxSyncTable.messagesSyncedAt, mentionsSyncedAt: inboxSyncTable.mentionsSyncedAt })
    .from(connectedAccountsTable)
    .leftJoin(inboxSyncTable, eq(inboxSyncTable.connectedAccountId, connectedAccountsTable.id))
    .where(eq(connectedAccountsTable.workspaceId, ctx.workspaceId))
    .orderBy(connectedAccountsTable.createdAt);
  res.json({
    open: counts.reduce((sum, row) => sum + row.open, 0),
    resolved: counts.reduce((sum, row) => sum + row.resolved, 0),
    unread: counts.reduce((sum, row) => sum + row.unread, 0),
    assignedToMe: counts.reduce((sum, row) => sum + row.mine, 0),
    kinds,
    accounts: accounts.map(({ account, lastSyncedAt, lastError, messagesError, mentionsError, messagesSyncedAt, mentionsSyncedAt }) => {
      const availability = accountAvailability(account);
      const own = byAccount.get(account.id);
      const messaging = messagingAvailability(account);
      const mentions = mentionsAvailability(account);
      const mentionReply = mentionReplySupport(account.platform as Platform);
      return {
        // Direct messages: replies are only possible within 24 hours of the person's last message (each conversation says when its window closes).
        messaging: {
          state: messaging.state,
          reason: messaging.reason,
          replyWindowHours: messaging.state === "unavailable" ? null : MESSAGE_WINDOW_MS / 3_600_000,
          lastSyncedAt: messagesSyncedAt ?? null,
          lastError: messaging.state === "available" ? messagesError ?? null : null,
        },
        mentions: {
          state: mentions.state,
          reason: mentions.reason,
          canReply: mentions.state === "available" && mentionReply.supported,
          replyNote: mentions.state === "unavailable" ? null : mentionReply.reason,
          lastSyncedAt: mentionsSyncedAt ?? null,
          lastError: mentions.state === "available" ? mentionsError ?? null : null,
        },
        accountId: account.id,
        platform: account.platform,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
        state: availability.state,
        reason: availability.reason,
        lastSyncedAt: lastSyncedAt ?? null,
        // A collection problem (for example a network outage) shown next to accounts that are otherwise fine.
        lastError: availability.state === "available" ? lastError ?? null : null,
        open: own?.open ?? 0,
        unread: own?.unread ?? 0,
      };
    }),
  });
});

/** Reads the networks now instead of waiting for the next scheduled pass. */
router.post("/inbox/refresh", refreshLimiter, async (req, res): Promise<void> => {
  const ctx = await requireInbox(req, res, "inbox:manage");
  if (!ctx) return;
  const accountId = typeof req.body?.accountId === "string" && UUID.test(req.body.accountId) ? req.body.accountId : undefined;
  const outcomes = await collectWorkspace(ctx.workspaceId, { accountIds: accountId ? [accountId] : undefined });
  res.json({ results: outcomes.map((outcome) => ({ accountId: outcome.accountId, state: outcome.state, ok: outcome.ok, postsRead: outcome.postsRead, newItems: outcome.newItems, reason: outcome.reason, ...(outcome.newMessages !== undefined ? { newMessages: outcome.newMessages, newMentions: outcome.newMentions ?? 0, messagesReason: outcome.messagesReason ?? null, mentionsReason: outcome.mentionsReason ?? null } : {}) })) });
});

/** One conversation, oldest message first, with whether it can be answered now. */
router.get("/inbox/threads/:threadId", async (req, res): Promise<void> => {
  const ctx = await requireInbox(req, res, "inbox:read");
  if (!ctx) return;
  const threadId = String(req.params.threadId);
  const where = [eq(inboxItemsTable.workspaceId, ctx.workspaceId), eq(inboxItemsTable.kind, "message"), eq(inboxItemsTable.threadId, threadId)];
  if (typeof req.query.accountId === "string" && req.query.accountId) {
    if (!UUID.test(req.query.accountId)) return jsonError(res, 400, "invalid_query", "Unknown account.");
    where.push(eq(inboxItemsTable.connectedAccountId, req.query.accountId));
  }
  const rows = await db
    .select({ item: inboxItemsTable, accountName: connectedAccountsTable.displayName, accountAvatar: connectedAccountsTable.avatarUrl })
    .from(inboxItemsTable)
    .innerJoin(connectedAccountsTable, eq(connectedAccountsTable.id, inboxItemsTable.connectedAccountId))
    .where(and(...where))
    .orderBy(inboxItemsTable.createdAtNetwork, inboxItemsTable.id);
  const first = rows[0];
  if (!first) return jsonError(res, 404, "not_found", "That conversation doesn't exist.");
  const items = rows.filter((row) => row.item.connectedAccountId === first.item.connectedAccountId).map((row) => row.item);
  const inbound = items.filter((item) => !item.fromPage);
  const head = inbound[inbound.length - 1] ?? null;
  const window = replyWindow(head ? head.createdAtNetwork : null);
  res.json({
    threadId,
    accountId: first.item.connectedAccountId,
    accountName: first.accountName,
    accountAvatar: first.accountAvatar,
    platform: first.item.platform,
    participantName: inbound[0]?.authorName ?? null,
    itemId: head?.id ?? null,
    status: head?.status ?? "open",
    canReply: window.canReply,
    replyWindowEndsAt: window.replyWindowEndsAt,
    replyBlockedReason: window.canReply ? null : WINDOW_CLOSED_MESSAGE,
    messages: items.map((item) => ({ id: item.id, externalId: item.externalId, authorName: item.authorName, body: item.body, createdAtNetwork: item.createdAtNetwork, fromPage: item.fromPage })),
  });
});

router.patch("/inbox/:id", async (req, res): Promise<void> => {
  const ctx = await requireInbox(req, res, "inbox:manage");
  if (!ctx) return;
  const id = String(req.params.id);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "That comment doesn't exist.");
  const body = (req.body ?? {}) as Record<string, unknown>;
  const set: Partial<typeof inboxItemsTable.$inferInsert> = {};
  if ("read" in body) {
    if (typeof body.read !== "boolean") return jsonError(res, 400, "invalid_body", "Read must be true or false.");
    set.readAt = body.read ? new Date() : null;
  }
  if ("status" in body) {
    if (body.status !== "open" && body.status !== "resolved") return jsonError(res, 400, "invalid_body", "Status must be open or resolved.");
    set.status = body.status;
  }
  if ("assignedToUserId" in body) {
    const target = body.assignedToUserId;
    if (target !== null && (typeof target !== "string" || !UUID.test(target))) return jsonError(res, 400, "invalid_body", "Pick a member of this workspace, or null to unassign.");
    if (target !== null) {
      const [member] = await db.select({ id: workspaceMembersTable.id }).from(workspaceMembersTable).where(and(eq(workspaceMembersTable.workspaceId, ctx.workspaceId), eq(workspaceMembersTable.userId, target))).limit(1);
      if (!member) return jsonError(res, 400, "invalid_body", "That person isn't a member of this workspace.");
    }
    set.assignedToUserId = target;
  }
  if (Object.keys(set).length === 0) return jsonError(res, 400, "invalid_body", "Send read, status or assignedToUserId.");
  const [existing] = await db.select({ status: inboxItemsTable.status, assignedToUserId: inboxItemsTable.assignedToUserId, kind: inboxItemsTable.kind, threadId: inboxItemsTable.threadId, connectedAccountId: inboxItemsTable.connectedAccountId }).from(inboxItemsTable).where(and(eq(inboxItemsTable.id, id), eq(inboxItemsTable.workspaceId, ctx.workspaceId))).limit(1);
  if (!existing) return jsonError(res, 404, "not_found", "That comment doesn't exist.");
  // A conversation is worked as a whole: status, read mark and assignment apply to all of the other person's messages in it.
  const scope = existing.kind === "message" && existing.threadId
    ? and(eq(inboxItemsTable.connectedAccountId, existing.connectedAccountId), eq(inboxItemsTable.threadId, existing.threadId), eq(inboxItemsTable.fromPage, false), eq(inboxItemsTable.workspaceId, ctx.workspaceId))
    : and(eq(inboxItemsTable.id, id), eq(inboxItemsTable.workspaceId, ctx.workspaceId));
  await db.update(inboxItemsTable).set(set).where(scope);
  if (set.status && set.status !== existing.status) await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: set.status === "resolved" ? "inbox.resolved" : "inbox.reopened", target: id });
  if ("assignedToUserId" in set && set.assignedToUserId !== existing.assignedToUserId) await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "inbox.assigned", target: id, detail: { assignedToUserId: set.assignedToUserId ?? null } });
  const [item] = await loadItems(ctx.workspaceId, [eq(inboxItemsTable.id, id)], 1);
  res.json(item);
});

router.post("/inbox/:id/reply", async (req, res): Promise<void> => {
  const ctx = await requireInbox(req, res, "inbox:reply");
  if (!ctx) return;
  const id = String(req.params.id);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "That comment doesn't exist.");
  const text = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!text) return jsonError(res, 400, "invalid_body", "Write a reply first.");
  const [item] = await db.select({ platform: inboxItemsTable.platform, kind: inboxItemsTable.kind }).from(inboxItemsTable).where(and(eq(inboxItemsTable.id, id), eq(inboxItemsTable.workspaceId, ctx.workspaceId))).limit(1);
  if (!item) return jsonError(res, 404, "not_found", "That comment doesn't exist.");
  const max = (item.kind === "message" ? MESSAGE_MAX_LENGTH : REPLY_MAX_LENGTH)[item.platform as Platform] ?? 0;
  if (max > 0 && text.length > max) return jsonError(res, 400, "invalid_body", `Replies on this network can be up to ${max} characters.`);
  const result = await sendReply({ workspaceId: ctx.workspaceId, userId: ctx.userId, itemId: id, text });
  if (result.kind === "not_found") return jsonError(res, 404, "not_found", "That comment doesn't exist.");
  // 409: the account can't answer right now (permission_needed, unavailable, reconnect, or window_closed for a message outside Meta's 24-hour window); the reason says what to do and nothing was sent.
  if (result.kind === "blocked") return jsonError(res, 409, result.state, result.reason);
  if (result.kind === "failed") return jsonError(res, 502, "reply_failed", result.message);
  await recordAudit({ workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "inbox.replied", target: id, detail: { platform: item.platform } });
  const reply = result.reply;
  res.status(201).json({ id: reply.id, userId: reply.userId, body: reply.body, status: reply.status, error: reply.error, externalId: reply.externalId, createdAt: reply.createdAt });
});

export default router;
