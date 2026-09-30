import { and, asc, eq, inArray } from "drizzle-orm";
import { accountQueuesTable, connectedAccountsTable, db, postTargetsTable, postsTable, queueSlotsTable, type AccountQueue, type QueueSlot } from "@workspace/db";
import { addDays, formatMinute, zonedParts, zonedToUtc } from "./time";

/*
 * Posting queues. Each connected account has a weekly set of slots ("Mon 09:00, Mon 15:00, ...") in a time zone.
 * "Add to queue" finds the next slot that no scheduled post already occupies and schedules the post there. A post
 * going to several accounts takes the earliest free slot among those accounts' queues, so it lands in exactly one
 * slot and still goes to every account at that time.
 */

const LOOKAHEAD_DAYS = 8 * 7;

export type QueueView = { connectedAccountId: string; timezone: string; paused: boolean; slots: Array<{ id: string; weekday: number; time: string }> };

export async function loadQueues(accountIds: string[]): Promise<Map<string, { queue: AccountQueue | null; slots: QueueSlot[] }>> {
  const map = new Map<string, { queue: AccountQueue | null; slots: QueueSlot[] }>();
  if (accountIds.length === 0) return map;
  for (const id of accountIds) map.set(id, { queue: null, slots: [] });
  const queues = await db.select().from(accountQueuesTable).where(inArray(accountQueuesTable.connectedAccountId, accountIds));
  for (const queue of queues) map.get(queue.connectedAccountId)!.queue = queue;
  const slots = await db.select().from(queueSlotsTable).where(inArray(queueSlotsTable.connectedAccountId, accountIds)).orderBy(asc(queueSlotsTable.weekday), asc(queueSlotsTable.minuteOfDay));
  for (const slot of slots) map.get(slot.connectedAccountId)!.slots.push(slot);
  return map;
}

export function serializeQueue(accountId: string, queue: AccountQueue | null, slots: QueueSlot[]): QueueView {
  return {
    connectedAccountId: accountId,
    timezone: queue?.timezone ?? "UTC",
    paused: queue?.paused ?? false,
    slots: slots.map((slot) => ({ id: slot.id, weekday: slot.weekday, time: formatMinute(slot.minuteOfDay) })),
  };
}

/** Every slot instant for one queue after `after`, in order, for the next eight weeks. */
export function upcomingSlotInstants(timezone: string, slots: Array<{ weekday: number; minuteOfDay: number }>, after: Date, limit = 200): Date[] {
  if (slots.length === 0) return [];
  const start = zonedParts(after, timezone);
  const result: Date[] = [];
  let day = { year: start.year, month: start.month, day: start.day };
  for (let offset = 0; offset < LOOKAHEAD_DAYS && result.length < limit; offset += 1) {
    const current = addDays(day.year, day.month, day.day, 0);
    const weekday = (start.weekday + offset) % 7;
    for (const slot of slots.filter((candidate) => candidate.weekday === weekday).sort((a, b) => a.minuteOfDay - b.minuteOfDay)) {
      const instant = zonedToUtc(current.year, current.month, current.day, slot.minuteOfDay, timezone);
      if (instant.getTime() > after.getTime() && result.length < limit) result.push(instant);
    }
    day = addDays(day.year, day.month, day.day, 1);
  }
  return result;
}

/** Instants already taken by scheduled or in-flight posts going to any of these accounts. */
async function takenInstants(accountIds: string[]): Promise<Set<number>> {
  if (accountIds.length === 0) return new Set();
  const rows = await db
    .select({ scheduledAt: postsTable.scheduledAt })
    .from(postTargetsTable)
    .innerJoin(postsTable, eq(postsTable.id, postTargetsTable.postId))
    .where(and(inArray(postTargetsTable.connectedAccountId, accountIds), inArray(postsTable.status, ["scheduled", "publishing"])));
  return new Set(rows.map((row) => row.scheduledAt?.getTime()).filter((value): value is number => typeof value === "number"));
}

export type NextSlot = { at: Date; connectedAccountId: string };

/**
 * The next free slot among the given accounts' queues, or a reason there isn't one. `exceptPostId` lets a post
 * being re-queued ignore its own current slot.
 */
export async function nextFreeSlot(workspaceId: string, accountIds: string[], after = new Date()): Promise<{ ok: true; slot: NextSlot } | { ok: false; message: string }> {
  const accounts = await db
    .select({ id: connectedAccountsTable.id, name: connectedAccountsTable.displayName })
    .from(connectedAccountsTable)
    .where(and(eq(connectedAccountsTable.workspaceId, workspaceId), inArray(connectedAccountsTable.id, accountIds)));
  if (accounts.length === 0) return { ok: false, message: "Choose at least one account to queue this post for." };
  const queues = await loadQueues(accounts.map((account) => account.id));
  const taken = await takenInstants(accounts.map((account) => account.id));
  let best: NextSlot | null = null;
  const withoutQueue: string[] = [];
  const paused: string[] = [];
  for (const account of accounts) {
    const { queue, slots } = queues.get(account.id)!;
    if (!queue || slots.length === 0) { withoutQueue.push(account.name); continue; }
    if (queue.paused) { paused.push(account.name); continue; }
    const free = upcomingSlotInstants(queue.timezone, slots, after).find((instant) => !taken.has(instant.getTime()));
    if (free && (!best || free.getTime() < best.at.getTime())) best = { at: free, connectedAccountId: account.id };
  }
  if (best) return { ok: true, slot: best };
  if (withoutQueue.length > 0 && paused.length === 0) return { ok: false, message: `${withoutQueue.join(", ")} ${withoutQueue.length === 1 ? "has" : "have"} no posting schedule yet. Add time slots on the Queue page first.` };
  if (paused.length > 0 && withoutQueue.length === 0) return { ok: false, message: `The queue for ${paused.join(", ")} is paused. Resume it or pick a time.` };
  if (paused.length > 0) return { ok: false, message: `${paused.join(", ")}: queue paused. ${withoutQueue.join(", ")}: no posting schedule.` };
  return { ok: false, message: "Every slot in the next eight weeks is taken. Add more time slots or pick a time." };
}

/** The next few free slots for one account, for showing "your next posts would go out at…". */
export async function previewSlots(accountId: string, count = 5, after = new Date()): Promise<Date[]> {
  const { queue, slots } = (await loadQueues([accountId])).get(accountId)!;
  if (!queue || queue.paused || slots.length === 0) return [];
  const taken = await takenInstants([accountId]);
  return upcomingSlotInstants(queue.timezone, slots, after).filter((instant) => !taken.has(instant.getTime())).slice(0, count);
}
