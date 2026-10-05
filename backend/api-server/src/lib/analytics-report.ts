import { and, asc, eq, gte, inArray, isNotNull, lt, lte, max, sql } from "drizzle-orm";
import { accountMetricsTable, connectedAccountsTable, db, postMetricsTable, postTargetsTable, postsTable } from "@workspace/db";
import { metricSupport } from "./analytics";
import { postUrl } from "./publisher";
import type { Platform } from "./oauth/types";
import { addDays, dateKey, parseDate, zonedParts, zonedToUtc } from "./time";

/*
 * Turns stored snapshots into the analytics page. Everything comes from readings the networks reported; a metric no
 * selected account can report is marked unavailable with the reason, and totals only ever add real readings.
 */

export type RangeKey = "today" | "7d" | "30d" | "90d" | "custom";
export type Range = { key: RangeKey; from: Date; to: Date; previousFrom: Date; previousTo: Date };

const DAY = 86_400_000;

/** Resolves a range choice to concrete instants (and the same-length period before it, for comparison). */
export function resolveRange(key: RangeKey, tz: string, custom: { from?: string; to?: string }, now = new Date()): Range | null {
  const startOfDay = (instant: Date) => { const p = zonedParts(instant, tz); return zonedToUtc(p.year, p.month, p.day, 0, tz); };
  let from: Date;
  let to = now;
  if (key === "today") from = startOfDay(now);
  else if (key === "7d") from = new Date(startOfDay(now).getTime() - 6 * DAY);
  else if (key === "30d") from = new Date(startOfDay(now).getTime() - 29 * DAY);
  else if (key === "90d") from = new Date(startOfDay(now).getTime() - 89 * DAY);
  else {
    const f = parseDate(custom.from);
    const t = parseDate(custom.to);
    if (!f || !t) return null;
    from = zonedToUtc(f.year, f.month, f.day, 0, tz);
    const next = addDays(t.year, t.month, t.day, 1);
    to = new Date(Math.min(zonedToUtc(next.year, next.month, next.day, 0, tz).getTime(), now.getTime()));
    if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > 400 * DAY) return null;
  }
  const length = to.getTime() - from.getTime();
  return { key, from, to, previousFrom: new Date(from.getTime() - length), previousTo: from };
}

const num = (value: number | string | null | undefined): number | null => (value === null || value === undefined ? null : Number(value));
const sumOrNull = (values: Array<number | null>): number | null => { const real = values.filter((v): v is number => v !== null); return real.length === 0 ? null : real.reduce((a, b) => a + b, 0); };

type PostRow = { targetId: string; postId: string; content: string; publishedAt: Date; accountId: string; accountName: string; platform: Platform; externalPostId: string | null; likes: number | null; comments: number | null; shares: number | null; views: number | null; impressions: number | null; reach: number | null; saves: number | null; capturedAt: Date | null };

/** Published targets in a window with each one's latest reading at or before `asOf`. */
async function postsIn(workspaceId: string, accountIds: string[], from: Date, to: Date, asOf: Date): Promise<PostRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await db
    .select({
      targetId: postTargetsTable.id, postId: postsTable.id, content: postsTable.content, publishedAt: postsTable.publishedAt, accountId: connectedAccountsTable.id, accountName: connectedAccountsTable.displayName,
      platform: connectedAccountsTable.platform, externalPostId: postTargetsTable.externalPostId,
    })
    .from(postTargetsTable)
    .innerJoin(postsTable, eq(postsTable.id, postTargetsTable.postId))
    .innerJoin(connectedAccountsTable, eq(connectedAccountsTable.id, postTargetsTable.connectedAccountId))
    .where(and(eq(postsTable.workspaceId, workspaceId), inArray(postTargetsTable.connectedAccountId, accountIds), eq(postTargetsTable.status, "published"), isNotNull(postsTable.publishedAt), gte(postsTable.publishedAt, from), lt(postsTable.publishedAt, to)))
    .orderBy(asc(postsTable.publishedAt));
  if (rows.length === 0) return [];
  const targetIds = rows.map((row) => row.targetId);
  // Latest snapshot per target at or before asOf: the time of each target's newest reading, joined back to that reading.
  const newest = db
    .select({ postTargetId: postMetricsTable.postTargetId, at: max(postMetricsTable.capturedAt).as("at") })
    .from(postMetricsTable)
    .where(and(inArray(postMetricsTable.postTargetId, targetIds), lte(postMetricsTable.capturedAt, asOf)))
    .groupBy(postMetricsTable.postTargetId)
    .as("newest");
  const snaps = await db
    .select({ postTargetId: postMetricsTable.postTargetId, likes: postMetricsTable.likes, comments: postMetricsTable.comments, shares: postMetricsTable.shares, views: postMetricsTable.views, impressions: postMetricsTable.impressions, reach: postMetricsTable.reach, saves: postMetricsTable.saves, capturedAt: postMetricsTable.capturedAt })
    .from(postMetricsTable)
    .innerJoin(newest, and(eq(postMetricsTable.postTargetId, newest.postTargetId), eq(postMetricsTable.capturedAt, newest.at)));
  const byTarget = new Map(snaps.map((snap) => [snap.postTargetId, snap]));
  return rows.map((row) => {
    const snap = byTarget.get(row.targetId);
    return { ...row, publishedAt: row.publishedAt!, platform: row.platform as Platform, likes: snap?.likes ?? null, comments: snap?.comments ?? null, shares: snap?.shares ?? null, views: num(snap?.views), impressions: num(snap?.impressions), reach: num(snap?.reach), saves: snap?.saves ?? null, capturedAt: snap?.capturedAt ?? null };
  });
}

const engagementOf = (row: Pick<PostRow, "likes" | "comments" | "shares" | "saves">) => sumOrNull([row.likes, row.comments, row.shares, row.saves]);

function totals(rows: PostRow[]) {
  return {
    posts: rows.length,
    likes: sumOrNull(rows.map((r) => r.likes)),
    comments: sumOrNull(rows.map((r) => r.comments)),
    shares: sumOrNull(rows.map((r) => r.shares)),
    saves: sumOrNull(rows.map((r) => r.saves)),
    views: sumOrNull(rows.map((r) => r.views)),
    impressions: sumOrNull(rows.map((r) => r.impressions)),
    reach: sumOrNull(rows.map((r) => r.reach)),
    engagement: sumOrNull(rows.map(engagementOf)),
  };
}

const change = (current: number | null, previous: number | null) => (current === null || previous === null ? null : current - previous);

export async function buildReport(workspaceId: string, range: Range, filter: { platform?: Platform; accountId?: string }, tz: string, now = new Date()) {
  const accountRows = await db.select().from(connectedAccountsTable).where(and(eq(connectedAccountsTable.workspaceId, workspaceId), filter.platform ? eq(connectedAccountsTable.platform, filter.platform) : undefined, filter.accountId ? eq(connectedAccountsTable.id, filter.accountId) : undefined));
  const accountIds = accountRows.map((account) => account.id);

  // Latest account reading at/before a moment, per account.
  const latestBefore = async (asOf: Date) => {
    if (accountIds.length === 0) return new Map<string, { followers: number | null; viewsTotal: number | null; mediaCount: number | null; capturedAt: Date }>();
    const newest = db
      .select({ accountId: accountMetricsTable.connectedAccountId, at: max(accountMetricsTable.capturedAt).as("at") })
      .from(accountMetricsTable)
      .where(and(inArray(accountMetricsTable.connectedAccountId, accountIds), lte(accountMetricsTable.capturedAt, asOf)))
      .groupBy(accountMetricsTable.connectedAccountId)
      .as("newest");
    const rows = await db
      .select({ accountId: accountMetricsTable.connectedAccountId, followers: accountMetricsTable.followers, viewsTotal: accountMetricsTable.viewsTotal, mediaCount: accountMetricsTable.mediaCount, capturedAt: accountMetricsTable.capturedAt })
      .from(accountMetricsTable)
      .innerJoin(newest, and(eq(accountMetricsTable.connectedAccountId, newest.accountId), eq(accountMetricsTable.capturedAt, newest.at)));
    return new Map(rows.map((row) => [row.accountId, { followers: row.followers, viewsTotal: num(row.viewsTotal), mediaCount: row.mediaCount, capturedAt: row.capturedAt }]));
  };
  const nowReadings = await latestBefore(range.to);
  const startReadings = await latestBefore(range.from);

  const current = await postsIn(workspaceId, accountIds, range.from, range.to, now);
  const previous = await postsIn(workspaceId, accountIds, range.previousFrom, range.previousTo, now);
  const cur = totals(current);
  const prev = totals(previous);

  // Which metrics could any selected account report at all, and why not.
  const support = accountRows.map((account) => ({ account, support: metricSupport(account.platform as Platform, account.scopes) }));
  const metricKeys = ["followers", "likes", "comments", "shares", "views", "impressions", "reach", "saves"] as const;
  const availability = Object.fromEntries(metricKeys.map((key) => {
    const supporting = support.filter((entry) => entry.support[key].available);
    const reasons = [...new Set(support.filter((entry) => !entry.support[key].available).map((entry) => entry.support[key].reason!))];
    return [key, { available: supporting.length > 0, reason: supporting.length > 0 ? null : (reasons[0] ?? "No account selected.") }];
  }));

  const followersNow = sumOrNull(accountRows.map((a) => nowReadings.get(a.id)?.followers ?? null));
  const followersStart = sumOrNull(accountRows.filter((a) => startReadings.has(a.id)).map((a) => startReadings.get(a.id)?.followers ?? null));

  const kpi = (key: keyof typeof cur, metric: typeof metricKeys[number] | null) => ({
    value: cur[key], previous: prev[key], change: change(cur[key], prev[key]),
    available: metric ? availability[metric]!.available : true, reason: metric ? availability[metric]!.reason : null,
  });
  const engagementRate = cur.engagement !== null && (cur.reach ?? cur.impressions ?? cur.views) ? cur.engagement / (cur.reach ?? cur.impressions ?? cur.views)! : null;

  // Followers over time: carry each account's last reading forward day by day.
  const days: Date[] = [];
  for (let t = new Date(range.from); t.getTime() < range.to.getTime() && days.length < 120; t = new Date(t.getTime() + DAY)) days.push(t);
  const readings = accountIds.length === 0 ? [] : await db.select().from(accountMetricsTable).where(and(inArray(accountMetricsTable.connectedAccountId, accountIds), lte(accountMetricsTable.capturedAt, range.to))).orderBy(asc(accountMetricsTable.capturedAt));
  const followersSeries = days.map((day) => {
    const end = new Date(Math.min(day.getTime() + DAY, range.to.getTime()));
    const perAccount = new Map<string, number | null>();
    for (const reading of readings) if (reading.capturedAt.getTime() <= end.getTime()) perAccount.set(reading.connectedAccountId, reading.followers);
    const p = zonedParts(day, tz);
    return { date: dateKey(p), value: sumOrNull([...perAccount.values()]) };
  }).filter((point) => point.value !== null);

  const byDay = new Map<string, { date: string; posts: number; likes: number; comments: number; shares: number }>();
  for (const day of days) byDay.set(dateKey(zonedParts(day, tz)), { date: dateKey(zonedParts(day, tz)), posts: 0, likes: 0, comments: 0, shares: 0 });
  for (const row of current) {
    const entry = byDay.get(dateKey(zonedParts(row.publishedAt, tz)));
    if (!entry) continue;
    entry.posts += 1; entry.likes += row.likes ?? 0; entry.comments += row.comments ?? 0; entry.shares += row.shares ?? 0;
  }

  const platforms = [...new Set(accountRows.map((a) => a.platform as Platform))].map((platform) => {
    const rows = current.filter((r) => r.platform === platform);
    const accs = accountRows.filter((a) => a.platform === platform);
    return { platform, accounts: accs.length, followers: sumOrNull(accs.map((a) => nowReadings.get(a.id)?.followers ?? null)), ...totals(rows) };
  });

  const topPosts = [...current]
    .filter((row) => engagementOf(row) !== null || row.views !== null)
    .sort((a, b) => (engagementOf(b) ?? 0) - (engagementOf(a) ?? 0) || (b.views ?? 0) - (a.views ?? 0))
    .slice(0, 10)
    .map((row) => ({ postId: row.postId, content: row.content.slice(0, 200), platform: row.platform, accountName: row.accountName, publishedAt: row.publishedAt, postUrl: postUrl(row.platform, row.externalPostId), likes: row.likes, comments: row.comments, shares: row.shares, views: row.views, impressions: row.impressions, reach: row.reach, saves: row.saves, engagement: engagementOf(row), capturedAt: row.capturedAt }));

  const [lastRow] = accountIds.length === 0 ? [] : await db.select({ at: sql<Date | null>`max(${accountMetricsTable.capturedAt})`.mapWith(accountMetricsTable.capturedAt) }).from(accountMetricsTable).where(inArray(accountMetricsTable.connectedAccountId, accountIds));

  return {
    range: { key: range.key, from: range.from, to: range.to, previousFrom: range.previousFrom, previousTo: range.previousTo, timezone: tz },
    lastCollectedAt: lastRow?.at ? new Date(lastRow.at) : null,
    accounts: accountRows.map((account) => {
      const reading = nowReadings.get(account.id);
      return {
        id: account.id, platform: account.platform as Platform, displayName: account.displayName, status: account.status,
        followers: reading?.followers ?? null, mediaCount: reading?.mediaCount ?? null, viewsTotal: reading?.viewsTotal ?? null, collectedAt: reading?.capturedAt ?? null,
        support: metricSupport(account.platform as Platform, account.scopes),
      };
    }),
    kpis: {
      followers: { value: followersNow, previous: followersStart, change: change(followersNow, followersStart), available: availability.followers!.available, reason: availability.followers!.reason },
      posts: kpi("posts", null),
      likes: kpi("likes", "likes"), comments: kpi("comments", "comments"), shares: kpi("shares", "shares"), saves: kpi("saves", "saves"),
      views: kpi("views", "views"), impressions: kpi("impressions", "impressions"), reach: kpi("reach", "reach"),
      engagement: { ...kpi("engagement", "likes"), rate: engagementRate },
    },
    series: { followers: followersSeries, activity: [...byDay.values()] },
    platforms,
    topPosts,
  };
}
