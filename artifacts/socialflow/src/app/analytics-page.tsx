import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { format, formatDistanceToNow, parseISO } from 'date-fns';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BarChart3, Download, ExternalLink, Network, RefreshCw } from 'lucide-react';
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import {
  getGetAnalyticsQueryKey,
  useGetAnalytics,
  useListConnectedAccounts,
  useRefreshAnalytics,
  type Analytics,
  type AnalyticsAccount,
  type GetAnalyticsParams,
  type Kpi,
  type Platform,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { PLATFORM_META, PlatformBadge } from './platforms';
import { Button, EmptyState, ErrorState, PageHeader, Skeleton } from './ui';
import { ReportSchedules } from './report-schedules';
import './analytics.css';

type RangeKey = 'today' | '7d' | '30d' | '90d' | 'custom';
const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }, { key: '90d', label: '90 days' }, { key: 'custom', label: 'Custom' },
];
const PLATFORMS = Object.keys(PLATFORM_META) as Platform[];
const isRange = (v: string | null): v is RangeKey => RANGES.some((r) => r.key === v);
const isPlatform = (v: string | null): v is Platform => PLATFORMS.some((p) => p === v);

const METRIC_LABEL: Record<string, string> = {
  followers: 'Followers', likes: 'Likes', comments: 'Comments', shares: 'Shares', views: 'Views', impressions: 'Impressions', reach: 'Reach', saves: 'Saves',
};
const metricLabel = (key: string) => METRIC_LABEL[key] ?? key;

const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const fullFmt = new Intl.NumberFormat();
const compact = (n: number | null) => (n === null ? '—' : Math.abs(n) >= 10_000 ? compactFmt.format(n) : fullFmt.format(n));
const full = (n: number | null) => (n === null ? undefined : fullFmt.format(n));
const timeAgo = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });
const day = (key: string, fmt = 'MMM d') => { try { return format(parseISO(key), fmt); } catch { return key; } };

/* ---------- URL state ---------- */
type Filters = { range: RangeKey; platform: Platform | ''; accountId: string; from: string; to: string };

function useFilters() {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const filters = useMemo<Filters>(() => {
    const p = new URLSearchParams(search);
    const range = p.get('range');
    const platform = p.get('platform');
    return { range: isRange(range) ? range : '30d', platform: isPlatform(platform) ? platform : '', accountId: p.get('accountId') ?? '', from: p.get('from') ?? '', to: p.get('to') ?? '' };
  }, [search]);
  const update = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    const p = new URLSearchParams();
    p.set('range', next.range);
    if (next.range === 'custom') { if (next.from) p.set('from', next.from); if (next.to) p.set('to', next.to); }
    if (next.platform) p.set('platform', next.platform);
    if (next.accountId) p.set('accountId', next.accountId);
    navigate(`${location}?${p.toString()}`, { replace: true });
  };
  return { filters, update };
}

/* ---------- KPIs ---------- */
type KpiKey = 'followers' | 'posts' | 'engagement' | 'likes' | 'comments' | 'shares' | 'views' | 'reach' | 'impressions' | 'saves';
const KPI_ORDER: { key: KpiKey; label: string }[] = [
  { key: 'followers', label: 'Followers' }, { key: 'posts', label: 'Posts published' }, { key: 'engagement', label: 'Engagement' }, { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' }, { key: 'shares', label: 'Shares' }, { key: 'views', label: 'Views' }, { key: 'reach', label: 'Reach' },
  { key: 'impressions', label: 'Impressions' }, { key: 'saves', label: 'Saves' },
];

function Delta({ kpi }: { kpi: Kpi }) {
  if (kpi.value === null || kpi.previous === null) return <span className="sfa-an-delta is-none" data-testid="text-delta-none">No previous data</span>;
  const abs = kpi.value - kpi.previous;
  if (abs === 0) return <span className="sfa-an-delta is-flat">No change</span>;
  const up = abs > 0;
  const sign = up ? '+' : '−';
  const pct = kpi.previous > 0 ? `${sign}${Math.abs((abs / kpi.previous) * 100).toFixed(1)}%` : null;
  return <span className={`sfa-an-delta ${up ? 'is-up' : 'is-down'}`} title={`Previous period: ${fullFmt.format(kpi.previous)}`}>
    <span aria-hidden="true">{up ? '▲' : '▼'}</span>
    <span>{pct ?? `${sign}${fullFmt.format(Math.abs(abs))}`}</span>
    {pct && <small>({sign}{fullFmt.format(Math.abs(abs))})</small>}
    <span className="sr-only">{up ? 'up' : 'down'} versus previous period</span>
  </span>;
}

function KpiCard({ id, label, kpi, sub }: { id: string; label: string; kpi: Kpi; sub?: ReactNode }) {
  const isNull = kpi.value === null;
  return <div className="sfa-an-kpi" data-testid={`card-kpi-${id}`}>
    <span className="sfa-an-kpi__label">{label}</span>
    <span className={`sfa-an-kpi__value ${isNull ? 'is-null' : ''}`} title={isNull ? (kpi.reason ?? 'Not available') : full(kpi.value)} data-testid={`text-kpi-${id}`}>{compact(kpi.value)}</span>
    {sub && <span className="sfa-an-kpi__sub">{sub}</span>}
    <Delta kpi={kpi} />
  </div>;
}

/** Mirrors the server: the rate is engagement divided by reach, else impressions, else views. */
function engagementBasis(data: Analytics): string | null {
  const { reach, impressions, views } = data.kpis;
  if (reach.value !== null && reach.value !== 0) return 'reach';
  if (impressions.value !== null && impressions.value !== 0) return 'impressions';
  if (views.value !== null && views.value !== 0) return 'views';
  return null;
}

function KpiGrid({ data }: { data: Analytics }) {
  const available = KPI_ORDER.filter(({ key }) => data.kpis[key].available);
  const unavailable = KPI_ORDER.filter(({ key }) => !data.kpis[key].available);
  const basis = engagementBasis(data);
  const rate = data.kpis.engagement.rate;
  return <>
    <section aria-label="Key metrics" className="sfa-an-kpis" data-testid="grid-kpis">
      {available.map(({ key, label }) => key === 'engagement'
        ? <KpiCard key={key} id={key} label="Engagement (likes + comments + shares)" kpi={data.kpis.engagement}
          sub={rate !== null && basis ? <span data-testid="text-engagement-rate">{(rate * 100).toFixed(2)}% of {basis}</span> : undefined} />
        : <KpiCard key={key} id={key} label={label} kpi={data.kpis[key]} />)}
    </section>
    {unavailable.length > 0 && <section className="sfa-card" aria-label="Metrics not reported" data-testid="section-unavailable">
      <div className="sfa-card__head"><h2>Not reported by these accounts</h2></div>
      <div className="sfa-an-unavail"><ul>
        {unavailable.map(({ key, label }) => <li key={key} data-testid={`item-unavailable-${key}`}><strong>{label}</strong><span>{data.kpis[key].reason ?? 'Not available for the selected accounts.'}</span></li>)}
      </ul></div>
    </section>}
  </>;
}

/* ---------- Charts ---------- */
const AXIS = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const;
const GRID = 'hsl(var(--foreground) / .08)';

type TipPayload = { name?: string | number; value?: number | string; color?: string };
function ChartTip({ active, payload, label }: { active?: boolean; payload?: ReadonlyArray<TipPayload>; label?: string | number }) {
  if (!active || !payload || payload.length === 0) return null;
  return <div className="sfa-an-tip">
    <strong>{day(String(label), 'EEE, MMM d')}</strong>
    {payload.map((p) => <div key={String(p.name)}><span><i style={{ background: p.color }} /> {p.name}</span><b>{typeof p.value === 'number' ? fullFmt.format(p.value) : p.value}</b></div>)}
  </div>;
}

function ChartEmpty({ title, children, testid }: { title: string; children: ReactNode; testid: string }) {
  return <div className="sfa-an-empty" data-testid={testid}><strong>{title}</strong>{children}</div>;
}

function FollowersChart({ data }: { data: Analytics }) {
  const series = data.series.followers;
  const first = series[0];
  const last = series[series.length - 1];
  const summary = first && last ? `Followers from ${day(first.date)} to ${day(last.date)}: ${fullFmt.format(first.value)} to ${fullFmt.format(last.value)}, ${series.length} data points.` : 'No follower history in this range.';
  return <section className="sfa-card sfa-an-chartcard" data-testid="chart-followers" aria-label="Followers over time">
    <div className="sfa-card__head"><h2>Followers over time</h2></div>
    {series.length === 0
      ? <ChartEmpty testid="empty-followers" title="No follower history yet">Follower history starts when collection started, so there is nothing to plot for this range.</ChartEmpty>
      : <div className="sfa-an-chart" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
            <XAxis dataKey="date" tickFormatter={(v: string) => day(v)} tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} domain={['auto', 'auto']} tickFormatter={(v: number) => compactFmt.format(v)} allowDecimals={false} />
            <Tooltip content={<ChartTip />} cursor={{ stroke: GRID }} />
            <Area type="monotone" dataKey="value" name="Followers" stroke="hsl(var(--primary))" strokeWidth={2} fill="hsl(var(--primary) / .14)" dot={series.length < 3} animationDuration={300} />
          </AreaChart>
        </ResponsiveContainer>
      </div>}
  </section>;
}

function ActivityChart({ data }: { data: Analytics }) {
  const series = data.series.activity;
  const empty = series.length === 0 || series.every((d) => d.posts === 0);
  const totalPosts = series.reduce((s, d) => s + d.posts, 0);
  const summary = `Posts published per day and engagement on those posts: ${totalPosts} posts across ${series.length} days.`;
  return <section className="sfa-card sfa-an-chartcard" data-testid="chart-activity" aria-label="Activity">
    <div className="sfa-card__head"><h2>Activity</h2></div>
    {empty
      ? <ChartEmpty testid="empty-activity" title="No published posts in this range">Activity is drawn from posts you published, so it fills in once posts go out.</ChartEmpty>
      : <div>
        <span className="sr-only">{summary}</span>
        <p className="sfa-an-chartlabel">Posts published per day</p>
        <div className="sfa-an-chart sfa-an-chart--sm" role="img" aria-label={`Bar chart. ${summary}`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="date" tickFormatter={(v: string) => day(v)} tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
              <Tooltip content={<ChartTip />} cursor={{ fill: GRID }} />
              <Bar dataKey="posts" name="Posts" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} animationDuration={300} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="sfa-an-chartlabel">Engagement on posts published that day</p>
        <div className="sfa-an-chart sfa-an-chart--sm" role="img" aria-label="Stacked bar chart of likes, comments and shares on posts published each day.">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="date" tickFormatter={(v: string) => day(v)} tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} allowDecimals={false} tickFormatter={(v: number) => compactFmt.format(v)} />
              <Tooltip content={<ChartTip />} cursor={{ fill: GRID }} />
              <Bar dataKey="likes" name="Likes" stackId="e" fill="hsl(var(--primary))" animationDuration={300} />
              <Bar dataKey="comments" name="Comments" stackId="e" fill="hsl(var(--accent))" animationDuration={300} />
              <Bar dataKey="shares" name="Shares" stackId="e" fill="hsl(var(--success))" radius={[3, 3, 0, 0]} animationDuration={300} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <ul className="sfa-an-legend" aria-hidden="true">
          <li><i style={{ background: 'hsl(var(--primary))' }} />Likes</li><li><i style={{ background: 'hsl(var(--accent))' }} />Comments</li><li><i style={{ background: 'hsl(var(--success))' }} />Shares</li>
        </ul>
        <p className="sfa-an-note">Engagement is counted on the day a post was published, as of the last collection. It is not when the likes happened.</p>
      </div>}
  </section>;
}

/* ---------- Tables ---------- */
function Num({ value }: { value: number | null }) {
  return <td className={`is-num ${value === null ? 'is-null' : ''}`} title={value === null ? 'Not available' : full(value)}>{compact(value)}</td>;
}

function PlatformTable({ data }: { data: Analytics }) {
  const rows = data.platforms;
  const totalEng = rows.reduce((s, r) => s + (r.engagement ?? 0), 0);
  return <section className="sfa-card" aria-label="Platform comparison" data-testid="section-platforms">
    <div className="sfa-card__head"><h2>Platform comparison</h2></div>
    {rows.length === 0 ? <ChartEmpty testid="empty-platforms" title="No platforms to compare">Connect an account to see it here.</ChartEmpty>
      : <div className="sfa-an-tablewrap"><table className="sfa-an-table">
        <thead><tr><th scope="col">Platform</th><th scope="col" className="is-num">Accounts</th><th scope="col" className="is-num">Followers</th><th scope="col" className="is-num">Posts</th><th scope="col" className="is-num">Likes</th><th scope="col" className="is-num">Comments</th><th scope="col" className="is-num">Shares</th><th scope="col" className="is-num">Views</th><th scope="col" className="is-num">Engagement</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.platform} data-testid={`row-platform-${r.platform}`}>
          <td><span className="sfa-an-plat"><PlatformBadge platform={r.platform} />{PLATFORM_META[r.platform].name}</span></td>
          <Num value={r.accounts} /><Num value={r.followers} /><Num value={r.posts} /><Num value={r.likes} /><Num value={r.comments} /><Num value={r.shares} /><Num value={r.views} />
          <td className={`is-num ${r.engagement === null ? 'is-null' : ''}`} title={r.engagement === null ? 'Not available' : full(r.engagement)}>
            {r.engagement === null ? '—' : <span className="sfa-an-share">
              <span aria-hidden="true"><i style={{ width: `${totalEng > 0 ? (r.engagement / totalEng) * 100 : 0}%` }} /></span>
              {compact(r.engagement)}
              {totalEng > 0 && <span className="sr-only">{Math.round((r.engagement / totalEng) * 100)}% of engagement shown</span>}
            </span>}
          </td>
        </tr>)}</tbody>
      </table></div>}
  </section>;
}

function TopPosts({ data }: { data: Analytics }) {
  const rows = data.topPosts;
  const open = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');
  return <section className="sfa-card" aria-label="Top posts" data-testid="section-top-posts">
    <div className="sfa-card__head"><h2>Top posts</h2></div>
    {rows.length === 0 ? <ChartEmpty testid="empty-top-posts" title="No published posts in this range">Top posts appear once posts have been published and read back.</ChartEmpty>
      : <div className="sfa-an-tablewrap"><table className="sfa-an-table" style={{ minWidth: 820 }}>
        <thead><tr><th scope="col">Post</th><th scope="col">Account</th><th scope="col">Published</th><th scope="col" className="is-num">Engagement</th><th scope="col" className="is-num">Likes</th><th scope="col" className="is-num">Comments</th><th scope="col" className="is-num">Shares</th><th scope="col" className="is-num">Views</th></tr></thead>
        <tbody>{rows.map((p) => {
          const text = p.content.trim().replace(/\s+/g, ' ') || 'Untitled post';
          const url = p.postUrl;
          return <tr key={p.postId} className={url ? 'sfa-an-row--link' : ''} data-testid={`row-toppost-${p.postId}`} onClick={url ? () => open(url) : undefined}>
            <td><span className="sfa-an-plat"><PlatformBadge platform={p.platform} />
              {url
                ? <a className="sfa-an-snip" href={url} target="_blank" rel="noopener noreferrer" title={text} onClick={(e) => e.stopPropagation()} data-testid={`link-post-${p.postId}`}>{text}<span className="sr-only"> (opens the live post in a new tab)</span></a>
                : <span className="sfa-an-snip" title={text}>{text}</span>}
              {url && <ExternalLink size={12} aria-hidden="true" />}
            </span></td>
            <td>{p.accountName}</td>
            <td className="is-num">{format(new Date(p.publishedAt), 'MMM d, yyyy')}</td>
            <Num value={p.engagement} /><Num value={p.likes} /><Num value={p.comments} /><Num value={p.shares} /><Num value={p.views} />
          </tr>;
        })}</tbody>
      </table></div>}
  </section>;
}

function AccountRow({ account }: { account: AnalyticsAccount }) {
  const missing = Object.entries(account.support).filter(([, s]) => !s.available);
  const active = account.status === 'active';
  return <li className="sfa-an-acct" data-testid={`row-account-${account.id}`}>
    <div className="sfa-an-acct__row">
      <span className="sfa-an-acct__name"><PlatformBadge platform={account.platform} /><span>{account.displayName}</span></span>
      <span className="sfa-muted" title={full(account.followers)}>{account.followers === null ? '— followers' : `${compact(account.followers)} followers`}</span>
      <span className="sfa-muted">{account.collectedAt ? `Last read ${timeAgo(account.collectedAt)}` : 'Not read yet'}</span>
      {!active && <span className="sfa-pill sfa-pill--warning" data-testid={`status-account-${account.id}`}>{account.status.replace(/_/g, ' ')} · Reconnect to collect numbers</span>}
    </div>
    {missing.length > 0 && <details data-testid={`details-account-${account.id}`}>
      <summary>What’s not reported ({missing.length})</summary>
      <ul>{missing.map(([key, s]) => <li key={key}><strong>{metricLabel(key)}</strong>: {s.reason ?? 'Not available for this account.'}</li>)}</ul>
    </details>}
  </li>;
}

function AccountsSection({ data }: { data: Analytics }) {
  return <section className="sfa-card" aria-label="Accounts and availability" data-testid="section-accounts">
    <div className="sfa-card__head"><h2>Accounts &amp; availability</h2></div>
    {data.accounts.length === 0 ? <ChartEmpty testid="empty-accounts" title="No accounts match these filters">Change the platform or account filter.</ChartEmpty>
      : <ul className="sfa-an-accts">{data.accounts.map((a) => <AccountRow key={a.id} account={a} />)}</ul>}
  </section>;
}

/* ---------- Loading ---------- */
function PageSkeleton() {
  return <div className="sfa-an-body" aria-busy="true" aria-label="Loading analytics" data-testid="skeleton-analytics">
    <div className="sfa-an-kpis">{Array.from({ length: 8 }, (_, i) => <div className="sfa-an-kpi" key={i}><Skeleton width={80} /><Skeleton width={110} height={28} /><Skeleton width={70} /></div>)}</div>
    <div className="sfa-an-charts">{[0, 1].map((i) => <div className="sfa-card sfa-an-skel" key={i}><Skeleton width={140} height={16} /><div style={{ height: 12 }} /><Skeleton height={200} radius={8} /></div>)}</div>
    <div className="sfa-card sfa-an-skel">{Array.from({ length: 4 }, (_, i) => <div key={i} style={{ marginBottom: 12 }}><Skeleton width={`${90 - i * 10}%`} /></div>)}</div>
  </div>;
}

/* ---------- Page ---------- */
export function AnalyticsPage() {
  const { filters, update } = useFilters();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [draftFrom, setDraftFrom] = useState(filters.from);
  const [draftTo, setDraftTo] = useState(filters.to);
  useEffect(() => { setDraftFrom(filters.from); setDraftTo(filters.to); }, [filters.from, filters.to]);

  const customReady = filters.range !== 'custom' || (filters.from !== '' && filters.to !== '');
  const params: GetAnalyticsParams = {
    range: filters.range, tz,
    ...(filters.range === 'custom' ? { from: filters.from, to: filters.to } : {}),
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.accountId ? { accountId: filters.accountId } : {}),
  };
  const { data, isLoading, isError, isFetching, isPlaceholderData, refetch } = useGetAnalytics(params, {
    query: { queryKey: getGetAnalyticsQueryKey(params), placeholderData: keepPreviousData, enabled: customReady },
  });
  const { data: accountData, isLoading: accountsLoading } = useListConnectedAccounts();
  const connected = accountData?.accounts ?? [];
  const accountOptions = connected.filter((a) => !filters.platform || a.platform === filters.platform);

  const refresh = useRefreshAnalytics({
    mutation: {
      onSuccess: (res) => {
        void queryClient.invalidateQueries({ queryKey: [getGetAnalyticsQueryKey()[0]] });
        const ok = res.results.filter((r) => r.ok && !r.skipped);
        const failed = res.results.filter((r) => !r.ok && r.error);
        const posts = ok.reduce((s, r) => s + r.postsRead, 0);
        const lines = [
          ok.length > 0 ? `Updated ${ok.length} account${ok.length === 1 ? '' : 's'} and read ${posts} post${posts === 1 ? '' : 's'}.` : 'No account was updated.',
          ...failed.map((r) => r.error ?? ''),
          ...res.results.flatMap((r) => r.notes.map((n) => n.message)),
        ].filter(Boolean);
        toast({ title: failed.length > 0 ? 'Refreshed with problems' : 'Analytics refreshed', description: [...new Set(lines)].join(' '), variant: failed.length > 0 && ok.length === 0 ? 'destructive' : undefined });
      },
      onError: (err) => toast({ title: "Couldn't refresh analytics", description: err.data?.message ?? 'Too many refreshes, wait a few minutes.', variant: 'destructive' }),
    },
  });
  const doRefresh = () => refresh.mutate({ data: filters.accountId ? { accountId: filters.accountId } : {} });

  const [exporting, setExporting] = useState(false);
  const exportPdf = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v) qs.set(k, String(v));
      const res = await fetch(`/api/analytics/report.pdf?${qs.toString()}`, { credentials: 'include', headers: { Accept: 'application/pdf' } });
      if (!res.ok) {
        let msg = res.status === 403 ? 'You do not have permission to export reports.' : `Export failed (HTTP ${res.status}).`;
        try { const j = (await res.json()) as { message?: string }; if (j.message) msg = j.message; } catch { /* keep default */ }
        toast({ title: "Couldn't export the PDF", description: msg, variant: 'destructive' });
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') ?? '';
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) ?? /filename="?([^";]+)"?/i.exec(cd);
      let name = 'analytics-report.pdf';
      if (m) { try { name = decodeURIComponent(m[1].trim()); } catch { name = m[1].trim(); } }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast({ title: "Couldn't export the PDF", description: 'Network error. Check your connection and try again.', variant: 'destructive' });
    } finally { setExporting(false); }
  };
  const exportButton = <Button variant="secondary" icon={<Download size={14} />} loading={exporting} onClick={() => { void exportPdf(); }} disabled={connected.length === 0 || !customReady} data-testid="button-export-pdf">Export PDF</Button>;
  const refreshButton =<Button variant="secondary" icon={<RefreshCw size={14} />} loading={refresh.isPending} onClick={doRefresh} disabled={connected.length === 0} data-testid="button-refresh-analytics">Refresh</Button>;

  const noAccounts = !accountsLoading && connected.length === 0;
  const uncollected = data !== undefined && data.lastCollectedAt === null
    && (Object.keys(data.kpis) as KpiKey[]).every((k) => k === 'posts' || data.kpis[k].value === null);

  const applyCustom = (e: FormEvent) => { e.preventDefault(); if (draftFrom && draftTo && draftFrom <= draftTo) update({ from: draftFrom, to: draftTo }); };
  const customInvalid = draftFrom !== '' && draftTo !== '' && draftFrom > draftTo;

  let body: ReactNode = null;
  if (noAccounts) {
    body = <div className="sfa-card"><EmptyState icon={<Network size={22} />} title="No accounts connected" description="Connect an account to start collecting analytics. Numbers are read from the platforms themselves." action={<Link href="/workspace" className="sfa-btn sfa-btn--primary sfa-btn--md" data-testid="link-connect-account">Connect an account</Link>} /></div>;
  } else if (!customReady) {
    body = <div className="sfa-card"><EmptyState icon={<BarChart3 size={22} />} title="Choose a date range" description="Pick both a start and an end date, then press Apply." /></div>;
  } else if (isError && !data) {
    body = <ErrorState title="Couldn't load analytics" onRetry={() => { void refetch(); }} />;
  } else if (isLoading || accountsLoading || !data) {
    body = <PageSkeleton />;
  } else if (uncollected) {
    body = <div className="sfa-card"><EmptyState icon={<BarChart3 size={22} />} title="Nothing collected yet"
      description="Numbers are collected every few hours after posts go out. You can also ask for a fresh reading now."
      action={<Button variant="primary" icon={<RefreshCw size={14} />} loading={refresh.isPending} onClick={doRefresh} data-testid="button-refresh-empty">Refresh now</Button>} /></div>;
  } else {
    body = <div className={`sfa-an-body ${isPlaceholderData && isFetching ? 'is-stale' : ''}`} aria-busy={isFetching || undefined}>
      <KpiGrid data={data} />
      <div className="sfa-an-charts"><FollowersChart data={data} /><ActivityChart data={data} /></div>
      <PlatformTable data={data} />
      <TopPosts data={data} />
      <AccountsSection data={data} />
    </div>;
  }

  return <div className="sfa-page sfa-an" data-testid="page-analytics">
    <PageHeader title="Analytics" description="Numbers reported by your connected platforms. Anything a platform doesn’t report shows as “—”." actions={<>{exportButton}{refreshButton}</>} />
    <div className="sfa-an-toolbar" role="group" aria-label="Filters">
      <div className="sfa-an-field"><span id="an-range-label">Date range</span>
        <div className="sfa-seg sfa-an-seg" role="group" aria-labelledby="an-range-label">
          {RANGES.map((r) => <button key={r.key} type="button" className={filters.range === r.key ? 'is-on' : ''} aria-pressed={filters.range === r.key} onClick={() => update({ range: r.key })} data-testid={`button-range-${r.key}`}>{r.label}</button>)}
        </div>
      </div>
      {filters.range === 'custom' && <form className="sfa-an-custom" onSubmit={applyCustom}>
        <label className="sfa-an-field"><span>From</span><input type="date" className="sfa-input" value={draftFrom} max={draftTo || undefined} onChange={(e) => setDraftFrom(e.target.value)} data-testid="input-range-from" /></label>
        <label className="sfa-an-field"><span>To</span><input type="date" className="sfa-input" value={draftTo} min={draftFrom || undefined} onChange={(e) => setDraftTo(e.target.value)} data-testid="input-range-to" /></label>
        <Button type="submit" variant="primary" disabled={!draftFrom || !draftTo || customInvalid} data-testid="button-range-apply">Apply</Button>
        {customInvalid && <span className="sfa-muted" role="alert">Start date must be before the end date.</span>}
      </form>}
      <label className="sfa-an-field"><span>Platform</span>
        <select className="sfa-select" value={filters.platform} onChange={(e) => update({ platform: isPlatform(e.target.value) ? e.target.value : '', accountId: '' })} data-testid="select-platform">
          <option value="">All platforms</option>
          {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_META[p].name}</option>)}
        </select>
      </label>
      <label className="sfa-an-field"><span>Account</span>
        <select className="sfa-select" value={filters.accountId} onChange={(e) => update({ accountId: e.target.value })} data-testid="select-account">
          <option value="">All accounts</option>
          {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.displayName} ({PLATFORM_META[a.platform].name})</option>)}
        </select>
      </label>
    </div>
    {data && !noAccounts && <div className="sfa-an-meta">
      <span data-testid="text-comparing">Comparing with {day(data.range.previousFrom, 'MMM d, yyyy')} – {day(data.range.previousTo, 'MMM d, yyyy')}</span>
      <span data-testid="text-last-collected" title={data.lastCollectedAt ? format(new Date(data.lastCollectedAt), 'PPpp') : undefined}>{data.lastCollectedAt ? `Updated ${timeAgo(data.lastCollectedAt)}` : 'Not collected yet'}</span>
    </div>}
    {body}
    <ReportSchedules />
  </div>;
}

export default AnalyticsPage;
