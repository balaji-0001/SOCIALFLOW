import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { connectedAccountsTable, db, postsTable, recurrenceFrequencies, recurrencesTable, type Recurrence, type RecurrenceFrequency } from "@workspace/db";
import { jsonError } from "../lib/http-errors";
import { mediaProblemForPlatforms } from "../lib/media-rules";
import { mediaTable } from "@workspace/db";
import { MAX_FIRST_COMMENT_LENGTH, parsePlatformContent, platformContentProblem, validateTagIds, type PlatformContent } from "../lib/post-extras";
import { deleteFutureOccurrences, materializeNext, nextOccurrence, upcomingOccurrences, type Rule } from "../lib/recurrence";
import type { Platform } from "../lib/oauth/types";
import { requireAccess } from "../lib/access";
import type { WorkspaceContext } from "../lib/session";
import { isValidTimeZone, parseDate, parseMinute, formatMinute } from "../lib/time";
import { serializePosts } from "./posts";

/* Recurring posts: the rule plus the template every occurrence is made from. */

const router: IRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireWorkspace(req: Request, res: Response): Promise<WorkspaceContext | null> {
  return requireAccess(req, res, req.method === "GET" ? "posts:read" : "posts:write");
}

export function serializeRecurrence(rule: Recurrence, now = new Date()) {
  return {
    id: rule.id,
    frequency: rule.frequency,
    interval: rule.interval,
    weekdays: rule.weekdays,
    dayOfMonth: rule.dayOfMonth,
    time: formatMinute(rule.minuteOfDay),
    timezone: rule.timezone,
    startDate: rule.startDate,
    endDate: rule.endDate,
    maxOccurrences: rule.maxOccurrences,
    occurrencesCreated: rule.occurrencesCreated,
    nextRunAt: rule.nextRunAt,
    paused: rule.paused,
    finished: rule.nextRunAt === null,
    content: rule.content,
    firstComment: rule.firstComment,
    platformContent: rule.platformContent,
    connectedAccountIds: rule.connectedAccountIds,
    mediaIds: rule.mediaIds,
    tagIds: rule.tagIds,
    upcoming: rule.paused || !rule.nextRunAt ? [] : upcomingOccurrences(rule, new Date(Math.max(now.getTime(), rule.nextRunAt.getTime() - 1)), Math.min(5, rule.maxOccurrences ? Math.max(0, rule.maxOccurrences - rule.occurrencesCreated) : 5)).map((date) => date.toISOString()),
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

type Parsed = {
  rule: Rule;
  content: string;
  firstComment: string | null;
  platformContent: PlatformContent;
  connectedAccountIds: string[];
  mediaIds: string[];
  tagIds: string[];
};

async function parseBody(workspaceId: string, body: Record<string, unknown>): Promise<{ ok: true; value: Parsed } | { ok: false; message: string }> {
  const fail = (message: string) => ({ ok: false as const, message });
  const frequency = String(body.frequency ?? "");
  if (!(recurrenceFrequencies as readonly string[]).includes(frequency)) return fail("Repeat must be daily, weekly or monthly.");
  const interval = body.interval === undefined ? 1 : Number(body.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) return fail("Repeat every 1 to 52 days, weeks or months.");
  const minuteOfDay = parseMinute(body.time);
  if (minuteOfDay === null) return fail("Pick a time like 09:00.");
  if (!isValidTimeZone(body.timezone)) return fail("Pick a valid time zone.");
  const start = parseDate(body.startDate);
  if (!start) return fail("Pick a start date (YYYY-MM-DD).");
  let endDate: string | null = null;
  if (body.endDate !== undefined && body.endDate !== null && body.endDate !== "") {
    const end = parseDate(body.endDate);
    if (!end) return fail("The end date must be YYYY-MM-DD.");
    if (String(body.endDate) < String(body.startDate)) return fail("The end date must be after the start date.");
    endDate = String(body.endDate);
  }
  let maxOccurrences: number | null = null;
  if (body.maxOccurrences !== undefined && body.maxOccurrences !== null && body.maxOccurrences !== "") {
    maxOccurrences = Number(body.maxOccurrences);
    if (!Number.isInteger(maxOccurrences) || maxOccurrences < 1 || maxOccurrences > 1000) return fail("Repetitions must be between 1 and 1000.");
  }
  let weekdays: number[] = [];
  if (frequency === "weekly") {
    if (!Array.isArray(body.weekdays) || body.weekdays.length === 0) return fail("Pick at least one weekday.");
    weekdays = [...new Set((body.weekdays as unknown[]).map(Number))];
    if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return fail("Weekdays are 0 (Sunday) to 6 (Saturday).");
  }
  let dayOfMonth: number | null = null;
  if (frequency === "monthly") {
    dayOfMonth = body.dayOfMonth === undefined || body.dayOfMonth === null ? start.day : Number(body.dayOfMonth);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return fail("Day of month must be 1 to 31.");
  }

  const content = typeof body.content === "string" ? body.content : "";
  if (content.length > 10_000) return fail("That post is too long.");
  const platformContent = parsePlatformContent(body.platformContent);
  if (!platformContent) return fail("Per-network text isn't valid.");
  const contentProblem = platformContentProblem(platformContent);
  if (contentProblem) return fail(contentProblem);
  if (content.trim().length === 0 && Object.keys(platformContent).length === 0) return fail("Write something to repeat.");
  let firstComment: string | null = null;
  if (typeof body.firstComment === "string" && body.firstComment.trim().length > 0) {
    if (body.firstComment.length > MAX_FIRST_COMMENT_LENGTH) return fail("The first comment is too long.");
    firstComment = body.firstComment;
  }

  const connectedAccountIds = Array.isArray(body.connectedAccountIds) ? [...new Set((body.connectedAccountIds as unknown[]).filter((id): id is string => typeof id === "string" && UUID.test(id)))] : [];
  if (connectedAccountIds.length === 0) return fail("Choose at least one account.");
  const accounts = await db
    .select({ id: connectedAccountsTable.id, status: connectedAccountsTable.status, name: connectedAccountsTable.displayName, platform: connectedAccountsTable.platform })
    .from(connectedAccountsTable)
    .where(and(eq(connectedAccountsTable.workspaceId, workspaceId), inArray(connectedAccountsTable.id, connectedAccountIds)));
  if (accounts.length !== connectedAccountIds.length) return fail("One or more selected accounts don't exist in this workspace.");
  const unhealthy = accounts.find((account) => account.status !== "active");
  if (unhealthy) return fail(`${unhealthy.name} needs to be reconnected before it can be used.`);

  const mediaIds = Array.isArray(body.mediaIds) ? (body.mediaIds as unknown[]).filter((id): id is string => typeof id === "string") : [];
  if (mediaIds.length > 0) {
    // Recurrence media may already be on an occurrence post, so only ownership and the count are checked here.
    const found = await db.select({ id: mediaTable.id, kind: mediaTable.kind, mimeType: mediaTable.mimeType, sizeBytes: mediaTable.sizeBytes }).from(mediaTable).where(and(eq(mediaTable.workspaceId, workspaceId), inArray(mediaTable.id, mediaIds)));
    if (found.length !== new Set(mediaIds).size) return fail("One or more files couldn't be found. Upload them again.");
    const problem = mediaProblemForPlatforms(accounts.map((account) => account.platform as Platform), found);
    if (problem) return fail(problem);
  } else {
    const problem = mediaProblemForPlatforms(accounts.map((account) => account.platform as Platform), []);
    if (problem) return fail(problem);
  }
  const tagIds = Array.isArray(body.tagIds) ? (body.tagIds as unknown[]).filter((id): id is string => typeof id === "string") : [];
  const tagProblem = await validateTagIds(workspaceId, tagIds);
  if (tagProblem) return fail(tagProblem);

  return {
    ok: true,
    value: {
      rule: { frequency: frequency as RecurrenceFrequency, interval, weekdays, dayOfMonth, minuteOfDay, timezone: body.timezone as string, startDate: String(body.startDate), endDate, maxOccurrences },
      content, firstComment, platformContent, connectedAccountIds, mediaIds, tagIds,
    },
  };
}

router.get("/recurrences", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const rows = await db.select().from(recurrencesTable).where(eq(recurrencesTable.workspaceId, ctx.workspaceId)).orderBy(desc(recurrencesTable.createdAt));
  res.json({ recurrences: rows.map((rule) => serializeRecurrence(rule)) });
});

/** Dry run: the first few dates a rule would post on. */
router.post("/recurrences/preview", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const frequency = String(body.frequency ?? "");
  const minuteOfDay = parseMinute(body.time);
  const start = parseDate(body.startDate);
  if (!(recurrenceFrequencies as readonly string[]).includes(frequency) || minuteOfDay === null || !start || !isValidTimeZone(body.timezone)) return res.json({ dates: [] }) as unknown as void;
  const rule: Rule = {
    frequency: frequency as RecurrenceFrequency,
    interval: Number(body.interval) >= 1 ? Math.min(52, Math.floor(Number(body.interval))) : 1,
    weekdays: Array.isArray(body.weekdays) ? (body.weekdays as unknown[]).map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6) : [],
    dayOfMonth: Number.isInteger(Number(body.dayOfMonth)) && Number(body.dayOfMonth) >= 1 ? Number(body.dayOfMonth) : start.day,
    minuteOfDay,
    timezone: body.timezone as string,
    startDate: String(body.startDate),
    endDate: typeof body.endDate === "string" && parseDate(body.endDate) ? body.endDate : null,
    maxOccurrences: Number.isInteger(Number(body.maxOccurrences)) && Number(body.maxOccurrences) > 0 ? Number(body.maxOccurrences) : null,
  };
  const dates = upcomingOccurrences(rule, new Date(), 6).slice(0, rule.maxOccurrences ?? 6);
  res.json({ dates: dates.map((date) => date.toISOString()) });
});

router.post("/recurrences", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const parsed = await parseBody(ctx.workspaceId, (req.body ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return jsonError(res, 400, "invalid_recurrence", parsed.message);
  const { value } = parsed;
  const first = nextOccurrence(value.rule, new Date());
  if (!first) return jsonError(res, 400, "invalid_recurrence", "That rule has no dates in the future. Check the start and end dates.");
  const [rule] = await db
    .insert(recurrencesTable)
    .values({
      workspaceId: ctx.workspaceId,
      createdByUserId: ctx.userId,
      ...value.rule,
      nextRunAt: first,
      content: value.content,
      firstComment: value.firstComment,
      platformContent: value.platformContent,
      connectedAccountIds: value.connectedAccountIds,
      mediaIds: value.mediaIds,
      tagIds: value.tagIds,
    })
    .returning();
  // The first occurrence appears on the calendar right away (when it falls within the horizon).
  await materializeNext(rule!);
  const [fresh] = await db.select().from(recurrencesTable).where(eq(recurrencesTable.id, rule!.id));
  res.status(201).json(serializeRecurrence(fresh!));
});

router.get("/recurrences/:recurrenceId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const id = String(req.params.recurrenceId);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "Recurring post not found.");
  const [rule] = await db.select().from(recurrencesTable).where(and(eq(recurrencesTable.id, id), eq(recurrencesTable.workspaceId, ctx.workspaceId)));
  if (!rule) return jsonError(res, 404, "not_found", "Recurring post not found.");
  const posts = await db.select().from(postsTable).where(eq(postsTable.recurrenceId, id)).orderBy(asc(postsTable.scheduledAt));
  res.json({ ...serializeRecurrence(rule), posts: await serializePosts(posts) });
});

/**
 * Updates a rule. The template (text, accounts, media) applies to occurrences created from now on; the schedule
 * change replaces future occurrences that haven't gone out. Also used to pause/resume.
 */
router.patch("/recurrences/:recurrenceId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const id = String(req.params.recurrenceId);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "Recurring post not found.");
  const [existing] = await db.select().from(recurrencesTable).where(and(eq(recurrencesTable.id, id), eq(recurrencesTable.workspaceId, ctx.workspaceId)));
  if (!existing) return jsonError(res, 404, "not_found", "Recurring post not found.");
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (Object.keys(body).length === 1 && typeof body.paused === "boolean") {
    const paused = body.paused;
    let nextRunAt = existing.nextRunAt;
    if (!paused && existing.nextRunAt && existing.nextRunAt.getTime() < Date.now()) {
      // Resuming after the next date passed: skip ahead rather than posting stale occurrences.
      nextRunAt = nextOccurrence(existing, new Date());
    }
    await db.update(recurrencesTable).set({ paused, nextRunAt }).where(eq(recurrencesTable.id, id));
    if (paused) await deleteFutureOccurrences(id);
    const [fresh] = await db.select().from(recurrencesTable).where(eq(recurrencesTable.id, id));
    if (!paused) await materializeNext(fresh!);
    const [after] = await db.select().from(recurrencesTable).where(eq(recurrencesTable.id, id));
    return void res.json(serializeRecurrence(after!));
  }

  const merged = {
    frequency: existing.frequency, interval: existing.interval, time: formatMinute(existing.minuteOfDay), timezone: existing.timezone, startDate: existing.startDate, endDate: existing.endDate,
    maxOccurrences: existing.maxOccurrences, weekdays: existing.weekdays, dayOfMonth: existing.dayOfMonth, content: existing.content, firstComment: existing.firstComment,
    platformContent: existing.platformContent, connectedAccountIds: existing.connectedAccountIds, mediaIds: existing.mediaIds, tagIds: existing.tagIds, ...body,
  };
  const parsed = await parseBody(ctx.workspaceId, merged as Record<string, unknown>);
  if (!parsed.ok) return jsonError(res, 400, "invalid_recurrence", parsed.message);
  const { value } = parsed;
  const next = nextOccurrence(value.rule, new Date());
  await db.transaction(async (tx) => {
    await tx
      .update(recurrencesTable)
      .set({ ...value.rule, content: value.content, firstComment: value.firstComment, platformContent: value.platformContent, connectedAccountIds: value.connectedAccountIds, mediaIds: value.mediaIds, tagIds: value.tagIds, nextRunAt: next })
      .where(eq(recurrencesTable.id, id));
  });
  // Future occurrences are rebuilt from the new template and schedule; sent ones are untouched.
  await deleteFutureOccurrences(id);
  const [fresh] = await db.select().from(recurrencesTable).where(eq(recurrencesTable.id, id));
  if (fresh && !fresh.paused) await materializeNext(fresh);
  const [after] = await db.select().from(recurrencesTable).where(eq(recurrencesTable.id, id));
  res.json(serializeRecurrence(after!));
});

/** Stops the rule and removes occurrences that haven't gone out. Published ones stay. */
router.delete("/recurrences/:recurrenceId", async (req, res): Promise<void> => {
  const ctx = await requireWorkspace(req, res);
  if (!ctx) return;
  const id = String(req.params.recurrenceId);
  if (!UUID.test(id)) return jsonError(res, 404, "not_found", "Recurring post not found.");
  const [existing] = await db.select({ id: recurrencesTable.id }).from(recurrencesTable).where(and(eq(recurrencesTable.id, id), eq(recurrencesTable.workspaceId, ctx.workspaceId)));
  if (!existing) return jsonError(res, 404, "not_found", "Recurring post not found.");
  await deleteFutureOccurrences(id);
  await db.delete(recurrencesTable).where(eq(recurrencesTable.id, id));
  res.sendStatus(204);
});

export default router;
