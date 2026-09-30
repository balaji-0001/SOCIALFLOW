import { and, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import {
  connectedAccountsTable,
  db,
  mediaTable,
  postMediaTable,
  postTargetsTable,
  postsTable,
  recurrencesTable,
  tagsTable,
  type Recurrence,
} from "@workspace/db";
import { logger } from "./logger";
import { writePostExtras, type PlatformContent } from "./post-extras";
import { addDays, dateKey, daysInMonth, parseDate, zonedParts, zonedToUtc } from "./time";

/*
 * Recurring posts. A rule describes when; each occurrence becomes a normal scheduled post ahead of time (one
 * week's horizon, so the calendar shows what's coming). The (recurrence_id, occurrence_index) unique index means the
 * same occurrence can never be created twice, even if two server instances materialize at the same moment.
 */

export const MATERIALIZE_HORIZON_MS = 7 * 24 * 3600_000;

export type Rule = Pick<Recurrence, "frequency" | "interval" | "weekdays" | "dayOfMonth" | "minuteOfDay" | "timezone" | "startDate" | "endDate" | "maxOccurrences">;

type Day = { year: number; month: number; day: number };

function dayMatches(rule: Rule, start: Day, candidate: Day): boolean {
  if (rule.frequency === "daily") {
    const diff = Math.round((Date.UTC(candidate.year, candidate.month - 1, candidate.day) - Date.UTC(start.year, start.month - 1, start.day)) / 86_400_000);
    return diff % rule.interval === 0;
  }
  if (rule.frequency === "weekly") {
    const weekday = new Date(Date.UTC(candidate.year, candidate.month - 1, candidate.day)).getUTCDay();
    if (!rule.weekdays.includes(weekday)) return false;
    // Weeks are counted from the Sunday on or before the start date.
    const startSunday = Date.UTC(start.year, start.month - 1, start.day - new Date(Date.UTC(start.year, start.month - 1, start.day)).getUTCDay());
    const weeks = Math.floor((Date.UTC(candidate.year, candidate.month - 1, candidate.day) - startSunday) / (7 * 86_400_000));
    return weeks % rule.interval === 0;
  }
  const wanted = Math.min(rule.dayOfMonth ?? start.day, daysInMonth(candidate.year, candidate.month));
  if (candidate.day !== wanted) return false;
  const months = (candidate.year - start.year) * 12 + (candidate.month - start.month);
  return months % rule.interval === 0;
}

/**
 * The first occurrence strictly after `after` (or the first occurrence at all when `after` is null), honouring the
 * start and end dates. Returns null when the rule has no more occurrences.
 */
export function nextOccurrence(rule: Rule, after: Date | null): Date | null {
  const start = parseDate(rule.startDate);
  if (!start) return null;
  const end = rule.endDate ? parseDate(rule.endDate) : null;
  let day: Day = start;
  if (after) {
    const parts = zonedParts(after, rule.timezone);
    const afterDay = { year: parts.year, month: parts.month, day: parts.day };
    if (dateKey(afterDay) > dateKey(start)) day = afterDay;
  }
  for (let i = 0; i < 366 * 3; i += 1) {
    if (end && dateKey(day) > dateKey(end)) return null;
    if (dayMatches(rule, start, day)) {
      const instant = zonedToUtc(day.year, day.month, day.day, rule.minuteOfDay, rule.timezone);
      if (!after || instant.getTime() > after.getTime()) return instant;
    }
    day = addDays(day.year, day.month, day.day, 1);
  }
  return null;
}

/** The next `count` occurrences after `after`, for previews. */
export function upcomingOccurrences(rule: Rule, after: Date, count: number): Date[] {
  const result: Date[] = [];
  let cursor: Date | null = after;
  while (result.length < count) {
    const next: Date | null = nextOccurrence(rule, cursor);
    if (!next) break;
    result.push(next);
    cursor = next;
  }
  return result;
}

function finished(rule: Recurrence): boolean {
  return rule.maxOccurrences !== null && rule.occurrencesCreated >= rule.maxOccurrences;
}

/**
 * Creates the next occurrence of one recurrence as a scheduled post, if it is due within the horizon. Returns the
 * new post's ID, or null when nothing was created. Idempotent thanks to the unique occurrence index.
 */
export async function materializeNext(rule: Recurrence, now = new Date()): Promise<string | null> {
  if (rule.paused || finished(rule) || !rule.nextRunAt || rule.nextRunAt.getTime() > now.getTime() + MATERIALIZE_HORIZON_MS) return null;
  const at = rule.nextRunAt;
  const index = rule.occurrencesCreated;
  const following = finished({ ...rule, occurrencesCreated: index + 1 }) ? null : nextOccurrence(rule, at);

  // Accounts, media and tags may have been removed since the rule was made; occurrences carry what still exists.
  const accounts = rule.connectedAccountIds.length > 0
    ? await db.select({ id: connectedAccountsTable.id }).from(connectedAccountsTable).where(and(eq(connectedAccountsTable.workspaceId, rule.workspaceId), inArray(connectedAccountsTable.id, rule.connectedAccountIds)))
    : [];
  const media = rule.mediaIds.length > 0
    ? await db.select({ id: mediaTable.id }).from(mediaTable).where(and(eq(mediaTable.workspaceId, rule.workspaceId), inArray(mediaTable.id, rule.mediaIds)))
    : [];
  const tags = rule.tagIds.length > 0
    ? await db.select({ id: tagsTable.id }).from(tagsTable).where(and(eq(tagsTable.workspaceId, rule.workspaceId), inArray(tagsTable.id, rule.tagIds)))
    : [];
  const mediaOrder = rule.mediaIds.filter((id) => media.some((row) => row.id === id));
  // A past occurrence (the server was down) is created as failed rather than sent late, matching missed posts.
  const late = at.getTime() < now.getTime() - 60 * 60_000;

  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(postsTable)
      .values({
        workspaceId: rule.workspaceId,
        createdByUserId: rule.createdByUserId,
        content: rule.content,
        firstComment: rule.firstComment,
        status: late ? "failed" : "scheduled",
        scheduledAt: at,
        recurrenceId: rule.id,
        occurrenceIndex: index,
      })
      .onConflictDoNothing()
      .returning({ id: postsTable.id });
    const post = inserted[0];
    // Either way the rule moves on, so a duplicate attempt doesn't re-create an occurrence the user deleted.
    await tx
      .update(recurrencesTable)
      .set({ occurrencesCreated: index + 1, nextRunAt: following })
      .where(and(eq(recurrencesTable.id, rule.id), eq(recurrencesTable.occurrencesCreated, index)));
    if (!post) return null;
    if (accounts.length > 0) {
      await tx.insert(postTargetsTable).values(accounts.map((account) => ({ postId: post.id, connectedAccountId: account.id, status: late ? "failed" as const : "scheduled" as const, errorMessage: late ? "This occurrence was missed while the server was offline. Publish it now or leave it." : null })));
    }
    if (mediaOrder.length > 0) await tx.insert(postMediaTable).values(mediaOrder.map((mediaId, position) => ({ postId: post.id, mediaId, position })));
    await writePostExtras(tx, post.id, { platformContent: rule.platformContent as PlatformContent, tagIds: tags.map((tag) => tag.id) });
    return post.id;
  });
  if (created) logger.info({ recurrenceId: rule.id, postId: created, index, at }, "Recurring post occurrence created");
  return created;
}

/** One pass over every active recurrence: creates occurrences due within the horizon. Returns how many were made. */
export async function materializeDueRecurrences(now = new Date()): Promise<number> {
  const due = await db
    .select()
    .from(recurrencesTable)
    .where(and(eq(recurrencesTable.paused, false), isNotNull(recurrencesTable.nextRunAt), lte(recurrencesTable.nextRunAt, new Date(now.getTime() + MATERIALIZE_HORIZON_MS))));
  let count = 0;
  for (let rule of due) {
    // A rule may have several occurrences inside the horizon (e.g. daily); create them all.
    for (let guard = 0; guard < 60; guard += 1) {
      const id = await materializeNext(rule, now);
      const [refreshed] = await db.select().from(recurrencesTable).where(eq(recurrencesTable.id, rule.id));
      if (!refreshed) break;
      rule = refreshed;
      if (id) count += 1;
      if (!rule.nextRunAt || rule.nextRunAt.getTime() > now.getTime() + MATERIALIZE_HORIZON_MS) break;
    }
  }
  return count;
}

/** Deletes a rule's future occurrences (scheduled posts not yet sent). Past and failed ones stay as history. */
export async function deleteFutureOccurrences(recurrenceId: string): Promise<number> {
  const rows = await db
    .delete(postsTable)
    .where(and(eq(postsTable.recurrenceId, recurrenceId), or(eq(postsTable.status, "scheduled"), eq(postsTable.status, "draft"))))
    .returning({ id: postsTable.id });
  return rows.length;
}

export const recurrenceMediaInUse = sql`exists (select 1 from socialflow_recurrences r where ${mediaTable.id} = any(r.media_ids))`;
