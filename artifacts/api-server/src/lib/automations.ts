import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  automationItemsTable,
  automationRunsTable,
  automationsTable,
  db,
  type Automation,
  type AutomationConfig,
  type AutomationRunStatus,
} from "@workspace/db";
import { fetchSource, FeedError, truncateText, type FeedItem, type FeedResult } from "./feeds";
import { logger } from "./logger";
import { charLimitProblem, insertPost, loadTargetAccounts, MAX_CONTENT_LENGTH, validateTargets } from "./post-create";
import type { PostLink } from "./post-extras";
import { MAX_LINK_DESCRIPTION_LENGTH, MAX_LINK_TITLE_LENGTH, MAX_LINK_URL_LENGTH } from "./post-extras";
import { nextFreeSlot } from "./queue";

/*
 * Automations: watch a WordPress site or an RSS/Atom feed and turn new items into posts.
 *
 * The poller claims due automations every minute (FOR UPDATE SKIP LOCKED, moving next_run_at forward in the same
 * transaction, like the report scheduler), so several instances or a crash can't run one twice in the same slot.
 * A run fetches the source, records new items and creates at most config.maxPostsPerRun posts through the same
 * inserts as the composer. Each item row is inserted (ON CONFLICT DO NOTHING on (automation_id, item_key)) before
 * its post is made, and only the run that inserted it goes on to make the post: that is the duplicate protection,
 * and it holds for concurrent runs too.
 *
 * The first successful fetch is a baseline: everything already in the feed is recorded as "seen" and nothing is
 * posted (unless postExistingOnFirstRun, which posts only the newest item). Fetch failures back off exponentially
 * (interval x 2^failures, at most 24 h) and five in a row put the automation into "error" until it is resumed.
 * Item failures (an account gone, a network rule) are retried on later runs, up to three attempts.
 */

export const MAX_AUTOMATIONS_PER_WORKSPACE = 25;
export const MAX_FAILURES_BEFORE_ERROR = 5;
export const MAX_ITEM_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 24 * 3600_000;
const RUNS_KEPT = 50;
const MAX_EXCERPT_IN_POST = 300;

export const DEFAULT_TEMPLATE = "{title}\n\n{url}";

export function pollMinutes(kind: Automation["kind"]): number {
  const raw = Number(kind === "wordpress" ? process.env.WORDPRESS_POLL_MINUTES : process.env.RSS_POLL_MINUTES);
  return Number.isFinite(raw) && raw >= 1 ? raw : kind === "wordpress" ? 15 : 60;
}

/** When the next run is due after `failures` consecutive fetch failures (0 = the normal interval). */
export function nextRunAfter(kind: Automation["kind"], failures: number, now = new Date()): Date {
  const base = pollMinutes(kind) * 60_000;
  const delay = Math.min(base * 2 ** Math.max(0, failures), MAX_BACKOFF_MS);
  return new Date(now.getTime() + delay);
}

export function normalizeConfig(raw: Partial<AutomationConfig> | null | undefined): AutomationConfig {
  return {
    connectedAccountIds: Array.isArray(raw?.connectedAccountIds) ? raw!.connectedAccountIds.filter((id) => typeof id === "string") : [],
    mode: raw?.mode === "queue" || raw?.mode === "draft" ? raw.mode : "publish",
    template: typeof raw?.template === "string" && raw.template.trim() ? raw.template : DEFAULT_TEMPLATE,
    includeImage: raw?.includeImage !== false,
    maxPostsPerRun: typeof raw?.maxPostsPerRun === "number" && Number.isInteger(raw.maxPostsPerRun) ? Math.min(10, Math.max(1, raw.maxPostsPerRun)) : 3,
    postExistingOnFirstRun: raw?.postExistingOnFirstRun === true,
  };
}

/** Fills the template's {title} {url} {excerpt} {author} {site} tokens. */
export function renderTemplate(template: string, item: FeedItem, site: string): string {
  const values: Record<string, string> = {
    title: item.title,
    url: item.url ?? "",
    excerpt: truncateText(item.excerpt, MAX_EXCERPT_IN_POST),
    author: item.author ?? "",
    site,
  };
  return template
    .replace(/\{(title|url|excerpt|author|site)\}/g, (_, key: string) => values[key] ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function linkFor(item: FeedItem, includeImage: boolean): PostLink | null {
  if (!item.url || item.url.length > MAX_LINK_URL_LENGTH) return null;
  return {
    url: item.url,
    title: item.title ? item.title.slice(0, MAX_LINK_TITLE_LENGTH) : null,
    description: item.excerpt ? truncateText(item.excerpt, MAX_LINK_DESCRIPTION_LENGTH) : null,
    imageUrl: includeImage && item.imageUrl && item.imageUrl.length <= MAX_LINK_URL_LENGTH ? item.imageUrl : null,
  };
}

const siteName = (automation: Automation, result: FeedResult) => {
  if (result.sourceTitle) return result.sourceTitle;
  try { return new URL(automation.sourceUrl).hostname.replace(/^www\./, ""); } catch { return automation.name; }
};

export type ItemPostResult = { ok: true; postId: string; note: string | null } | { ok: false; message: string };

/** Makes the post for one feed item, following the automation's mode, through the composer's own checks and inserts. */
export async function createPostForItem(automation: Automation, item: FeedItem, site: string, now = new Date()): Promise<ItemPostResult> {
  const config = normalizeConfig(automation.config);
  const accountIds = [...new Set(config.connectedAccountIds)];
  if (accountIds.length === 0) return { ok: false, message: "The automation has no accounts to post to." };
  const content = renderTemplate(config.template, item, site);
  if (!content) return { ok: false, message: "The template produced an empty post for this item." };
  if (content.length > MAX_CONTENT_LENGTH) return { ok: false, message: "The post would be too long." };
  const accounts = await loadTargetAccounts(automation.workspaceId, accountIds);
  if (accounts.length !== accountIds.length) return { ok: false, message: "One or more of the automation's accounts no longer exist in this workspace." };
  const tooLong = charLimitProblem(content, accounts.map((account) => account.platform));
  if (tooLong) return { ok: false, message: tooLong };
  const link = linkFor(item, config.includeImage);

  let status: "draft" | "scheduled" = "draft";
  let scheduledAt: Date | null = null;
  let note: string | null = null;
  if (config.mode === "publish") {
    status = "scheduled";
    scheduledAt = now;
  } else if (config.mode === "queue") {
    const slot = await nextFreeSlot(automation.workspaceId, accountIds, now);
    if (slot.ok) {
      status = "scheduled";
      scheduledAt = slot.slot.at;
    } else {
      note = `Saved as a draft: ${slot.message}`;
    }
  }
  const problem = await validateTargets(automation.workspaceId, accountIds, status === "scheduled", [], content, {}, Boolean(link?.imageUrl));
  if (problem) return { ok: false, message: problem };

  const post = await db.transaction((tx) => insertPost(tx, { workspaceId: automation.workspaceId, userId: automation.createdByUserId, content, accountIds, status, scheduledAt, link }));
  return { ok: true, postId: post.id, note };
}

type Candidate = { item: FeedItem; retryOf: string | null };

/** Records the item (or claims a failed one for a retry), then makes its post. Returns null when another run already has it. */
async function processCandidate(automation: Automation, candidate: Candidate, site: string, now: Date): Promise<{ created: boolean; error: string | null } | null> {
  const { item } = candidate;
  let itemId: string | null = null;
  if (candidate.retryOf) {
    const [claimed] = await db
      .update(automationItemsTable)
      .set({ status: "pending" })
      .where(and(eq(automationItemsTable.id, candidate.retryOf), eq(automationItemsTable.status, "failed"), sql`${automationItemsTable.attempts} < ${MAX_ITEM_ATTEMPTS}`))
      .returning({ id: automationItemsTable.id });
    itemId = claimed?.id ?? null;
  } else {
    const [inserted] = await db
      .insert(automationItemsTable)
      .values({ automationId: automation.id, itemKey: item.key, title: item.title || null, url: item.url, publishedAt: item.publishedAt, status: "pending" })
      .onConflictDoNothing({ target: [automationItemsTable.automationId, automationItemsTable.itemKey] })
      .returning({ id: automationItemsTable.id });
    itemId = inserted?.id ?? null;
  }
  if (!itemId) return null;

  let result: ItemPostResult;
  try {
    result = await createPostForItem(automation, item, site, now);
  } catch (error) {
    logger.error({ err: error, automationId: automation.id }, "Creating an automation post failed");
    result = { ok: false, message: "The post couldn't be created." };
  }
  if (result.ok) {
    await db.update(automationItemsTable).set({ status: "posted", postId: result.postId, attempts: sql`${automationItemsTable.attempts} + 1`, error: result.note }).where(eq(automationItemsTable.id, itemId));
    return { created: true, error: null };
  }
  await db.update(automationItemsTable).set({ status: "failed", attempts: sql`${automationItemsTable.attempts} + 1`, error: result.message.slice(0, 1000) }).where(eq(automationItemsTable.id, itemId));
  return { created: false, error: `${item.title || item.url || "An item"}: ${result.message}` };
}

async function markSeen(automationId: string, items: FeedItem[]): Promise<void> {
  if (items.length === 0) return;
  await db
    .insert(automationItemsTable)
    .values(items.map((item) => ({ automationId, itemKey: item.key, title: item.title || null, url: item.url, publishedAt: item.publishedAt, status: "seen" as const })))
    .onConflictDoNothing({ target: [automationItemsTable.automationId, automationItemsTable.itemKey] });
}

export type RunSummary = { id: string; automationId: string; startedAt: Date; finishedAt: Date | null; status: AutomationRunStatus; itemsFound: number; itemsNew: number; postsCreated: number; error: string | null };

async function recordRun(automationId: string, run: Omit<RunSummary, "id" | "automationId">): Promise<RunSummary> {
  const [row] = await db.insert(automationRunsTable).values({ automationId, ...run }).returning();
  // Keep the latest RUNS_KEPT runs per automation.
  await db.execute(sql`delete from socialflow_automation_runs where automation_id = ${automationId} and id not in (select id from socialflow_automation_runs where automation_id = ${automationId} order by started_at desc limit ${RUNS_KEPT})`);
  return row!;
}

/**
 * One run of an automation: fetch, baseline or post the new items, record the run and schedule the next one.
 * Never throws for source or item problems; they are recorded on the run and the automation.
 */
export async function runAutomation(automationId: string, now = new Date()): Promise<RunSummary | null> {
  const [automation] = await db.select().from(automationsTable).where(eq(automationsTable.id, automationId));
  if (!automation) return null;
  const startedAt = new Date();

  let result: FeedResult;
  try {
    result = await fetchSource(automation.kind, automation.sourceUrl);
  } catch (error) {
    const message = (error instanceof FeedError ? error.message : "The source couldn't be read.").slice(0, 1000);
    if (!(error instanceof FeedError)) logger.error({ err: error, automationId }, "Automation fetch failed unexpectedly");
    const failures = automation.consecutiveFailures + 1;
    const toError = failures >= MAX_FAILURES_BEFORE_ERROR && automation.status === "active";
    await db.update(automationsTable).set({
      consecutiveFailures: failures,
      lastRunAt: now,
      lastStatus: "failed",
      lastError: toError ? `Stopped after ${failures} failed checks in a row. ${message}` : message,
      nextRunAt: nextRunAfter(automation.kind, failures, now),
      ...(toError ? { status: "error" as const } : {}),
    }).where(eq(automationsTable.id, automation.id));
    return recordRun(automation.id, { startedAt, finishedAt: new Date(), status: "failed", itemsFound: 0, itemsNew: 0, postsCreated: 0, error: message });
  }

  const config = normalizeConfig(automation.config);
  const items = result.items;
  const site = siteName(automation, result);
  const known = items.length === 0 ? [] : await db
    .select({ id: automationItemsTable.id, itemKey: automationItemsTable.itemKey, status: automationItemsTable.status, attempts: automationItemsTable.attempts })
    .from(automationItemsTable)
    .where(and(eq(automationItemsTable.automationId, automation.id), inArray(automationItemsTable.itemKey, items.map((item) => item.key))));
  const knownByKey = new Map(known.map((row) => [row.itemKey, row]));
  const fresh = items.filter((item) => !knownByKey.has(item.key));

  let candidates: Candidate[] = [];
  let itemsNew = fresh.length;
  let baseline = false;
  if (!automation.baselineAt) {
    // First look at this source: remember what is already there instead of posting it.
    baseline = true;
    const newest = config.postExistingOnFirstRun ? fresh[0] : undefined;
    await markSeen(automation.id, fresh.filter((item) => item !== newest));
    if (newest) candidates = [{ item: newest, retryOf: null }];
    itemsNew = newest ? 1 : 0;
  } else {
    const retries: Candidate[] = items
      .map((item) => ({ item, row: knownByKey.get(item.key) }))
      .filter(({ row }) => row && row.status === "failed" && row.attempts < MAX_ITEM_ATTEMPTS)
      .map(({ item, row }) => ({ item, retryOf: row!.id }));
    // Items are newest first: take the newest ones up to the cap; older new items wait for the next run.
    candidates = [...fresh.map((item) => ({ item, retryOf: null })), ...retries]
      .sort((a, b) => items.indexOf(a.item) - items.indexOf(b.item))
      .slice(0, config.maxPostsPerRun);
  }

  // Post oldest first so the accounts show the items in the order they were published.
  let created = 0;
  const errors: string[] = [];
  let attempted = 0;
  for (const candidate of [...candidates].reverse()) {
    const outcome = await processCandidate(automation, candidate, site, now);
    if (!outcome) continue;
    attempted += 1;
    if (outcome.created) created += 1;
    if (outcome.error) errors.push(outcome.error);
  }

  const status: AutomationRunStatus = attempted === 0 ? "no_new" : errors.length === 0 ? "success" : created > 0 ? "partial" : "failed";
  const error = errors.length > 0 ? errors.join(" | ").slice(0, 1000) : null;
  await db.update(automationsTable).set({
    consecutiveFailures: 0,
    lastRunAt: now,
    lastStatus: status,
    lastError: error,
    nextRunAt: nextRunAfter(automation.kind, 0, now),
    ...(baseline ? { baselineAt: now } : {}),
    // A source that answers again brings an automation out of "error"; a paused one stays paused.
    ...(automation.status === "error" ? { status: "active" as const } : {}),
  }).where(eq(automationsTable.id, automation.id));
  return recordRun(automation.id, { startedAt, finishedAt: new Date(), status, itemsFound: items.length, itemsNew, postsCreated: created, error });
}

/**
 * Claims active automations whose time has come and moves their next_run_at forward in the same transaction, so a
 * crash mid-run or a second instance can't run them twice. runAutomation sets the real next time when it finishes.
 */
export async function claimDueAutomations(limit = 10, now = new Date()): Promise<string[]> {
  return db.transaction(async (tx) => {
    const due = await tx.execute(sql`
      select a.id, a.kind from socialflow_automations a
      join socialflow_workspaces w on w.id = a.workspace_id
      where a.status = 'active' and a.next_run_at is not null and a.next_run_at <= ${now.toISOString()}::timestamptz
      order by a.next_run_at asc limit ${limit} for update of a skip locked`);
    const ids: string[] = [];
    for (const row of due.rows as Array<{ id: string; kind: Automation["kind"] }>) {
      await tx.update(automationsTable).set({ nextRunAt: nextRunAfter(row.kind, 0, now) }).where(eq(automationsTable.id, row.id));
      ids.push(row.id);
    }
    return ids;
  });
}

let cycleRunning = false;

/** One poll: run every due automation. Returns how many ran. */
export async function runAutomationCycle(now = new Date()): Promise<number> {
  if (cycleRunning) return 0;
  cycleRunning = true;
  try {
    const due = await claimDueAutomations(10, now);
    for (const id of due) {
      try {
        await runAutomation(id, now);
      } catch (error) {
        logger.error({ err: error, automationId: id }, "Automation run failed");
      }
    }
    if (due.length) logger.info({ ran: due.length }, "Automation cycle finished");
    return due.length;
  } finally {
    cycleRunning = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Starts the automation poller: checks for due automations every minute. AUTOMATIONS_DISABLED=true turns it off. */
export function startAutomations(): void {
  if (timer || process.env.AUTOMATIONS_DISABLED === "true") return;
  const tick = () => { runAutomationCycle().catch((error) => logger.error({ err: error }, "Automation cycle failed")); };
  timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
  logger.info({ wordpressMinutes: pollMinutes("wordpress"), rssMinutes: pollMinutes("rss") }, "Automation poller started");
}

export function stopAutomations(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/* ---------- reads for the API ---------- */

export async function automationStats(ids: string[]): Promise<Map<string, { postsCreatedTotal: number }>> {
  const map = new Map<string, { postsCreatedTotal: number }>();
  for (const id of ids) map.set(id, { postsCreatedTotal: 0 });
  if (ids.length === 0) return map;
  const rows = await db
    .select({ automationId: automationItemsTable.automationId, total: sql<number>`count(*)::int` })
    .from(automationItemsTable)
    .where(and(inArray(automationItemsTable.automationId, ids), eq(automationItemsTable.status, "posted")))
    .groupBy(automationItemsTable.automationId);
  for (const row of rows) map.get(row.automationId)!.postsCreatedTotal = Number(row.total);
  return map;
}

export async function latestRuns(automationId: string, limit = RUNS_KEPT) {
  return db.select().from(automationRunsTable).where(eq(automationRunsTable.automationId, automationId)).orderBy(desc(automationRunsTable.startedAt)).limit(limit);
}

