import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { addDays, format, formatDistanceToNow, isSameDay, isToday, startOfDay } from 'date-fns';
import { ArrowRight, CalendarClock, CalendarDays, Check, CheckCheck, FilePen, History, ListOrdered, Network, Plus, Repeat, Search, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getAuthMeQueryKey,
  getListPostsQueryKey,
  getListTagsQueryKey,
  useListTags,
  useAuthMe,
  useDeletePost,
  useListConnectedAccounts,
  useListPosts,
  useUpdatePost,
  type ConnectedAccount,
  type Post,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { useComposer } from './composer';
import { useConfirm } from './confirm';
import { usePublishNow } from './publish';
import { AccountAvatar, PlatformBadge, STATUS_LABEL, StatusPill, snippet, uniquePlatforms } from './platforms';
import { Button, EmptyState, ErrorState, IconButton, PageHeader, Skeleton } from './ui';
import './dashboard.css';

function usePostActions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const refresh = () => queryClient.invalidateQueries({ queryKey: [getListPostsQueryKey()[0]] });
  const remove = useDeletePost({
    mutation: {
      onSuccess: () => { refresh(); toast({ title: 'Post deleted' }); },
      onError: (err) => { refresh(); toast({ title: "Couldn't delete the post", description: err.data?.message ?? undefined, variant: 'destructive' }); },
    },
  });
  const update = useUpdatePost({
    mutation: {
      onSuccess: () => { refresh(); toast({ title: 'Moved to drafts' }); },
      onError: (err) => toast({ title: "Couldn't update the post", description: err.data?.message ?? undefined, variant: 'destructive' }),
    },
  });
  return { remove, update };
}

function useGo() {
  const [, navigate] = useLocation();
  return (href: string) => (event: MouseEvent) => { if (event.metaKey || event.ctrlKey || event.button !== 0) return; event.preventDefault(); navigate(href); };
}

function TableSkeleton({ rows = 4 }: { rows?: number }) {
  return <div className="sfa-table" aria-busy="true" aria-label="Loading posts">
    {Array.from({ length: rows }, (_, i) => <div className="sfa-table__row" key={i}>
      <Skeleton width={`${70 - i * 8}%`} />
      <span className="sfa-table__acct"><Skeleton width={22} height={22} radius={999} /><Skeleton width={90} /></span>
      <Skeleton width={78} height={22} radius={999} />
      <Skeleton width={120} />
      <span />
    </div>)}
  </div>;
}

function PostsTable({ posts, empty }: { posts: Post[]; empty: ReactNode }) {
  const composer = useComposer();
  const confirm = useConfirm();
  const { remove, update } = usePostActions();
  const { publishNow, publishing } = usePublishNow();
  if (posts.length === 0) return <>{empty}</>;
  return <div className="sfa-table" role="table" aria-label="Posts">
    <div className="sfa-table__head" role="row"><span role="columnheader">Post</span><span role="columnheader">Accounts</span><span role="columnheader">Status</span><span role="columnheader">When</span><span role="columnheader"><span className="sr-only">Actions</span></span></div>
    {posts.map((post) => <div className="sfa-table__row" role="row" key={post.id} data-testid={`row-post-${post.id}`}>
      <span className="sfa-table__postcell">
        <button className="sfa-table__post" onClick={() => composer.open({ post })} title={post.content}>{post.recurrenceId && <Repeat size={12} className="sfa-table__repeat" aria-label="Recurring" />}{snippet(post.content, 120)}</button>
        {post.tags.length > 0 && <span className="sfa-table__tags">{post.tags.map((tag) => <span key={tag.id} className="sfa-tagchip sfa-tagchip--tag" style={{ ['--tag' as string]: tag.color }}>{tag.name}</span>)}</span>}
        {post.status === 'failed' && post.targets.some((target) => target.errorMessage) && <span className="sfa-table__error" role="note">{post.targets.find((target) => target.errorMessage)?.errorMessage}</span>}
      </span>
      <span className="sfa-table__acct">
        <span className="sfa-chip__icons">{uniquePlatforms(post).map((platform) => <PlatformBadge key={platform} platform={platform} size={16} />)}</span>
        <span className="sfa-muted">{post.targets.length === 0 ? 'No accounts' : post.targets.length === 1 ? post.targets[0]!.accountName : `${post.targets.length} accounts`}</span>
      </span>
      <span><StatusPill status={post.status} /></span>
      <span className="sfa-muted sfa-num">{post.scheduledAt ? format(new Date(post.scheduledAt), 'MMM d, yyyy · h:mm a') : `Edited ${formatDistanceToNow(new Date(post.updatedAt), { addSuffix: true })}`}</span>
      <span className="sfa-table__actions">
        {post.status === 'failed' && <Button size="sm" variant="primary" disabled={publishing} onClick={() => publishNow(post)} data-testid={`button-retry-${post.id}`}>Retry</Button>}
        <Button size="sm" variant="secondary" onClick={() => composer.open({ post })} data-testid={`button-edit-${post.id}`}>{post.status === 'published' || post.status === 'publishing' ? 'View' : post.status === 'draft' ? 'Schedule' : 'Edit'}</Button>
        {post.status === 'scheduled' && <Button size="sm" variant="ghost" loading={update.isPending && update.variables?.postId === post.id} disabled={update.isPending} onClick={() => update.mutate({ postId: post.id, data: { scheduledAt: null } })}>Move to draft</Button>}
        <IconButton label="Delete post" disabled={remove.isPending || post.status === 'publishing'} className="sfa-iconbtn--danger"
          onClick={async () => { if (await confirm({ title: 'Delete this post?', description: 'This removes the post and its schedule. It can’t be undone.', confirmLabel: 'Delete post', destructive: true })) remove.mutate({ postId: post.id }); }}
          data-testid={`button-delete-${post.id}`}><Trash2 size={15} /></IconButton>
      </span>
    </div>)}
  </div>;
}

type Tab = 'all' | 'scheduled' | 'published' | 'failed';
const TABS: Tab[] = ['all', 'scheduled', 'published', 'failed'];

export function PostsPage() {
  const composer = useComposer();
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('all');
  const { data: tagData } = useListTags({ query: { queryKey: getListTagsQueryKey() } });
  const { data, isLoading, isError, refetch } = useListPosts(undefined, { query: { queryKey: getListPostsQueryKey(), refetchInterval: 20_000 } });
  const posts = useMemo(() => (data?.posts ?? []).filter((post) => post.status !== 'draft'), [data]);
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = (tab === 'all' ? posts : posts.filter((post) => post.status === tab)).filter((post) => {
      if (tagFilter !== 'all' && !post.tags.some((tag) => tag.id === tagFilter)) return false;
      if (!term) return true;
      const haystack = [post.content, ...Object.values(post.platformContent ?? {}), ...post.targets.map((t) => t.accountName), ...post.tags.map((t) => t.name)].join(' ').toLowerCase();
      return haystack.includes(term);
    });
    const when = (post: Post) => new Date(post.scheduledAt ?? post.createdAt).getTime();
    return [...filtered].sort((a, b) => (tab === 'scheduled' ? when(a) - when(b) : when(b) - when(a)));
  }, [posts, tab, search, tagFilter]);
  const count = (status: Tab) => (status === 'all' ? posts.length : posts.filter((post) => post.status === status).length);

  return <div className="sfa-page" data-testid="page-posts">
    <PageHeader title="Manage Posts" description="Every scheduled, published and failed post in this workspace." />
    <div className="sfa-card">
      <div className="sfa-tabs" role="tablist" aria-label="Filter by status">
        {TABS.map((option) => <button key={option} role="tab" aria-selected={tab === option} className={tab === option ? 'is-on' : ''} onClick={() => setTab(option)} data-testid={`tab-posts-${option}`}>
          {option === 'all' ? 'All' : STATUS_LABEL[option]} <span className="sfa-count sfa-num">{isLoading ? '–' : count(option)}</span>
        </button>)}
      </div>
      <div className="sfa-table__tools">
        <label className="sfa-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search posts, accounts, tags" aria-label="Search posts" data-testid="input-posts-search" />{search && <button type="button" className="sfa-search__clear" onClick={() => setSearch('')} aria-label="Clear search">×</button>}</label>
        <select className="sfa-select" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} aria-label="Filter by tag" data-testid="select-posts-tag">
          <option value="all">All tags</option>{(tagData?.tags ?? []).map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
        </select>
      </div>
      {isError ? <ErrorState title="Couldn't load your posts" onRetry={() => refetch()} />
        : isLoading ? <TableSkeleton />
        : <PostsTable posts={visible} empty={tab === 'all'
          ? <EmptyState icon={<CalendarClock size={22} />} title="No posts yet" description="Create your first post to get started. Scheduled, published and failed posts all show up here."
              action={<Button variant="primary" icon={<Plus size={15} />} onClick={() => composer.open()}>Create Post</Button>} />
          : <EmptyState icon={tab === 'failed' ? <Check size={22} /> : <CalendarClock size={22} />} title={`No ${tab} posts`}
              description={tab === 'failed' ? 'Nothing has failed. Posts that fail to publish will appear here with the reason.' : tab === 'published' ? 'Published posts will appear here once they go out.' : 'Posts you schedule will be listed here in the order they’ll go out.'} />} />}
    </div>
  </div>;
}

export function DraftsPage() {
  const composer = useComposer();
  const { data, isLoading, isError, refetch } = useListPosts({ status: 'draft' }, { query: { queryKey: getListPostsQueryKey({ status: 'draft' }) } });
  const drafts = useMemo(() => [...(data?.posts ?? [])].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()), [data]);
  return <div className="sfa-page" data-testid="page-drafts">
    <PageHeader title="Drafts" description="Ideas you’ve saved without a time. Open one to finish it and schedule it." />
    <div className="sfa-card">
      {isError ? <ErrorState title="Couldn't load your drafts" onRetry={() => refetch()} />
        : isLoading ? <TableSkeleton rows={3} />
        : <PostsTable posts={drafts} empty={<EmptyState icon={<FilePen size={22} />} title="No drafts"
            description="Anything you save without scheduling shows up here."
            action={<Button variant="primary" icon={<Plus size={15} />} onClick={() => composer.open()}>Create Post</Button>} />} />}
    </div>
  </div>;
}

const ACCOUNT_STATUS: Record<ConnectedAccount['status'], { label: string; tone: string }> = {
  active: { label: 'Connected', tone: 'success' },
  expired: { label: 'Token expired', tone: 'warning' },
  revoked: { label: 'Access revoked', tone: 'error' },
  missing_permissions: { label: 'Missing permissions', tone: 'warning' },
  error: { label: 'Check failed', tone: 'error' },
};

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** Scheduled posts per day for the next 7 days, from real post data. */
function NextSevenDays({ posts }: { posts: Post[] }) {
  const today = startOfDay(new Date());
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const counts = days.map((day) => posts.filter((post) => post.status === 'scheduled' && post.scheduledAt && isSameDay(new Date(post.scheduledAt), day)).length);
  const max = Math.max(1, ...counts);
  const total = counts.reduce((sum, n) => sum + n, 0);
  return <>
    <div className="sfa-bars" role="list" aria-label="Scheduled posts per day, next 7 days">
      {days.map((day, i) => {
        const label = `${format(day, 'EEEE, MMM d')}: ${counts[i]} ${counts[i] === 1 ? 'post' : 'posts'} scheduled`;
        return <div key={day.toISOString()} className={`sfa-bar ${isToday(day) ? 'is-today' : ''}`} role="listitem" aria-label={label} title={label}>
          <b className="sfa-num" aria-hidden="true">{counts[i] || ''}</b>
          <div className={`sfa-bar__fill ${counts[i] ? '' : 'is-empty'}`} style={{ height: `${counts[i] ? Math.max(12, (counts[i]! / max) * 100) : 3}%` }} />
          <span aria-hidden="true">{isToday(day) ? 'Today' : format(day, 'EEE')}</span>
        </div>;
      })}
    </div>
    <p className="sfa-chartfoot">{total === 0 ? 'Nothing scheduled for the next 7 days.' : `${total} ${total === 1 ? 'post' : 'posts'} scheduled over the next 7 days.`}</p>
  </>;
}

export function DashboardPage() {
  const composer = useComposer();
  const go = useGo();
  const me = useAuthMe({ query: { queryKey: getAuthMeQueryKey(), retry: false } });
  const { data: postData, isLoading, isError, refetch } = useListPosts(undefined, { query: { queryKey: getListPostsQueryKey(), refetchInterval: 20_000 } });
  const { data: accountData, isLoading: accountsLoading } = useListConnectedAccounts();
  const posts = postData?.posts ?? [];
  const accounts = accountData?.accounts ?? [];
  const by = (status: Post['status']) => posts.filter((post) => post.status === status).length;
  const scheduled = posts.filter((post) => post.status === 'scheduled' && post.scheduledAt).sort((a, b) => new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime());
  const today = scheduled.filter((post) => isToday(new Date(post.scheduledAt!)));
  const upcoming = scheduled.filter((post) => !isToday(new Date(post.scheduledAt!))).slice(0, 5);
  const needsAttention = accounts.filter((account) => account.status !== 'active').length;
  const firstName = me.data?.user.displayName?.split(' ')[0];
  const recent = [...posts].filter((post) => post.status === 'published' || post.status === 'failed' || post.status === 'publishing')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 5);

  const stats = [
    { label: 'Queued', value: by('scheduled'), Icon: CalendarClock, tone: 'info', testid: 'stat-scheduled' },
    { label: 'Published', value: by('published'), Icon: CheckCheck, tone: 'success', testid: 'stat-published' },
    { label: 'Failed', value: by('failed'), Icon: TriangleAlert, tone: 'error', testid: 'stat-failed' },
    { label: 'Drafts', value: by('draft'), Icon: FilePen, tone: 'neutral', testid: 'stat-drafts' },
  ];
  const total = posts.length;
  const segments = [
    { key: 'published', label: 'Published', n: by('published') },
    { key: 'scheduled', label: 'Scheduled', n: by('scheduled') + by('publishing') },
    { key: 'draft', label: 'Drafts', n: by('draft') },
    { key: 'failed', label: 'Failed', n: by('failed') },
  ];

  const loaded = !isLoading && !accountsLoading;
  const steps = [
    { done: accounts.length > 0, title: 'Connect your first account', body: 'Link a Facebook Page, Instagram, LinkedIn, YouTube or X account so you can start scheduling posts.', action: <a className="sfa-btn sfa-btn--primary sfa-btn--sm" href="/workspace" onClick={go('/workspace')}>Connect accounts</a> },
    { done: posts.length > 0, title: 'Write your first post', body: 'Draft something now and finish it later, or schedule it straight away.', action: <Button size="sm" variant="secondary" onClick={() => composer.open()}>Create Post</Button> },
    { done: posts.some((post) => post.status === 'scheduled' || post.status === 'published'), title: 'Put a post on the calendar', body: 'Pick accounts, a date and a time. You can drag it to another day later.', action: <a className="sfa-btn sfa-btn--secondary sfa-btn--sm" href="/calendar" onClick={go('/calendar')}>Open calendar</a> },
  ];
  const currentStep = steps.findIndex((step) => !step.done);
  const showSteps = loaded && currentStep !== -1;

  return <div className="sfa-page" data-testid="page-dashboard">
    <PageHeader eyebrow={format(new Date(), 'EEEE, MMMM d')} title={`${greeting()}${firstName ? `, ${firstName}` : ''}`}
      description="Here’s what’s queued, what needs attention, and what’s coming up."
      actions={<>
        <a className="sfa-btn sfa-btn--secondary sfa-btn--md" href="/calendar" onClick={go('/calendar')}><CalendarDays size={15} /> Open calendar</a>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => composer.open()} data-testid="button-dashboard-create">Create Post</Button>
      </>} />

    {showSteps && <ol className="sfa-steps" aria-label="Get set up">
      {steps.map((step, i) => <li key={step.title} className={`sfa-step ${step.done ? 'is-done' : ''} ${i === currentStep ? 'is-current' : ''}`}>
        <span className="sfa-step__num" aria-hidden="true">{step.done ? <Check size={14} /> : i + 1}</span>
        <div>
          <strong>{step.title}{step.done && <span className="sr-only"> (done)</span>}</strong>
          <p>{step.body}</p>
          {!step.done && i === currentStep && step.action}
        </div>
      </li>)}
    </ol>}

    <div className="sfa-stats">
      {stats.map(({ label, value, Icon, tone, testid }) => <div className="sfa-stat" key={label} data-testid={testid}>
        <span className="sfa-stat__top"><span className={`sfa-stat__icon sfa-stat__icon--${tone}`}><Icon size={15} /></span>{label}</span>
        {isLoading ? <Skeleton width={48} height={30} className="sfa-stat__skel" /> : <strong>{value}</strong>}
      </div>)}
    </div>

    <div className="sfa-bento">
      <section className="sfa-card sfa-bento__today" aria-labelledby="today-posts" data-testid="card-today">
        <div className="sfa-card__head"><h2 id="today-posts"><CalendarClock size={16} /> Today</h2><span className="sfa-muted sfa-num">{format(new Date(), 'EEE, MMM d')}</span></div>
        {isError ? <ErrorState title="Couldn't load your posts" onRetry={() => refetch()} />
          : isLoading ? <ul className="sfa-rows" aria-busy="true">{[0, 1].map((i) => <li key={i} className="sfa-rowbtn"><Skeleton width={72} /><Skeleton width={22} height={22} radius={999} /><Skeleton width="60%" /></li>)}</ul>
          : today.length === 0
            ? <div className="sfa-today-empty">
              <strong>Nothing goes out today.</strong>
              <p>{scheduled[0] ? `Next up: ${format(new Date(scheduled[0].scheduledAt!), "EEE, MMM d 'at' h:mm a")}.` : 'Schedule a post or add one to the queue and it will appear here.'}</p>
            </div>
            : <ul className="sfa-timeline">{today.map((post) => <li key={post.id}><button className="sfa-timeline__item" onClick={() => composer.open({ post })}>
              <span className="sfa-timeline__time sfa-num">{format(new Date(post.scheduledAt!), 'h:mm a')}</span>
              <span className="sfa-timeline__dot" aria-hidden />
              <span className="sfa-chip__icons">{uniquePlatforms(post).map((platform) => <PlatformBadge key={platform} platform={platform} size={16} />)}</span>
              <span className="sfa-timeline__text">{snippet(post.content, 100)}</span>
            </button></li>)}</ul>}
      </section>

      <section className="sfa-card sfa-bento__create" aria-label="Quick create">
        <span className="sfa-eyebrow">Quick create</span>
        <h2>Start something new</h2>
        <div className="sfa-bento__actions">
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => composer.open()} data-testid="button-quick-create">New post</Button>
          <a className="sfa-btn sfa-btn--secondary sfa-btn--md" href="/queue" onClick={go('/queue')}><ListOrdered size={15} /> Queue times</a>
          <a className="sfa-btn sfa-btn--secondary sfa-btn--md" href="/recurring" onClick={go('/recurring')}><Repeat size={15} /> Recurring</a>
        </div>
      </section>

      <section className="sfa-card sfa-bento__status" aria-labelledby="pub-status" data-testid="card-status">
        <div className="sfa-card__head"><h2 id="pub-status"><CheckCheck size={16} /> Publishing status</h2><span className="sfa-muted sfa-num">{total} {total === 1 ? 'post' : 'posts'}</span></div>
        {isLoading ? <div className="sfa-statusbar-wrap"><Skeleton height={10} radius={999} /></div>
          : total === 0 ? <p className="sfa-muted sfa-pad">No posts yet. Status shows here once you create some.</p>
          : <div className="sfa-statusbar-wrap">
            <div className="sfa-statusbar" role="img" aria-label={segments.map((seg) => `${seg.n} ${seg.label.toLowerCase()}`).join(', ')}>
              {segments.filter((seg) => seg.n > 0).map((seg) => <span key={seg.key} className={`is-${seg.key}`} style={{ flexGrow: seg.n }} />)}
            </div>
            <ul className="sfa-statuslegend">{segments.map((seg) => <li key={seg.key}><i className={`is-${seg.key}`} aria-hidden /> {seg.label} <b className="sfa-num">{seg.n}</b></li>)}</ul>
          </div>}
      </section>

      <section className="sfa-card sfa-bento__week" aria-labelledby="next-seven">
        <div className="sfa-card__head"><h2 id="next-seven"><CalendarDays size={16} /> Next 7 days</h2></div>
        {isLoading ? <div className="sfa-bars" aria-busy="true">{[40, 70, 25, 55, 15, 80, 35].map((h, i) => <div key={i} className="sfa-bar"><Skeleton width="100%" height={`${h}%`} radius={5} /></div>)}</div> : <NextSevenDays posts={posts} />}
      </section>

      <section className="sfa-card sfa-bento__upcoming" aria-labelledby="coming-up">
        <div className="sfa-card__head"><h2 id="coming-up"><CalendarClock size={16} /> Upcoming content</h2><a className="sfa-linkbtn" href="/calendar" onClick={go('/calendar')}>Open calendar <ArrowRight size={13} /></a></div>
        {isLoading ? <ul className="sfa-rows" aria-busy="true">{[0, 1, 2].map((i) => <li key={i} className="sfa-rowbtn"><Skeleton width={96} /><Skeleton width={22} height={22} radius={999} /><Skeleton width="65%" /></li>)}</ul>
          : upcoming.length === 0
            ? <EmptyState icon={<CalendarClock size={22} />} title="Nothing else scheduled" description="Scheduled posts show up here in the order they’ll go out."
                action={<Button variant="primary" icon={<Plus size={15} />} onClick={() => composer.open()}>Create a post</Button>} />
            : <ul className="sfa-rows">{upcoming.map((post) => <li key={post.id}><button className="sfa-rowbtn" onClick={() => composer.open({ post })}>
                <span className="sfa-rowbtn__time sfa-num">{format(new Date(post.scheduledAt!), 'MMM d · h:mm a')}</span>
                <span className="sfa-chip__icons">{uniquePlatforms(post).map((platform) => <PlatformBadge key={platform} platform={platform} size={16} />)}</span>
                <span className="sfa-rowbtn__text">{snippet(post.content, 110)}</span>
              </button></li>)}</ul>}
      </section>

      <section className="sfa-card sfa-bento__activity" aria-labelledby="recent-activity" data-testid="card-activity">
        <div className="sfa-card__head"><h2 id="recent-activity"><History size={16} /> Recent activity</h2></div>
        {isLoading ? <ul className="sfa-rows">{[0, 1, 2].map((i) => <li key={i} className="sfa-acctrow"><Skeleton width={8} height={8} radius={999} /><Skeleton width="70%" /></li>)}</ul>
          : recent.length === 0 ? <p className="sfa-muted sfa-pad">Publishing results appear here as posts go out.</p>
          : <ul className="sfa-activity">{recent.map((post) => <li key={post.id}>
              <span className={`sfa-activity__dot is-${post.status}`} aria-hidden />
              <button onClick={() => composer.open({ post })}>
                <strong>{post.status === 'published' ? 'Published' : post.status === 'failed' ? 'Failed' : 'Publishing'}</strong>
                <span>{snippet(post.content, 60)}</span>
              </button>
              <span className="sfa-muted sfa-num">{formatDistanceToNow(new Date(post.updatedAt), { addSuffix: true })}</span>
            </li>)}</ul>}
      </section>

      <section className="sfa-card sfa-bento__accounts" aria-labelledby="accounts-health">
        <div className="sfa-card__head">
          <h2 id="accounts-health"><Network size={16} /> Accounts</h2>
          {needsAttention > 0 ? <span className="sfa-pill sfa-pill--warning">{needsAttention} need attention</span> : <a className="sfa-linkbtn" href="/workspace" onClick={go('/workspace')}>Manage</a>}
        </div>
        {accountsLoading ? <ul className="sfa-rows">{[0, 1].map((i) => <li key={i} className="sfa-acctrow"><Skeleton width={32} height={32} radius={999} /><Skeleton width="50%" /></li>)}</ul>
          : accounts.length === 0 ? <EmptyState icon={<Network size={22} />} title="No accounts connected" description="Connect a social account to start scheduling."
              action={<a className="sfa-btn sfa-btn--primary sfa-btn--md" href="/workspace" onClick={go('/workspace')}>Connect accounts</a>} />
          : <ul className="sfa-rows">{accounts.slice(0, 5).map((account) => <li key={account.id} className="sfa-acctrow">
              <AccountAvatar account={account} size={32} />
              <div><strong>{account.displayName}</strong></div>
              <span className={`sfa-pill sfa-pill--${ACCOUNT_STATUS[account.status].tone}`}>{ACCOUNT_STATUS[account.status].label}</span>
            </li>)}
            {accounts.length > 5 && <li className="sfa-acctrow"><a className="sfa-linkbtn" href="/workspace" onClick={go('/workspace')}>View all {accounts.length} accounts</a></li>}
          </ul>}
      </section>

      <section className="sfa-card sfa-bento__insights" aria-labelledby="insights" data-testid="card-insights">
        <div className="sfa-card__head"><h2 id="insights"><Sparkles size={16} /> Insights</h2><span className="sfa-pill sfa-pill--draft">Not connected</span></div>
        <p className="sfa-muted sfa-pad">Engagement, reach and AI suggestions appear here once analytics and AI are connected. Until then this shows nothing rather than made-up numbers.</p>
        <div className="sfa-pad sfa-bento__links"><a className="sfa-linkbtn" href="/analytics" onClick={go('/analytics')}>What analytics needs <ArrowRight size={13} /></a><a className="sfa-linkbtn" href="/ai" onClick={go('/ai')}>What AI needs <ArrowRight size={13} /></a></div>
      </section>
    </div>
  </div>;
}
