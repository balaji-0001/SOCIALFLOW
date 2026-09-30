import { and, asc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { accountQueuesTable, connectedAccountsTable, db, postTargetsTable, postsTable, queueSlotsTable } from "@workspace/db";
import { jsonError } from "../lib/http-errors";
import { loadQueues, previewSlots, serializeQueue } from "../lib/queue";
import { requireAccess } from "../lib/access";
import type { WorkspaceContext } from "../lib/session";
import { isValidTimeZone, parseMinute } from "../lib/time";
import { serializePosts } from "./posts";

/* Posting queues: per-account weekly time slots, the posts waiting in them, and reordering. */

const router: IRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SLOTS = 70;

async function requireWorkspace(req: Request, res: Response): Promise<WorkspaceContext | null> {
  return requireAccess(req, res, req.method === "GET" ? "posts:read" : "queues:manage");
}

async function ownAccount(workspaceId: string, accountId: string): Promise<boolean> {
  if (!UUID.test(accountId)) return false;
  const [row] = await db.select({ id: connectedAccountsTable.id }).from(connectedAccountsTable).where(and(eq(connectedAccountsTable.id, accountId), eq(connectedAccountsTable.workspaceId, workspaceId))).limit(1);
  return Boolean(row);
}

/** Every account's queue, in one call for the Queue page. */
router.get("/queues", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const accounts = await db.select({ id: connectedAccountsTable.id }).from(connectedAccountsTable).where(eq(connectedAccountsTable.workspaceId, ctx.workspaceId));
  const queues = await loadQueues(accounts.map((account) => account.id));
  res.json({ queues: accounts.map((account) => { const { queue, slots } = queues.get(account.id)!; return serializeQueue(account.id, queue, slots); }) });
});

router.get("/queues/:accountId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const accountId = String(req.params.accountId);
  if (!(await ownAccount(ctx.workspaceId, accountId))) return jsonError(res, 404, "not_found", "Account not found.");
  const { queue, slots } = (await loadQueues([accountId])).get(accountId)!;
  const next = await previewSlots(accountId, 5);
  res.json({ ...serializeQueue(accountId, queue, slots), nextSlots: next.map((date) => date.toISOString()) });
});

/** Replaces an account's schedule: time zone, paused flag and the full slot list. */
router.put("/queues/:accountId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const accountId = String(req.params.accountId);
  if (!(await ownAccount(ctx.workspaceId, accountId))) return jsonError(res, 404, "not_found", "Account not found.");
  const timezone = req.body?.timezone;
  if (!isValidTimeZone(timezone)) return jsonError(res, 400, "invalid_queue", "Pick a valid time zone (for example Asia/Kolkata).");
  const paused = req.body?.paused === true;
  const rawSlots = req.body?.slots;
  if (!Array.isArray(rawSlots) || rawSlots.length > MAX_SLOTS) return jsonError(res, 400, "invalid_queue", `Slots must be a list of up to ${MAX_SLOTS} entries.`);
  const seen = new Set<string>();
  const slots: Array<{ weekday: number; minuteOfDay: number }> = [];
  for (const raw of rawSlots) {
    const weekday = Number(raw?.weekday);
    const minute = parseMinute(raw?.time);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || minute === null) return jsonError(res, 400, "invalid_queue", "Each slot needs a weekday (0 = Sunday … 6 = Saturday) and a time like 09:00.");
    const key = `${weekday}:${minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push({ weekday, minuteOfDay: minute });
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(accountQueuesTable)
      .values({ connectedAccountId: accountId, timezone, paused, updatedAt: new Date() })
      .onConflictDoUpdate({ target: accountQueuesTable.connectedAccountId, set: { timezone, paused, updatedAt: new Date() } });
    await tx.delete(queueSlotsTable).where(eq(queueSlotsTable.connectedAccountId, accountId));
    if (slots.length > 0) await tx.insert(queueSlotsTable).values(slots.map((slot) => ({ connectedAccountId: accountId, ...slot })));
  });
  const { queue, slots: saved } = (await loadQueues([accountId])).get(accountId)!;
  const next = await previewSlots(accountId, 5);
  res.json({ ...serializeQueue(accountId, queue, saved), nextSlots: next.map((date) => date.toISOString()) });
});

/** The posts waiting in an account's queue, soonest first. */
router.get("/queues/:accountId/posts", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const accountId = String(req.params.accountId);
  if (!(await ownAccount(ctx.workspaceId, accountId))) return jsonError(res, 404, "not_found", "Account not found.");
  const rows = await db
    .select({ post: postsTable })
    .from(postTargetsTable)
    .innerJoin(postsTable, eq(postsTable.id, postTargetsTable.postId))
    .where(and(eq(postTargetsTable.connectedAccountId, accountId), eq(postsTable.status, "scheduled")))
    .orderBy(asc(postsTable.scheduledAt));
  res.json({ posts: await serializePosts(rows.map((row) => row.post)) });
});

/**
 * Reorders the queued posts of an account: the posts keep the same set of times, handed out in the new order.
 * Body: { postIds: [...] } listing every scheduled post of the account in the wanted order.
 */
router.post("/queues/:accountId/reorder", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const accountId = String(req.params.accountId);
  if (!(await ownAccount(ctx.workspaceId, accountId))) return jsonError(res, 404, "not_found", "Account not found.");
  const order = req.body?.postIds;
  if (!Array.isArray(order) || order.some((id) => typeof id !== "string" || !UUID.test(id))) return jsonError(res, 400, "invalid_queue", "postIds must list the queued posts in order.");
  const current = await db
    .select({ id: postsTable.id, scheduledAt: postsTable.scheduledAt })
    .from(postTargetsTable)
    .innerJoin(postsTable, eq(postsTable.id, postTargetsTable.postId))
    .where(and(eq(postTargetsTable.connectedAccountId, accountId), eq(postsTable.status, "scheduled"), eq(postsTable.workspaceId, ctx.workspaceId), inArray(postsTable.id, order as string[])));
  if (current.length !== order.length || current.length !== new Set(order).size) return jsonError(res, 400, "invalid_queue", "The queue changed. Refresh and try again.");
  const times = current.map((row) => row.scheduledAt!).sort((a, b) => a.getTime() - b.getTime());
  await db.transaction(async (tx) => {
    for (const [index, postId] of (order as string[]).entries()) {
      await tx.update(postsTable).set({ scheduledAt: times[index]! }).where(and(eq(postsTable.id, postId), eq(postsTable.status, "scheduled")));
    }
  });
  const rows = await db
    .select({ post: postsTable })
    .from(postTargetsTable)
    .innerJoin(postsTable, eq(postsTable.id, postTargetsTable.postId))
    .where(and(eq(postTargetsTable.connectedAccountId, accountId), eq(postsTable.status, "scheduled")))
    .orderBy(asc(postsTable.scheduledAt));
  res.json({ posts: await serializePosts(rows.map((row) => row.post)) });
});

export default router;
