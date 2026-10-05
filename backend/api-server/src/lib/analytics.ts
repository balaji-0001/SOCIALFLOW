import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { accountMetricsTable, connectedAccountsTable, db, postMetricsTable, postTargetsTable, postsTable, type ConnectedAccount } from "@workspace/db";
import { logger } from "./logger";
import { ensureFreshToken, markAccountStatus, readCredentials } from "./oauth/accounts";
import { OAuthError } from "./oauth/errors";
import { twitterAnalyticsEnabled } from "./oauth/config";
import { getAdapter } from "./oauth/registry";
import type { MetricsResult, Platform } from "./oauth/types";

/*
 * Collecting numbers from the networks. Every reading is stored as a snapshot with its time, so charts show real history
 * from the moment collection started. A number the network doesn't report is stored as null and shown as unavailable,
 * never as zero. Collection runs every few hours for posts published in the last 90 days, and on demand.
 */

const TRACKED_DAYS = 90;
const MIN_GAP_MS = 50 * 60_000;

export type CollectOutcome = { accountId: string; ok: boolean; skipped?: boolean; notes: MetricsResult["notes"]; error?: string; postsRead: number };

/** Capabilities per network: what its API can report at all, and what extra permission unlocks more. Used to explain gaps. */
export function metricSupport(platform: Platform, scopes: string[]): Record<"followers" | "likes" | "comments" | "shares" | "views" | "impressions" | "reach" | "saves", { available: boolean; reason: string | null }> {
  const yes = { available: true, reason: null };
  const no = (reason: string) => ({ available: false, reason });
  if (platform === "facebook") {
    const insights = scopes.includes("read_insights");
    const needs = no("Needs the read_insights permission; reconnect the Page after it is enabled.");
    return { followers: yes, likes: yes, comments: yes, shares: yes, views: no("Facebook doesn't report post views to this app."), impressions: insights ? yes : needs, reach: insights ? yes : needs, saves: no("Facebook doesn't report saves.") };
  }
  if (platform === "instagram") {
    const insights = scopes.includes("instagram_business_manage_insights");
    const needs = no("Needs the instagram_business_manage_insights permission; reconnect after it is enabled.");
    return { followers: yes, likes: yes, comments: yes, shares: insights ? yes : needs, views: insights ? yes : needs, impressions: no("Instagram replaced impressions with views."), reach: insights ? yes : needs, saves: insights ? yes : needs };
  }
  if (platform === "youtube") {
    return { followers: yes, likes: yes, comments: yes, shares: no("YouTube doesn't report shares in its Data API."), views: yes, impressions: no("Impressions need the YouTube Analytics API, which isn't connected."), reach: no("YouTube doesn't report reach."), saves: no("YouTube doesn't report saves.") };
  }
  if (platform === "twitter") {
    if (!twitterAnalyticsEnabled()) {
      const off = no("Numbers from X aren't collected: X charges for every reading. The server operator can turn this on with TWITTER_ANALYTICS_ENABLED=true.");
      return { followers: off, likes: off, comments: off, shares: off, views: off, impressions: off, reach: off, saves: off };
    }
    return { followers: yes, likes: yes, comments: yes, shares: yes, views: no("X reports views as impressions."), impressions: yes, reach: no("X doesn't report reach."), saves: yes };
  }
  const closed = no("LinkedIn shares statistics only with approved partner apps.");
  return { followers: closed, likes: closed, comments: closed, shares: closed, views: closed, impressions: closed, reach: closed, saves: closed };
}

async function trackedTargets(accountId: string, now: Date) {
  const since = new Date(now.getTime() - TRACKED_DAYS * 86_400_000);
  return db
    .select({ targetId: postTargetsTable.id, externalPostId: postTargetsTable.externalPostId })
    .from(postTargetsTable)
    .innerJoin(postsTable, eq(postsTable.id, postTargetsTable.postId))
    .where(and(eq(postTargetsTable.connectedAccountId, accountId), eq(postTargetsTable.status, "published"), isNotNull(postTargetsTable.externalPostId), gte(postsTable.publishedAt, since)));
}

const hasValue = (values: Record<string, unknown>) => Object.values(values).some((value) => value !== null && value !== undefined);

/** Reads one account's numbers and stores them. `force` ignores the minimum gap between readings. */
export async function collectAccount(account: ConnectedAccount, options: { force?: boolean; now?: Date } = {}): Promise<CollectOutcome> {
  const now = options.now ?? new Date();
  const outcome: CollectOutcome = { accountId: account.id, ok: false, notes: [], postsRead: 0 };
  let adapter;
  try {
    adapter = getAdapter(account.platform as Platform);
  } catch {
    outcome.error = "This network isn't configured.";
    return outcome;
  }
  if (!adapter.collectMetrics) {
    outcome.ok = true;
    outcome.skipped = true;
    outcome.notes.push({ code: "unsupported", message: `${adapter.displayName} doesn't share statistics with this app.` });
    return outcome;
  }
  if (account.status !== "active") {
    outcome.error = "Reconnect this account to collect its numbers.";
    return outcome;
  }
  if (!options.force) {
    const [last] = await db.select({ at: accountMetricsTable.capturedAt }).from(accountMetricsTable).where(eq(accountMetricsTable.connectedAccountId, account.id)).orderBy(desc(accountMetricsTable.capturedAt)).limit(1);
    if (last && now.getTime() - last.at.getTime() < MIN_GAP_MS) {
      outcome.ok = true;
      outcome.skipped = true;
      return outcome;
    }
  }
  try {
    const fresh = await ensureFreshToken(account, adapter);
    if (fresh.status !== "active") {
      outcome.error = "Reconnect this account to collect its numbers.";
      return outcome;
    }
    const targets = await trackedTargets(account.id, now);
    const byExternal = new Map(targets.map((target) => [target.externalPostId!, target.targetId]));
    const result = await adapter.collectMetrics(readCredentials(fresh), { postIds: [...byExternal.keys()] });
    outcome.notes = result.notes;
    if (hasValue(result.account)) {
      await db.insert(accountMetricsTable).values({ connectedAccountId: account.id, capturedAt: now, followers: result.account.followers ?? null, mediaCount: result.account.mediaCount ?? null, viewsTotal: result.account.viewsTotal ?? null });
    }
    const rows = [];
    for (const [externalId, values] of Object.entries(result.posts)) {
      const targetId = byExternal.get(externalId);
      if (!targetId || !hasValue(values as Record<string, unknown>)) continue;
      rows.push({ postTargetId: targetId, capturedAt: now, likes: values.likes ?? null, comments: values.comments ?? null, shares: values.shares ?? null, views: values.views ?? null, impressions: values.impressions ?? null, reach: values.reach ?? null, saves: values.saves ?? null });
    }
    if (rows.length > 0) await db.insert(postMetricsTable).values(rows);
    outcome.postsRead = rows.length;
    outcome.ok = true;
  } catch (error) {
    if (error instanceof OAuthError) {
      if (error.code === "token_revoked") await markAccountStatus(account.id, "revoked", error.message);
      else if (error.code === "token_expired") await markAccountStatus(account.id, "expired", error.message);
      outcome.error = error.message;
    } else {
      logger.warn({ err: error, accountId: account.id }, "Collecting metrics failed");
      outcome.error = "The network couldn't be reached. Try again in a few minutes.";
    }
  }
  return outcome;
}

export async function collectWorkspace(workspaceId: string, options: { force?: boolean; accountIds?: string[] } = {}): Promise<CollectOutcome[]> {
  const accounts = await db.select().from(connectedAccountsTable).where(and(eq(connectedAccountsTable.workspaceId, workspaceId), options.accountIds?.length ? inArray(connectedAccountsTable.id, options.accountIds) : undefined));
  const outcomes: CollectOutcome[] = [];
  for (const account of accounts) outcomes.push(await collectAccount(account, { force: options.force }));
  return outcomes;
}

let cycleRunning = false;

/** One pass over every active account in every workspace. */
export async function runAnalyticsCycle(now = new Date()): Promise<number> {
  if (cycleRunning) return 0;
  cycleRunning = true;
  try {
    const accounts = await db.select().from(connectedAccountsTable).where(eq(connectedAccountsTable.status, "active"));
    let collected = 0;
    for (const account of accounts) {
      const outcome = await collectAccount(account, { now });
      if (outcome.ok && !outcome.skipped) collected += 1;
    }
    if (collected > 0) logger.info({ collected }, "Analytics collected");
    return collected;
  } finally {
    cycleRunning = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Starts the background collector (every ANALYTICS_POLL_HOURS, default 6). Off with ANALYTICS_DISABLED=true. */
export function startAnalytics(): void {
  if (timer || process.env.ANALYTICS_DISABLED === "true") return;
  const hours = Number(process.env.ANALYTICS_POLL_HOURS);
  const interval = Math.max(0.25, Number.isFinite(hours) && hours > 0 ? hours : 6) * 3600_000;
  const tick = () => { runAnalyticsCycle().catch((error) => logger.error({ err: error }, "Analytics cycle failed")); };
  timer = setInterval(tick, interval);
  timer.unref();
  // First reading a minute after start, so a restart doesn't hit the networks before the server is settled.
  setTimeout(tick, 60_000).unref();
  logger.info({ everyHours: interval / 3600_000 }, "Analytics collector started");
}
