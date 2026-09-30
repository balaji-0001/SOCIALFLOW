import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { format } from 'date-fns';
import { ArrowDown, ArrowUp, CalendarClock, Clock, Copy, ListOrdered, Network, Pause, Play, Plus, Save, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetQueueQueryKey,
  getListConnectedAccountsQueryKey,
  getListPostsQueryKey,
  getListQueuedPostsQueryKey,
  getListQueuesQueryKey,
  useGetQueue,
  useListConnectedAccounts,
  useListQueuedPosts,
  useListQueues,
  useReorderQueue,
  useUpdatePost,
  useUpdateQueue,
  type ConnectedAccount,
  type Post,
  type Queue,
  type Tag,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { useComposer } from './composer';
import { useConfirm } from './confirm';
import { AccountAvatar, PlatformBadge, snippet } from './platforms';
import { Button, EmptyState, ErrorState, IconButton, PageHeader, Skeleton } from './ui';
import './queue.css';

/* ---------- Time zones ---------- */

const FALLBACK_ZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
];

function browserZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Every IANA zone the browser knows, or a short list on older engines. Always includes `current`. */
function timeZones(current: string): string[] {
  let zones: string[] = FALLBACK_ZONES;
  try {
    if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone');
  } catch { /* keep the fallback list */ }
  return current && !zones.includes(current) ? [current, ...zones] : zones;
}

/* ---------- Schedule helpers ---------- */

type SlotDraft = { weekday: number; time: string };

/** Monday-first column order; weekday numbers stay 0=Sun..6=Sat as the API expects. */
const COLUMNS = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DEFAULT_TIME = '09:00';
const PRESETS = [
  { key: 'weekdays-9', label: 'Weekdays at 9:00 AM', times: ['09:00'], days: [1, 2, 3, 4, 5] },
  { key: 'weekdays-2', label: 'Weekdays at 9:00 AM and 3:00 PM', times: ['09:00', '15:00'], days: [1, 2, 3, 4, 5] },
  { key: 'daily-10', label: 'Every day at 10:00 AM', times: ['10:00'], days: [0, 1, 2, 3, 4, 5, 6] },
];

function sortSlots(slots: SlotDraft[]): SlotDraft[] {
  const seen = new Set<string>();
  return slots
    .filter((slot) => { const key = `${slot.weekday}-${slot.time}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time));
}

function serialize(timezone: string, slots: SlotDraft[]): string {
  return `${timezone}|${sortSlots(slots).map((slot) => `${slot.weekday}:${slot.time}`).join(',')}`;
}

/** "HH:MM" (24h) → "9:00 AM" for display. */
function clock(time: string): string {
  const [h, m] = time.split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return time;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function TagChips({ tags }: { tags: Tag[] }) {
  if (tags.length === 0) return null;
  return <span className="sfa-q-tags" aria-label="Tags">
    {tags.map((tag) => <span key={tag.id} className="sfa-tagchip sfa-q-tag"><i style={{ background: tag.color }} aria-hidden="true" />{tag.name}</span>)}
  </span>;
}

/* ---------- Account list (left) ---------- */

function AccountList({ accounts, queues, activeId, onSelect }: { accounts: ConnectedAccount[]; queues: Queue[]; activeId: string | null; onSelect: (id: string) => void }) {
  return <ul className="sfa-q-accounts" role="listbox" aria-label="Accounts">
    {accounts.map((account) => {
      const queue = queues.find((item) => item.connectedAccountId === account.id);
      const count = queue?.slots.length ?? 0;
      const selected = account.id === activeId;
      return <li key={account.id} role="presentation">
        <button type="button" role="option" aria-selected={selected} className={`sfa-q-account ${selected ? 'is-on' : ''}`}
          onClick={() => onSelect(account.id)} data-testid={`button-queue-account-${account.id}`}>
          <AccountAvatar account={account} size={34} />
          <span className="sfa-q-account__copy">
            <strong>{account.displayName}</strong>
            <span className="sfa-q-account__meta">
              <PlatformBadge platform={account.platform} size={14} />
              <span className="sfa-muted sfa-num">{count} {count === 1 ? 'slot' : 'slots'}</span>
              {queue?.paused && <span className="sfa-pill sfa-pill--warning">Paused</span>}
            </span>
          </span>
        </button>
      </li>;
    })}
  </ul>;
}

/* ---------- Schedule editor (right) ---------- */

function EditorSkeleton() {
  return <div className="sfa-q-editor" aria-busy="true" aria-label="Loading schedule">
    <div className="sfa-q-editor__top"><Skeleton width={220} height={36} radius={8} /><Skeleton width={110} height={36} radius={8} /></div>
    <div className="sfa-q-grid">{COLUMNS.map((day) => <div key={day} className="sfa-q-col"><Skeleton width={40} /><Skeleton width="80%" height={30} radius={6} /><Skeleton width="80%" height={30} radius={6} /></div>)}</div>
  </div>;
}

function QueueEditor({ account }: { account: ConnectedAccount }) {
  const accountId = account.id;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: queue, isLoading, isError, error, refetch } = useGetQueue(accountId, { query: { queryKey: getGetQueueQueryKey(accountId) } });
  // A brand-new account has no schedule yet; treat "not found" as an empty one instead of an error.
  const missing = isError && error?.status === 404;
  const base = useMemo<Queue>(() => queue ?? { connectedAccountId: accountId, timezone: browserZone(), paused: false, slots: [] }, [queue, accountId]);

  const [timezone, setTimezone] = useState(base.timezone);
  const [slots, setSlots] = useState<SlotDraft[]>(() => base.slots.map(({ weekday, time }) => ({ weekday, time })));
  const [pending, setPending] = useState<Record<number, string>>({});
  const [action, setAction] = useState<'save' | 'pause' | null>(null);
  const hydratedFrom = useMemo(() => serialize(base.timezone, base.slots), [base]);
  // Fill the draft from the server once it arrives, and again after every successful save.
  useEffect(() => { setTimezone(base.timezone); setSlots(base.slots.map(({ weekday, time }) => ({ weekday, time }))); }, [hydratedFrom, base]);

  const dirty = serialize(timezone, slots) !== hydratedFrom;
  const zones = useMemo(() => timeZones(timezone), [timezone]);
  const localZone = browserZone();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: [getListQueuesQueryKey()[0]] });
    queryClient.invalidateQueries({ queryKey: getGetQueueQueryKey(accountId) });
    queryClient.invalidateQueries({ queryKey: getListQueuedPostsQueryKey(accountId) });
    queryClient.invalidateQueries({ queryKey: [getListPostsQueryKey()[0]] });
  };
  const update = useUpdateQueue({
    mutation: {
      onSuccess: (saved) => {
        queryClient.setQueryData(getGetQueueQueryKey(accountId), saved);
        refresh();
        toast({ title: action === 'pause' ? (saved.paused ? 'Queue paused' : 'Queue resumed') : 'Posting times saved' });
        setAction(null);
      },
      onError: (err) => { setAction(null); toast({ title: "Couldn't save the schedule", description: err.data?.message ?? undefined, variant: 'destructive' }); },
    },
  });
  const saving = update.isPending;

  const timesFor = (weekday: number) => slots.filter((slot) => slot.weekday === weekday).map((slot) => slot.time).sort();
  const addTime = (weekday: number) => {
    const time = pending[weekday] || DEFAULT_TIME;
    if (!/^\d{2}:\d{2}$/.test(time)) return;
    setSlots((current) => sortSlots([...current, { weekday, time }]));
    setPending((current) => ({ ...current, [weekday]: '' }));
  };
  const removeTime = (weekday: number, time: string) => setSlots((current) => current.filter((slot) => !(slot.weekday === weekday && slot.time === time)));
  const copyWeekdays = () => {
    const monday = timesFor(1);
    setSlots((current) => sortSlots([...current.filter((slot) => slot.weekday === 0 || slot.weekday === 1 || slot.weekday === 6), ...[2, 3, 4, 5].flatMap((weekday) => monday.map((time) => ({ weekday, time })))]));
  };
  const applyPreset = (times: string[], days: number[]) => {
    const next = sortSlots(days.flatMap((weekday) => times.map((time) => ({ weekday, time }))));
    setSlots(next);
    setAction('save');
    update.mutate({ accountId, data: { timezone, paused: base.paused, slots: next } });
  };
  const onAdd = (weekday: number) => (event: FormEvent) => { event.preventDefault(); addTime(weekday); };

  const save = () => { setAction('save'); update.mutate({ accountId, data: { timezone, paused: base.paused, slots: sortSlots(slots) } }); };
  const togglePause = () => { setAction('pause'); update.mutate({ accountId, data: { timezone: base.timezone, paused: !base.paused, slots: base.slots.map(({ weekday, time }) => ({ weekday, time })) } }); };

  if (isError && !missing) return <ErrorState title="Couldn't load this schedule" onRetry={() => refetch()} />;
  if (isLoading) return <EditorSkeleton />;

  const total = slots.length;
  const nextSlots = (base.nextSlots ?? []).slice(0, 5);

  return <div className="sfa-q-editor" data-testid="queue-editor">
    <div className="sfa-q-editor__top">
      <div className="sfa-q-editor__who">
        <AccountAvatar account={account} size={40} />
        <div>
          <h2>{account.displayName}</h2>
          <span className="sfa-muted">{total} posting {total === 1 ? 'time' : 'times'} a week{base.paused ? ' · paused' : ''}</span>
        </div>
      </div>
      <div className="sfa-q-editor__actions">
        <Button variant={base.paused ? 'primary' : 'secondary'} icon={base.paused ? <Play size={14} /> : <Pause size={14} />} disabled={saving} loading={saving && action === 'pause'}
          onClick={togglePause} data-testid="button-queue-pause">{base.paused ? 'Resume queue' : 'Pause queue'}</Button>
        <Button variant="primary" icon={<Save size={14} />} disabled={!dirty || saving} loading={saving && action === 'save'} onClick={save} data-testid="button-queue-save">Save</Button>
      </div>
    </div>

    {base.paused && <p className="sfa-q-notice" role="status"><Pause size={14} aria-hidden="true" /> This queue is paused. Posts stay scheduled but Add to Queue won’t pick new slots until you resume.</p>}

    <div className="sfa-q-toolbar">
      <label className="sfa-q-field">
        <span className="sfa-label">Time zone</span>
        <select className="sfa-select" value={timezone} onChange={(event) => setTimezone(event.target.value)} disabled={saving} data-testid="select-queue-timezone">
          {zones.map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>)}
        </select>
      </label>
      <Button variant="outline" size="sm" icon={<Copy size={13} />} disabled={saving || timesFor(1).length === 0} onClick={copyWeekdays} title="Copy Monday’s times to Tuesday–Friday" data-testid="button-queue-copy-weekdays">Copy Mon–Fri</Button>
    </div>

    <div className="sfa-q-grid" role="group" aria-label="Weekly posting times">
      {COLUMNS.map((weekday) => {
        const times = timesFor(weekday);
        const inputId = `queue-time-${weekday}`;
        return <section key={weekday} className="sfa-q-col" aria-labelledby={`queue-day-${weekday}`}>
          <h3 id={`queue-day-${weekday}`}><span className="sfa-q-col__long">{WEEKDAY_LONG[weekday]}</span><span className="sfa-q-col__short" aria-hidden="true">{WEEKDAY_SHORT[weekday]}</span><span className="sfa-count sfa-num">{times.length}</span></h3>
          {times.length === 0
            ? <p className="sfa-q-col__empty">No times</p>
            : <ul className="sfa-q-times">
              {times.map((time) => <li key={time} className="sfa-q-time">
                <span className="sfa-num">{clock(time)}</span>
                <IconButton label={`Remove ${clock(time)} on ${WEEKDAY_LONG[weekday]}`} className="sfa-q-time__remove" disabled={saving} onClick={() => removeTime(weekday, time)} data-testid={`button-queue-remove-${weekday}-${time}`}><X size={13} /></IconButton>
              </li>)}
            </ul>}
          <form className="sfa-q-add" onSubmit={onAdd(weekday)}>
            <label htmlFor={inputId} className="sr-only">Add a time on {WEEKDAY_LONG[weekday]}</label>
            <input id={inputId} type="time" className="sfa-input" value={pending[weekday] || DEFAULT_TIME} disabled={saving} onChange={(event) => setPending((current) => ({ ...current, [weekday]: event.target.value }))} data-testid={`input-queue-time-${weekday}`} />
            <IconButton type="submit" label={`Add time on ${WEEKDAY_LONG[weekday]}`} disabled={saving || !(pending[weekday] || DEFAULT_TIME)} className="sfa-q-add__btn" data-testid={`button-queue-add-${weekday}`}><Plus size={15} /></IconButton>
          </form>
        </section>;
      })}
    </div>

    {total === 0 && <EmptyState icon={<Clock size={22} />} title="No posting times yet" description="Pick a starting point below (it saves straight away), or add times to any day above and press Save. Add to Queue in the composer uses the next free time."
      action={<div className="sfa-q-presets" role="group" aria-label="Quick start">
        {PRESETS.map((preset) => <Button key={preset.label} variant="secondary" size="sm" disabled={saving} onClick={() => applyPreset(preset.times, preset.days)} data-testid={`button-queue-preset-${preset.key}`}>{preset.label}</Button>)}
      </div>} />}

    {dirty && <p className="sfa-q-unsaved" role="status">You have unsaved changes. Times only count for the queue once you save. <Button variant="primary" size="sm" disabled={saving} loading={saving && action === 'save'} onClick={save} data-testid="button-queue-save-inline">Save now</Button></p>}

    <section className="sfa-q-next" aria-labelledby="queue-next">
      <h3 id="queue-next" className="sfa-label"><CalendarClock size={14} /> Next free slots</h3>
      {nextSlots.length === 0
        ? <p className="sfa-muted">{total === 0 ? 'Add posting times to see upcoming slots.' : base.paused ? 'Paused queues don’t offer slots.' : 'Every upcoming slot is taken.'}</p>
        : <ul className="sfa-q-next__list">
          {nextSlots.map((iso) => <li key={iso} className="sfa-num">{format(new Date(iso), 'EEE, MMM d · h:mm a')}</li>)}
        </ul>}
      {nextSlots.length > 0 && base.timezone !== localZone && <p className="sfa-muted">Shown in your local time ({localZone}); the queue runs in {base.timezone.replace(/_/g, ' ')}.</p>}
    </section>
  </div>;
}

/* ---------- Queued posts ---------- */

function QueuedPosts({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const composer = useComposer();
  const confirm = useConfirm();
  const { data, isLoading, isError, refetch } = useListQueuedPosts(accountId, { query: { queryKey: getListQueuedPostsQueryKey(accountId) } });
  const posts = data?.posts ?? [];

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListQueuedPostsQueryKey(accountId) });
    queryClient.invalidateQueries({ queryKey: [getListQueuesQueryKey()[0]] });
    queryClient.invalidateQueries({ queryKey: getGetQueueQueryKey(accountId) });
    queryClient.invalidateQueries({ queryKey: [getListPostsQueryKey()[0]] });
  };
  const reorder = useReorderQueue({
    mutation: {
      onSuccess: (result) => { queryClient.setQueryData(getListQueuedPostsQueryKey(accountId), result); refresh(); toast({ title: 'Queue reordered' }); },
      onError: (err) => { refresh(); toast({ title: "Couldn't reorder the queue", description: err.data?.message ?? undefined, variant: 'destructive' }); },
    },
  });
  const remove = useUpdatePost({
    mutation: {
      onSuccess: () => { refresh(); toast({ title: 'Removed from queue', description: 'The post is back in your drafts.' }); },
      onError: (err) => toast({ title: "Couldn't remove the post", description: err.data?.message ?? undefined, variant: 'destructive' }),
    },
  });
  const busy = reorder.isPending || remove.isPending;

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= posts.length) return;
    const ids = posts.map((post) => post.id);
    const [moved] = ids.splice(index, 1);
    if (!moved) return;
    ids.splice(target, 0, moved);
    reorder.mutate({ accountId, data: { postIds: ids } });
  };
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dropOn = (targetId: string) => {
    const from = posts.findIndex((post) => post.id === dragId);
    const to = posts.findIndex((post) => post.id === targetId);
    setDragId(null); setOverId(null);
    if (from < 0 || to < 0 || from === to || busy) return;
    const ids = posts.map((post) => post.id);
    const [moved] = ids.splice(from, 1);
    if (!moved) return;
    ids.splice(to, 0, moved);
    reorder.mutate({ accountId, data: { postIds: ids } });
  };
  const removeFromQueue = async (post: Post) => {
    if (await confirm({ title: 'Remove this post from the queue?', description: 'It goes back to your drafts and its slot is freed for the next post.', confirmLabel: 'Remove from queue' })) {
      remove.mutate({ postId: post.id, data: { scheduledAt: null } });
    }
  };

  return <section className="sfa-card sfa-q-queued" aria-labelledby="queue-list">
    <div className="sfa-card__head"><h2 id="queue-list"><ListOrdered size={16} /> In the queue {!isLoading && !isError && <span className="sfa-count sfa-num">{posts.length}</span>}</h2></div>
    {isError ? <ErrorState title="Couldn't load the queue" onRetry={() => refetch()} />
      : isLoading ? <ul className="sfa-rows" aria-busy="true" aria-label="Loading queued posts">{[0, 1, 2].map((i) => <li key={i} className="sfa-q-row sfa-q-row--skel"><Skeleton width={120} /><Skeleton width={`${70 - i * 10}%`} /><Skeleton width={160} height={28} radius={6} /></li>)}</ul>
      : posts.length === 0 ? <EmptyState icon={<CalendarClock size={22} />} title="Nothing queued" description="Posts added with Add to Queue in the composer line up here in the order they’ll go out." />
      : <ol className="sfa-rows sfa-q-list" aria-label="Queued posts, soonest first">
        {posts.map((post, index) => <li key={post.id} className={`sfa-q-row ${dragId === post.id ? 'is-dragging' : ''} ${overId === post.id && dragId !== post.id ? 'is-over' : ''}`} data-testid={`row-queued-${post.id}`} draggable={!busy}
          onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', post.id); setDragId(post.id); }}
          onDragEnd={() => { setDragId(null); setOverId(null); }}
          onDragOver={(event) => { if (dragId) { event.preventDefault(); setOverId(post.id); } }}
          onDrop={(event) => { event.preventDefault(); dropOn(post.id); }}>
          <span className="sfa-q-row__order" aria-hidden="true">{index + 1}</span>
          <span className="sfa-q-row__when sfa-num">{post.scheduledAt ? format(new Date(post.scheduledAt), 'EEE, MMM d · h:mm a') : 'Unscheduled'}</span>
          <span className="sfa-q-row__body">
            <button type="button" className="sfa-q-row__text" onClick={() => composer.open({ post })} title={post.content} data-testid={`button-queue-open-${post.id}`}>{snippet(post.content, 120)}</button>
            <TagChips tags={post.tags} />
          </span>
          <span className="sfa-q-row__actions">
            <IconButton label="Move up" disabled={busy || index === 0} onClick={() => move(index, -1)} data-testid={`button-queue-up-${post.id}`}><ArrowUp size={15} /></IconButton>
            <IconButton label="Move down" disabled={busy || index === posts.length - 1} onClick={() => move(index, 1)} data-testid={`button-queue-down-${post.id}`}><ArrowDown size={15} /></IconButton>
            <Button size="sm" variant="secondary" onClick={() => composer.open({ post })} data-testid={`button-queue-edit-${post.id}`}>Edit</Button>
            <Button size="sm" variant="ghost" disabled={busy} loading={remove.isPending && remove.variables?.postId === post.id} onClick={() => removeFromQueue(post)} data-testid={`button-queue-remove-post-${post.id}`}>Remove from queue</Button>
          </span>
        </li>)}
      </ol>}
  </section>;
}

/* ---------- Page ---------- */

export function QueuePage() {
  const { data: accountData, isLoading: accountsLoading, isError: accountsError, refetch: refetchAccounts } = useListConnectedAccounts({ query: { queryKey: getListConnectedAccountsQueryKey() } });
  const { data: queueData, isLoading: queuesLoading, isError: queuesError, refetch: refetchQueues } = useListQueues({ query: { queryKey: getListQueuesQueryKey() } });
  const accounts = accountData?.accounts ?? [];
  const queues = queueData?.queues ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const active = accounts.find((account) => account.id === selectedId) ?? accounts[0] ?? null;
  const loading = accountsLoading || queuesLoading;
  const failed = accountsError || queuesError;

  return <div className="sfa-page" data-testid="page-queue">
    <PageHeader title="Queue" description="Set posting times for each account. Add to Queue in the composer takes the next free slot." />
    {failed ? <div className="sfa-card"><ErrorState title="Couldn't load your queues" onRetry={() => { refetchAccounts(); refetchQueues(); }} /></div>
      : !loading && accounts.length === 0 ? <div className="sfa-card"><EmptyState icon={<Network size={22} />} title="No accounts connected" description="Connect a social account first, then set the times it should post at."
        action={<a className="sfa-btn sfa-btn--primary sfa-btn--md" href="/workspace">Connect accounts</a>} /></div>
      : <div className="sfa-q-layout">
        <aside className="sfa-card sfa-q-side" aria-label="Choose an account">
          <div className="sfa-card__head"><h2><Network size={16} /> Accounts</h2></div>
          {loading
            ? <ul className="sfa-q-accounts" aria-busy="true">{[0, 1, 2].map((i) => <li key={i} className="sfa-q-account"><Skeleton width={34} height={34} radius={999} /><span className="sfa-q-account__copy"><Skeleton width="60%" /><Skeleton width={70} /></span></li>)}</ul>
            : <AccountList accounts={accounts} queues={queues} activeId={active?.id ?? null} onSelect={setSelectedId} />}
        </aside>
        <div className="sfa-q-main">
          <section className="sfa-card sfa-q-editorcard" aria-label="Posting schedule">
            {loading || !active ? <EditorSkeleton /> : <QueueEditor key={active.id} account={active} />}
          </section>
          {active && <QueuedPosts key={active.id} accountId={active.id} />}
        </div>
      </div>}
  </div>;
}

export default QueuePage;
