import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  addDays, addMonths, addWeeks, eachDayOfInterval, endOfDay, endOfMonth, endOfWeek, format,
  getHours, isBefore, isSameDay, isSameMonth, isToday, setHours, startOfDay, startOfMonth, startOfWeek,
} from 'date-fns';
import { CalendarPlus, Check, CheckCheck, ChevronLeft, ChevronRight, Filter, Plus, RefreshCw, Repeat, Search, TriangleAlert } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { getListConnectedAccountsQueryKey, getListPostsQueryKey, getListTagsQueryKey, useListConnectedAccounts, useListPosts, useListTags, useUpdatePost, type Platform, type Post } from '@workspace/api-client-react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { useToast } from '@/hooks/use-toast';
import { useComposer } from './composer';
import { PLATFORM_META, PlatformBadge, STATUS_LABEL, StatusPill, snippet, uniquePlatforms } from './platforms';
import { Button, EmptyState, IconButton, PageHeader, Spinner } from './ui';

type View = 'list' | 'day' | 'week' | 'month';
const VIEWS: View[] = ['list', 'day', 'week', 'month'];
const MAX_CHIPS = 3;

function StatusIcon({ status }: { status: Post['status'] }) {
  if (status === 'published') return <CheckCheck size={13} className="sfa-chip__status is-published" aria-label="Published" />;
  if (status === 'failed') return <TriangleAlert size={13} className="sfa-chip__status is-failed" aria-label="Failed" />;
  if (status === 'scheduled') return <Check size={13} className="sfa-chip__status is-scheduled" aria-label="Scheduled" />;
  if (status === 'publishing') return <Spinner size={12} />;
  return null;
}

function PostPreview({ post }: { post: Post }) {
  const failed = post.targets.find((target) => target.errorMessage);
  return <div className="sfa-hover">
    <div className="sfa-hover__head">
      <StatusPill status={post.status} />
      <span className="sfa-hover__when">{post.scheduledAt ? format(new Date(post.scheduledAt), "EEE, MMM d 'at' h:mm a") : 'Not scheduled'}</span>
    </div>
    <p>{post.content.trim() || 'Untitled draft'}</p>
    {post.targets.length > 0 && <ul>
      {post.targets.map((target) => <li key={target.connectedAccountId}><PlatformBadge platform={target.platform} size={14} /><span>{target.accountName}</span></li>)}
    </ul>}
    {failed && <span className="sfa-hover__err">{failed.errorMessage}</span>}
  </div>;
}

function PostChip({ post, onOpen, showTime = true }: { post: Post; onOpen: (post: Post) => void; showTime?: boolean }) {
  const platforms = uniquePlatforms(post);
  // A failed post that already reached some accounts can't be moved: it can only be retried.
  const draggable = post.status === 'scheduled' || (post.status === 'failed' && !post.targets.some((target) => target.status === 'published'));
  return <HoverCard openDelay={350} closeDelay={80}>
    <HoverCardTrigger asChild>
      <button type="button" className={`sfa-chip sfa-chip--${post.status}`} draggable={draggable}
        onDragStart={(event) => { event.dataTransfer.setData('text/plain', post.id); event.dataTransfer.effectAllowed = 'move'; }}
        onClick={(event) => { event.stopPropagation(); onOpen(post); }} data-testid={`chip-post-${post.id}`}
        aria-label={`${STATUS_LABEL[post.status]}${post.scheduledAt ? ` at ${format(new Date(post.scheduledAt), 'h:mm a')}` : ''}: ${snippet(post.content, 80)}`}>
        <span className="sfa-chip__top">
          <span className="sfa-chip__icons">{platforms.slice(0, 2).map((platform) => <PlatformBadge key={platform} platform={platform} size={14} />)}{platforms.length > 2 && <em>+{platforms.length - 2}</em>}</span>
          <span className="sfa-chip__name">{post.targets.length > 0 ? `${post.targets[0]!.accountName}${post.targets.length > 1 ? ` +${post.targets.length - 1}` : ''}` : 'No accounts'}</span>
          <StatusIcon status={post.status} />
        </span>
        <span className="sfa-chip__text">{showTime && post.scheduledAt && <b className="sfa-chip__time">{format(new Date(post.scheduledAt), 'h:mm a')}</b>}{post.recurrenceId && <Repeat size={11} className="sfa-chip__repeat" aria-label="Recurring" />}{snippet(post.content, 70)}</span>
        {post.tags.length > 0 && <span className="sfa-chip__tags" aria-label="Tags">{post.tags.slice(0, 3).map((tag) => <i key={tag.id} style={{ background: tag.color }} title={tag.name} />)}</span>}
      </button>
    </HoverCardTrigger>
    <HoverCardContent side="right" align="start" className="sfa-hovercard">
      <PostPreview post={post} />
    </HoverCardContent>
  </HoverCard>;
}

export function CalendarPage() {
  const composer = useComposer();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>('month');
  const [cursor, setCursor] = useState(() => new Date());
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | Post['status']>('all');
  const [platformFilter, setPlatformFilter] = useState<'all' | Platform>('all');
  const [tagFilter, setTagFilter] = useState<'all' | string>('all');
  const [accountFilter, setAccountFilter] = useState<'all' | string>('all');
  const { data: accountData } = useListConnectedAccounts({ query: { queryKey: getListConnectedAccountsQueryKey() } });
  const { data: tagData } = useListTags({ query: { queryKey: getListTagsQueryKey() } });
  const [filterOpen, setFilterOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  const range = useMemo(() => {
    if (view === 'day') return { start: startOfDay(cursor), end: endOfDay(cursor) };
    if (view === 'week') return { start: startOfWeek(cursor), end: endOfWeek(cursor) };
    return { start: startOfWeek(startOfMonth(cursor)), end: endOfWeek(endOfMonth(cursor)) };
  }, [view, cursor]);

  const params = { from: range.start.toISOString(), to: range.end.toISOString() };
  const { data, isLoading, isFetching, isError, refetch } = useListPosts(params, { query: { queryKey: getListPostsQueryKey(params), refetchInterval: 20_000 } });

  const posts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.posts ?? []).filter((post) => {
      if (statusFilter !== 'all' && post.status !== statusFilter) return false;
      if (platformFilter !== 'all' && !post.targets.some((target) => target.platform === platformFilter)) return false;
      if (tagFilter !== 'all' && !post.tags.some((tag) => tag.id === tagFilter)) return false;
      if (accountFilter !== 'all' && !post.targets.some((target) => target.connectedAccountId === accountFilter)) return false;
      const haystack = [post.content, ...Object.values(post.platformContent ?? {})].join(' ').toLowerCase();
      if (term && !haystack.includes(term) && !post.targets.some((target) => target.accountName.toLowerCase().includes(term)) && !post.tags.some((tag) => tag.name.toLowerCase().includes(term))) return false;
      return true;
    });
  }, [data, search, statusFilter, platformFilter, tagFilter, accountFilter]);

  const activeFilters = (statusFilter !== 'all' ? 1 : 0) + (platformFilter !== 'all' ? 1 : 0) + (tagFilter !== 'all' ? 1 : 0) + (accountFilter !== 'all' ? 1 : 0);
  const postsOn = (day: Date) => posts.filter((post) => post.scheduledAt && isSameDay(new Date(post.scheduledAt), day));

  // "/" focuses search; Escape or a click outside closes the filter panel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === 'Escape' && filterOpen) setFilterOpen(false);
    };
    const onDown = (event: MouseEvent) => { if (filterOpen && filterRef.current && !filterRef.current.contains(event.target as Node)) setFilterOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [filterOpen]);

  const update = useUpdatePost({
    mutation: {
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: [getListPostsQueryKey()[0]] }); toast({ title: 'Post rescheduled' }); },
      onError: (err) => toast({ title: "Couldn't reschedule", description: err.data?.message ?? 'Please try again.', variant: 'destructive' }),
    },
  });

  const openPost = (post: Post) => composer.open({ post });
  const canCreateOn = (day: Date) => !isBefore(endOfDay(day), new Date());

  /** Moves a dragged post to another day (keeping its time) or another hour of a day. */
  const dropOn = (event: DragEvent, day: Date, hour?: number) => {
    event.preventDefault();
    (event.currentTarget as HTMLElement).classList.remove('is-dropping');
    const post = data?.posts.find((candidate) => candidate.id === event.dataTransfer.getData('text/plain'));
    if (!post || !post.scheduledAt) return;
    const original = new Date(post.scheduledAt);
    const target = new Date(day);
    target.setHours(hour ?? original.getHours(), original.getMinutes(), 0, 0);
    if (target.getTime() <= Date.now()) { toast({ title: 'Pick a time in the future', variant: 'destructive' }); return; }
    if (target.getTime() === original.getTime()) return;
    update.mutate({ postId: post.id, data: { scheduledAt: target.toISOString() } });
  };
  const allowDrop = (event: DragEvent) => { event.preventDefault(); (event.currentTarget as HTMLElement).classList.add('is-dropping'); };
  const leaveDrop = (event: DragEvent) => (event.currentTarget as HTMLElement).classList.remove('is-dropping');

  const step = (direction: 1 | -1) => setCursor((current) => view === 'month' || view === 'list' ? addMonths(current, direction) : view === 'week' ? addWeeks(current, direction) : addDays(current, direction));
  const title = view === 'day' ? format(cursor, 'EEEE, MMMM d, yyyy')
    : view === 'week' ? `${format(range.start, 'MMM d')} – ${format(range.end, 'MMM d, yyyy')}`
    : format(cursor, 'MMMM yyyy');
  const onCurrent = view === 'day' ? isToday(cursor) : view === 'week' ? isSameDay(startOfWeek(cursor), startOfWeek(new Date())) : isSameMonth(cursor, new Date());
  const emptyRange = !isLoading && !isError && posts.length === 0;

  return <div className="sfa-page" data-testid="page-calendar">
    <PageHeader title="Calendar" description="Plan, preview and reschedule every post. Drag a scheduled post to another day to move it." />

    <div className="sfa-card sfa-cal">
      <div className="sfa-cal__tools">
        <div className="sfa-seg" role="tablist" aria-label="Calendar view">
          {VIEWS.map((option) => <button key={option} role="tab" aria-selected={view === option} className={view === option ? 'is-on' : ''} onClick={() => setView(option)} data-testid={`tab-view-${option}`}>{option[0]!.toUpperCase() + option.slice(1)}</button>)}
        </div>
        <label className="sfa-search">
          <Search size={15} />
          <span className="sr-only">Search posts</span>
          <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search a post" data-testid="input-search-posts" />
          {search ? <button type="button" className="sfa-search__clear" onClick={() => setSearch('')} aria-label="Clear search">×</button> : <kbd className="sfa-kbd" aria-hidden="true">/</kbd>}
        </label>
        <div className="sfa-filterwrap" ref={filterRef}>
          <Button variant={activeFilters > 0 ? 'outline' : 'secondary'} icon={<Filter size={15} />} onClick={() => setFilterOpen((open) => !open)} aria-expanded={filterOpen} aria-haspopup="dialog" data-testid="button-filter-posts">
            <span className="sfa-hide-sm">Filter Posts</span>{activeFilters > 0 && <span className="sfa-count sfa-count--primary">{activeFilters}</span>}
          </Button>
          {filterOpen && <div className="sfa-popover" role="dialog" aria-label="Filter posts">
            <label>Status<select className="sfa-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} data-testid="select-filter-status">
              <option value="all">All statuses</option>{(['scheduled', 'publishing', 'published', 'failed', 'draft'] as const).map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
            </select></label>
            <label>Network<select className="sfa-select" value={platformFilter} onChange={(event) => setPlatformFilter(event.target.value as typeof platformFilter)} data-testid="select-filter-platform">
              <option value="all">All networks</option>{(Object.keys(PLATFORM_META) as Platform[]).map((platform) => <option key={platform} value={platform}>{PLATFORM_META[platform].name}</option>)}
            </select></label>
            <label>Account<select className="sfa-select" value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)} data-testid="select-filter-account">
              <option value="all">All accounts</option>{(accountData?.accounts ?? []).map((account) => <option key={account.id} value={account.id}>{account.displayName} ({PLATFORM_META[account.platform].name})</option>)}
            </select></label>
            <label>Tag<select className="sfa-select" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} data-testid="select-filter-tag">
              <option value="all">All tags</option>{(tagData?.tags ?? []).map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select></label>
            {activeFilters > 0 && <button className="sfa-linkbtn" onClick={() => { setStatusFilter('all'); setPlatformFilter('all'); setTagFilter('all'); setAccountFilter('all'); }}>Clear filters</button>}
          </div>}
        </div>
        <div className="sfa-cal__nav">
          {isFetching && !isLoading && <span className="sfa-muted" aria-live="polite"><Spinner size={14} /><span className="sr-only">Updating</span></span>}
          <Button variant="secondary" size="sm" onClick={() => setCursor(new Date())} disabled={onCurrent} data-testid="button-cal-today">Today</Button>
          <IconButton label="Previous" onClick={() => step(-1)} data-testid="button-cal-prev"><ChevronLeft size={18} /></IconButton>
          <h2 className="sfa-cal__title" aria-live="polite" data-testid="text-cal-title">{title}</h2>
          <IconButton label="Next" onClick={() => step(1)} data-testid="button-cal-next"><ChevronRight size={18} /></IconButton>
        </div>
      </div>

      <div className="sfa-legend" aria-label="Legend">
        <span><i style={{ background: 'hsl(var(--info))' }} /> Scheduled</span>
        <span><i style={{ background: 'hsl(var(--success))' }} /> Published</span>
        <span><i style={{ background: 'hsl(var(--error))' }} /> Failed</span>
        <span><i style={{ background: 'hsl(var(--border-strong))' }} /> Draft</span>
        {emptyRange && view !== 'list' && <span className="sfa-legend__hint">{search || activeFilters ? 'No posts match your search or filters.' : 'No posts here yet. Click any upcoming day to schedule one.'}</span>}
      </div>

      {isError && <div className="sfa-alert sfa-alert--bar" role="alert"><TriangleAlert size={15} /> <span>Couldn't load your posts.</span><Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={() => refetch()}>Try again</Button></div>}

      {view === 'month' && <MonthGrid range={range} cursor={cursor} postsOn={postsOn} loading={isLoading} canCreateOn={canCreateOn}
        onOpen={openPost} onCreate={(day) => composer.open({ date: day })} onMore={(day) => { setCursor(day); setView('day'); }} allowDrop={allowDrop} leaveDrop={leaveDrop} onDrop={dropOn} />}
      {(view === 'week' || view === 'day') && <TimeGrid days={view === 'week' ? eachDayOfInterval(range) : [cursor]} postsOn={postsOn} canCreateOn={canCreateOn}
        onOpen={openPost} onCreate={(day, hour) => composer.open({ date: setHours(day, hour) })} allowDrop={allowDrop} leaveDrop={leaveDrop} onDrop={dropOn} />}
      {view === 'list' && <ListView posts={posts.filter((post) => post.scheduledAt && isSameMonth(new Date(post.scheduledAt), cursor))} loading={isLoading} filtered={Boolean(search || activeFilters)} onOpen={openPost} onCreate={() => composer.open()} />}
    </div>
  </div>;
}

type DropProps = { allowDrop: (event: DragEvent) => void; leaveDrop: (event: DragEvent) => void };

function MonthGrid({ range, cursor, postsOn, loading, canCreateOn, onOpen, onCreate, onMore, allowDrop, leaveDrop, onDrop }: DropProps & {
  range: { start: Date; end: Date }; cursor: Date; postsOn: (day: Date) => Post[]; loading: boolean; canCreateOn: (day: Date) => boolean;
  onOpen: (post: Post) => void; onCreate: (day: Date) => void; onMore: (day: Date) => void; onDrop: (event: DragEvent, day: Date) => void;
}) {
  const days = eachDayOfInterval(range);
  return <div className={`sfa-month ${loading ? 'is-loading' : ''}`} aria-busy={loading} role="grid" aria-label={format(cursor, 'MMMM yyyy')}>
    {days.slice(0, 7).map((day) => <div key={format(day, 'EEE')} className="sfa-month__dow" role="columnheader"><span className="sfa-dow--long">{format(day, 'EEEE')}</span><span className="sfa-dow--short" aria-hidden="true">{format(day, 'EEEEE')}</span></div>)}
    {days.map((day) => {
      const dayPosts = postsOn(day);
      const creatable = canCreateOn(day);
      return <div key={day.toISOString()} role="gridcell" aria-label={`${format(day, 'EEEE, MMMM d')}${dayPosts.length ? `, ${dayPosts.length} ${dayPosts.length === 1 ? 'post' : 'posts'}` : ''}`}
        className={`sfa-day ${isSameMonth(day, cursor) ? '' : 'is-outside'} ${isToday(day) ? 'is-today' : ''} ${creatable ? 'is-creatable' : 'is-past'}`}
        onClick={() => { if (creatable) onCreate(day); }} onDragOver={allowDrop} onDragLeave={leaveDrop} onDrop={(event) => onDrop(event, day)} data-testid={`cell-day-${format(day, 'yyyy-MM-dd')}`}>
        <span className="sfa-day__num">{format(day, 'd')}</span>
        {dayPosts.slice(0, MAX_CHIPS).map((post) => <PostChip key={post.id} post={post} onOpen={onOpen} />)}
        {dayPosts.length > MAX_CHIPS && <button className="sfa-more" onClick={(event) => { event.stopPropagation(); onMore(day); }}>+{dayPosts.length - MAX_CHIPS} more</button>}
        {creatable && dayPosts.length === 0 && <span className="sfa-day__add" aria-hidden><Plus size={14} /></span>}
      </div>;
    })}
  </div>;
}

function TimeGrid({ days, postsOn, canCreateOn, onOpen, onCreate, allowDrop, leaveDrop, onDrop }: DropProps & {
  days: Date[]; postsOn: (day: Date) => Post[]; canCreateOn: (day: Date) => boolean; onOpen: (post: Post) => void;
  onCreate: (day: Date, hour: number) => void; onDrop: (event: DragEvent, day: Date, hour: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 7 * 56; }, [days.length]);
  const now = new Date();
  return <div className="sfa-time" ref={scroller} style={{ ['--cols' as string]: days.length }}>
    <div className="sfa-time__head"><span />{days.map((day) => <div key={day.toISOString()} className={isToday(day) ? 'is-today' : ''}><small>{format(day, 'EEE')}</small><strong>{format(day, 'd')}</strong></div>)}</div>
    {Array.from({ length: 24 }, (_, hour) => <div className={`sfa-time__row ${days.some((day) => isToday(day)) && hour === now.getHours() ? 'is-now' : ''}`} key={hour}>
      <span className="sfa-time__label">{format(setHours(new Date(), hour), 'h a')}</span>
      {days.map((day) => {
        const slot = postsOn(day).filter((post) => getHours(new Date(post.scheduledAt!)) === hour);
        const creatable = canCreateOn(day) && (!isSameDay(day, now) || hour > now.getHours());
        return <div key={day.toISOString()} className={`sfa-slot ${creatable ? 'is-creatable' : ''}`} onClick={() => { if (creatable) onCreate(day, hour); }}
          onDragOver={allowDrop} onDragLeave={leaveDrop} onDrop={(event) => onDrop(event, day, hour)}>
          {slot.map((post) => <PostChip key={post.id} post={post} onOpen={onOpen} />)}
        </div>;
      })}
    </div>)}
  </div>;
}

function ListView({ posts, loading, filtered, onOpen, onCreate }: { posts: Post[]; loading: boolean; filtered: boolean; onOpen: (post: Post) => void; onCreate: () => void }) {
  if (loading) return <div className="sfa-list" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="sfa-listrow sfa-listrow--skel"><span className="sfa-skel" style={{ width: 64, height: 12 }} /><span className="sfa-skel" style={{ width: 22, height: 22, borderRadius: 999 }} /><span className="sfa-skel" style={{ width: '70%', height: 12 }} /></div>)}</div>;
  if (posts.length === 0) return <EmptyState icon={<CalendarPlus size={22} />} title={filtered ? 'No matching posts' : 'No posts this month'}
    description={filtered ? 'Try a different search or clear your filters.' : 'Scheduled posts for this month will be listed here, grouped by day.'}
    action={filtered ? undefined : <Button variant="primary" icon={<Plus size={15} />} onClick={onCreate}>Create Post</Button>} />;
  const groups = new Map<string, Post[]>();
  for (const post of posts) {
    const key = format(new Date(post.scheduledAt!), 'yyyy-MM-dd');
    groups.set(key, [...(groups.get(key) ?? []), post]);
  }
  return <div className="sfa-list">
    {[...groups.entries()].map(([key, group]) => <section key={key}>
      <h3>{format(new Date(`${key}T00:00`), 'EEEE, MMMM d')}</h3>
      {group.map((post) => <button key={post.id} className="sfa-listrow" onClick={() => onOpen(post)} data-testid={`row-post-${post.id}`}>
        <span className="sfa-listrow__time">{format(new Date(post.scheduledAt!), 'h:mm a')}</span>
        <span className="sfa-chip__icons">{uniquePlatforms(post).map((platform) => <PlatformBadge key={platform} platform={platform} size={16} />)}</span>
        <span className="sfa-listrow__text">{snippet(post.content, 140)}</span>
        <StatusPill status={post.status} />
      </button>)}
    </section>)}
  </div>;
}
