import { useEffect, useMemo, useRef, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { CalendarClock, ChevronDown, Pause, Pencil, Play, Plus, Repeat, Trash2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetRecurrenceQueryKey,
  getListConnectedAccountsQueryKey,
  getListPostsQueryKey,
  getListRecurrencesQueryKey,
  getListTagsQueryKey,
  useDeleteRecurrence,
  useGetRecurrence,
  useListConnectedAccounts,
  useListRecurrences,
  useListTags,
  usePreviewRecurrence,
  useUpdateRecurrence,
  type ConnectedAccount,
  type Recurrence,
  type RecurrenceFrequency,
  type RecurrenceInput,
  type Tag,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { useComposer } from './composer';
import { useConfirm } from './confirm';
import { AccountAvatar, StatusPill, snippet } from './platforms';
import { Button, EmptyState, ErrorState, IconButton, PageHeader, Skeleton } from './ui';
import './queue.css';

/* ---------- Time zones ---------- */

const FALLBACK_ZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
];

function timeZones(current: string): string[] {
  let zones: string[] = FALLBACK_ZONES;
  try {
    if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone');
  } catch { /* keep the fallback list */ }
  return current && !zones.includes(current) ? [current, ...zones] : zones;
}

/* ---------- Rule wording ---------- */

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

type RuleShape = Pick<Recurrence, 'frequency' | 'interval' | 'weekdays' | 'dayOfMonth' | 'time' | 'timezone'>;

/** "Weekly on Mon, Wed at 09:00 (Asia/Kolkata)", "Every 2 days at 10:00", "Monthly on the 15th at 09:00". */
function describeRule(rule: RuleShape, withZone = true): string {
  const every = rule.interval > 1;
  let text: string;
  if (rule.frequency === 'daily') {
    text = every ? `Every ${rule.interval} days` : 'Daily';
  } else if (rule.frequency === 'weekly') {
    const days = WEEKDAY_ORDER.filter((day) => rule.weekdays.includes(day)).map((day) => WEEKDAY_SHORT[day]).join(', ');
    text = `${every ? `Every ${rule.interval} weeks` : 'Weekly'}${days ? ` on ${days}` : ''}`;
  } else {
    text = `${every ? `Every ${rule.interval} months` : 'Monthly'}${rule.dayOfMonth ? ` on the ${ordinal(rule.dayOfMonth)}` : ''}`;
  }
  text += ` at ${rule.time}`;
  return withZone ? `${text} (${rule.timezone.replace(/_/g, ' ')})` : text;
}

type RuleStatus = 'active' | 'paused' | 'finished';
function statusOf(recurrence: Recurrence): RuleStatus {
  return recurrence.finished ? 'finished' : recurrence.paused ? 'paused' : 'active';
}
const RULE_STATUS: Record<RuleStatus, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  finished: { label: 'Finished', tone: 'draft' },
};

function TagChips({ tags }: { tags: Tag[] }) {
  if (tags.length === 0) return null;
  return <span className="sfa-q-tags" aria-label="Tags">
    {tags.map((tag) => <span key={tag.id} className="sfa-tagchip sfa-q-tag"><i style={{ background: tag.color }} aria-hidden="true" />{tag.name}</span>)}
  </span>;
}

/* ---------- Shared actions ---------- */

function useRecurrenceActions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const refresh = (id?: string) => {
    queryClient.invalidateQueries({ queryKey: [getListRecurrencesQueryKey()[0]] });
    if (id) queryClient.invalidateQueries({ queryKey: getGetRecurrenceQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: [getListPostsQueryKey()[0]] });
  };
  const toggle = useUpdateRecurrence({
    mutation: {
      onSuccess: (saved) => { refresh(saved.id); toast({ title: saved.paused ? 'Recurring post paused' : 'Recurring post resumed' }); },
      onError: (err, variables) => { refresh(variables.recurrenceId); toast({ title: "Couldn't update the recurring post", description: err.data?.message ?? undefined, variant: 'destructive' }); },
    },
  });
  const remove = useDeleteRecurrence({
    mutation: {
      onSuccess: (_, variables) => { refresh(variables.recurrenceId); toast({ title: 'Recurring post deleted', description: 'Unsent occurrences were removed.' }); },
      onError: (err) => { refresh(); toast({ title: "Couldn't delete the recurring post", description: err.data?.message ?? undefined, variant: 'destructive' }); },
    },
  });
  return { toggle, remove, refresh };
}

/* ---------- Occurrences (expanded card) ---------- */

function Occurrences({ recurrenceId }: { recurrenceId: string }) {
  const composer = useComposer();
  const { data, isLoading, isError, refetch } = useGetRecurrence(recurrenceId, { query: { queryKey: getGetRecurrenceQueryKey(recurrenceId) } });
  const posts = useMemo(() => [...(data?.posts ?? [])].sort((a, b) => new Date(a.scheduledAt ?? a.createdAt).getTime() - new Date(b.scheduledAt ?? b.createdAt).getTime()), [data]);
  if (isError) return <ErrorState title="Couldn't load the occurrences" onRetry={() => refetch()} />;
  if (isLoading) return <ul className="sfa-rc-occ" aria-busy="true" aria-label="Loading occurrences">{[0, 1, 2].map((i) => <li key={i}><Skeleton width={150} /><Skeleton width={78} height={22} radius={999} /><Skeleton width={48} /></li>)}</ul>;
  if (posts.length === 0) return <p className="sfa-muted sfa-rc-occ__empty">No occurrences have been created yet. The first one appears shortly before its run time.</p>;
  return <ul className="sfa-rc-occ" aria-label="Occurrences">
    {posts.map((post) => <li key={post.id} data-testid={`row-occurrence-${post.id}`}>
      <span className="sfa-num sfa-rc-occ__when">{post.scheduledAt ? format(new Date(post.scheduledAt), 'EEE, MMM d, yyyy · h:mm a') : 'No time'}</span>
      <StatusPill status={post.status} />
      <button type="button" className="sfa-linkbtn" onClick={() => composer.open({ post })} data-testid={`button-recurrence-open-post-${post.id}`}>Open</button>
    </li>)}
  </ul>;
}

/* ---------- Card ---------- */

function RecurrenceCard({ recurrence, accounts, tags, onEdit }: { recurrence: Recurrence; accounts: ConnectedAccount[]; tags: Tag[]; onEdit: () => void }) {
  const confirm = useConfirm();
  const { toggle, remove } = useRecurrenceActions();
  const [expanded, setExpanded] = useState(false);
  const status = statusOf(recurrence);
  const linked = recurrence.connectedAccountIds.map((id) => accounts.find((account) => account.id === id)).filter((account): account is ConnectedAccount => account !== undefined);
  const missingAccounts = recurrence.connectedAccountIds.length - linked.length;
  const ruleTags = recurrence.tagIds.map((id) => tags.find((tag) => tag.id === id)).filter((tag): tag is Tag => tag !== undefined);
  const toggling = toggle.isPending && toggle.variables?.recurrenceId === recurrence.id;
  const removing = remove.isPending && remove.variables?.recurrenceId === recurrence.id;
  const busy = toggling || removing;
  const sent = recurrence.occurrencesCreated;
  const max = recurrence.maxOccurrences;
  const progress = max ? Math.min(1, sent / max) : null;
  const panelId = `recurrence-occurrences-${recurrence.id}`;

  const onDelete = async () => {
    if (await confirm({ title: 'Delete this recurring post?', description: 'It stops repeating and any occurrences that haven’t been sent yet are removed. Posts that already went out stay.', confirmLabel: 'Delete', destructive: true })) {
      remove.mutate({ recurrenceId: recurrence.id });
    }
  };

  return <li className={`sfa-card sfa-rc-card ${expanded ? 'is-open' : ''}`} data-testid={`card-recurrence-${recurrence.id}`}>
    <div className="sfa-rc-card__row">
      <button type="button" className="sfa-rc-card__main" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((open) => !open)} data-testid={`button-recurrence-expand-${recurrence.id}`}>
        <span className="sfa-rc-card__icon" aria-hidden="true"><Repeat size={16} /></span>
        <span className="sfa-rc-card__copy">
          <span className="sfa-rc-card__rule">{describeRule(recurrence)}</span>
          <span className="sfa-rc-card__text">{snippet(recurrence.content, 140)}</span>
          <span className="sfa-rc-card__meta">
            <span className="sfa-rc-avatars" aria-label={`${recurrence.connectedAccountIds.length} ${recurrence.connectedAccountIds.length === 1 ? 'account' : 'accounts'}`}>
              {linked.slice(0, 5).map((account) => <AccountAvatar key={account.id} account={account} size={24} />)}
              {(linked.length > 5 || missingAccounts > 0) && <span className="sfa-count sfa-num">+{Math.max(0, linked.length - 5) + missingAccounts}</span>}
              {recurrence.connectedAccountIds.length === 0 && <span className="sfa-muted">No accounts</span>}
            </span>
            <TagChips tags={ruleTags} />
          </span>
        </span>
        <span className="sfa-rc-card__side">
          <span className={`sfa-pill sfa-pill--${RULE_STATUS[status].tone}`}>{RULE_STATUS[status].label}</span>
          <span className="sfa-muted sfa-num">
            {status === 'finished' ? 'Finished' : status === 'paused' ? 'Paused' : recurrence.nextRunAt ? `Next ${format(new Date(recurrence.nextRunAt), 'MMM d · h:mm a')}` : 'No next run'}
          </span>
          <span className="sfa-rc-progress" role="img" aria-label={max ? `${sent} of ${max} sent` : `${sent} sent`}>
            {progress !== null && <span className="sfa-rc-progress__bar" aria-hidden="true"><span style={{ width: `${progress * 100}%` }} /></span>}
            <span className="sfa-muted sfa-num">{max ? `${sent} of ${max} sent` : `${sent} sent`}</span>
          </span>
        </span>
        <ChevronDown size={16} className="sfa-rc-card__chev" aria-hidden="true" />
      </button>
      <div className="sfa-rc-card__actions">
        {status !== 'finished' && <Button size="sm" variant="secondary" icon={recurrence.paused ? <Play size={13} /> : <Pause size={13} />} disabled={busy} loading={toggling}
          onClick={() => toggle.mutate({ recurrenceId: recurrence.id, data: { paused: !recurrence.paused } })} data-testid={`button-recurrence-pause-${recurrence.id}`}>{recurrence.paused ? 'Resume' : 'Pause'}</Button>}
        <Button size="sm" variant="secondary" icon={<Pencil size={13} />} disabled={busy} onClick={onEdit} data-testid={`button-recurrence-edit-${recurrence.id}`}>Edit</Button>
        <IconButton label="Delete recurring post" className="sfa-iconbtn--danger" disabled={busy} onClick={onDelete} data-testid={`button-recurrence-delete-${recurrence.id}`}><Trash2 size={15} /></IconButton>
      </div>
    </div>
    {expanded && <div className="sfa-rc-card__panel" id={panelId}>
      <h3 className="sfa-label"><CalendarClock size={14} /> Occurrences</h3>
      <Occurrences recurrenceId={recurrence.id} />
      {recurrence.upcoming.length > 0 && <p className="sfa-muted">Upcoming: {recurrence.upcoming.slice(0, 5).map((iso) => format(new Date(iso), 'MMM d · h:mm a')).join(' · ')}{recurrence.upcoming.length > 5 ? ' …' : ''}</p>}
    </div>}
  </li>;
}

/* ---------- Edit dialog ---------- */

type FormState = {
  frequency: RecurrenceFrequency;
  interval: string;
  weekdays: number[];
  dayOfMonth: string;
  time: string;
  timezone: string;
  startDate: string;
  endDate: string;
  maxOccurrences: string;
  content: string;
  firstComment: string;
  accountIds: string[];
  tagIds: string[];
};

function fromRecurrence(recurrence: Recurrence): FormState {
  return {
    frequency: recurrence.frequency,
    interval: String(recurrence.interval),
    weekdays: [...recurrence.weekdays],
    dayOfMonth: recurrence.dayOfMonth === null ? '' : String(recurrence.dayOfMonth),
    time: recurrence.time,
    timezone: recurrence.timezone,
    startDate: recurrence.startDate,
    endDate: recurrence.endDate ?? '',
    maxOccurrences: recurrence.maxOccurrences === null ? '' : String(recurrence.maxOccurrences),
    content: recurrence.content,
    firstComment: recurrence.firstComment ?? '',
    accountIds: [...recurrence.connectedAccountIds],
    tagIds: [...recurrence.tagIds],
  };
}

function toInt(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/** The full rule body; every PATCH that isn't a bare pause/resume must send everything. */
function toInput(form: FormState, recurrence: Recurrence): RecurrenceInput {
  return {
    frequency: form.frequency,
    interval: toInt(form.interval) ?? 1,
    weekdays: form.frequency === 'weekly' ? [...form.weekdays].sort((a, b) => a - b) : [],
    dayOfMonth: form.frequency === 'monthly' ? toInt(form.dayOfMonth) : null,
    time: form.time,
    timezone: form.timezone,
    startDate: form.startDate,
    endDate: form.endDate || null,
    maxOccurrences: toInt(form.maxOccurrences),
    content: form.content,
    firstComment: form.firstComment.trim() === '' ? null : form.firstComment,
    platformContent: recurrence.platformContent,
    connectedAccountIds: form.accountIds,
    mediaIds: recurrence.mediaIds,
    tagIds: form.tagIds,
  };
}

function validate(form: FormState): string | null {
  const interval = toInt(form.interval);
  if (form.content.trim() === '') return 'Write something to post.';
  if (form.accountIds.length === 0) return 'Choose at least one account.';
  if (interval === null || interval < 1 || interval > 52) return 'Repeat every 1–52.';
  if (form.frequency === 'weekly' && form.weekdays.length === 0) return 'Pick at least one weekday.';
  if (form.frequency === 'monthly') { const day = toInt(form.dayOfMonth); if (day === null || day < 1 || day > 31) return 'Pick a day of the month (1–31).'; }
  if (!/^\d{2}:\d{2}$/.test(form.time)) return 'Pick a time.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.startDate)) return 'Pick a start date.';
  if (form.endDate && form.endDate < form.startDate) return 'The end date must be after the start date.';
  const max = toInt(form.maxOccurrences);
  if (form.maxOccurrences.trim() !== '' && (max === null || max < 1)) return 'Max posts must be 1 or more.';
  return null;
}

function toggleIn(list: string[], id: string): string[] { return list.includes(id) ? list.filter((item) => item !== id) : [...list, id]; }

function EditRecurrenceDialog({ recurrence, accounts, tags, onClose }: { recurrence: Recurrence; accounts: ConnectedAccount[]; tags: Tag[]; onClose: () => void }) {
  const { toast } = useToast();
  const { refresh } = useRecurrenceActions();
  const [form, setForm] = useState<FormState>(() => fromRecurrence(recurrence));
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const blocker = validate(form);
  const body = useMemo(() => toInput(form, recurrence), [form, recurrence]);
  const zones = useMemo(() => timeZones(form.timezone), [form.timezone]);

  const update = useUpdateRecurrence({
    mutation: {
      onSuccess: (saved) => { refresh(saved.id); toast({ title: 'Recurring post updated' }); onClose(); },
      onError: (err) => setError(err.data?.message ?? 'Something went wrong. Please try again.'),
    },
  });

  // Live "Next dates" preview, debounced so typing doesn't fire a request per keystroke.
  const preview = usePreviewRecurrence();
  const previewMutate = preview.mutate;
  // Only the rule fields matter for the preview; the memo key ignores text, accounts and tags.
  const ruleBody = useMemo<RecurrenceInput>(() => ({
    frequency: form.frequency,
    interval: toInt(form.interval) ?? 1,
    weekdays: form.frequency === 'weekly' ? [...form.weekdays].sort((a, b) => a - b) : [],
    dayOfMonth: form.frequency === 'monthly' ? toInt(form.dayOfMonth) : null,
    time: form.time,
    timezone: form.timezone,
    startDate: form.startDate,
    endDate: form.endDate || null,
    maxOccurrences: toInt(form.maxOccurrences),
  }), [form.frequency, form.interval, form.weekdays, form.dayOfMonth, form.time, form.timezone, form.startDate, form.endDate, form.maxOccurrences]);
  const ruleValid = blocker === null || blocker === 'Write something to post.' || blocker === 'Choose at least one account.';
  // The preview takes the same shape as a save, so send the whole body but only re-run when a rule field changes.
  const latestBody = useRef(body);
  latestBody.current = body;
  useEffect(() => {
    if (!ruleValid) return;
    const handle = window.setTimeout(() => previewMutate({ data: { ...latestBody.current, ...ruleBody } }), 400);
    return () => window.clearTimeout(handle);
  }, [ruleBody, ruleValid, previewMutate]);
  const dates = ruleValid ? preview.data?.dates ?? [] : [];

  const submit = () => {
    setError(null);
    if (blocker) { setError(blocker); return; }
    update.mutate({ recurrenceId: recurrence.id, data: body });
  };

  return <DialogPrimitive.Root open onOpenChange={(open) => { if (!open && !update.isPending) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="sfa-overlay" />
      <DialogPrimitive.Content className="sfa-dialog sfa-rc-dialog" data-testid="dialog-recurrence" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !update.isPending && blocker === null) { event.preventDefault(); submit(); } }}>
        <DialogPrimitive.Close asChild><button type="button" className="sfa-iconbtn sfa-dialog__close" aria-label="Close" data-testid="button-close-recurrence"><X size={18} /></button></DialogPrimitive.Close>
        <DialogPrimitive.Title className="sfa-dialog__title">Edit recurring post</DialogPrimitive.Title>
        <DialogPrimitive.Description className="sfa-dialog__desc">Changes apply to occurrences that haven’t been created yet.</DialogPrimitive.Description>

        <form className="sfa-rc-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <fieldset className="sfa-rc-fieldset">
            <legend className="sfa-label">Schedule</legend>
            <div className="sfa-rc-grid">
              <label className="sfa-rc-field">
                <span>Repeats</span>
                <select className="sfa-select" value={form.frequency} onChange={(event) => set('frequency', event.target.value as RecurrenceFrequency)} data-testid="select-recurrence-frequency">
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label className="sfa-rc-field">
                <span>Every</span>
                <span className="sfa-rc-inline">
                  <input type="number" className="sfa-input sfa-rc-num" min={1} max={52} inputMode="numeric" value={form.interval} onChange={(event) => set('interval', event.target.value)} data-testid="input-recurrence-interval" />
                  <span className="sfa-muted">{form.frequency === 'daily' ? 'day(s)' : form.frequency === 'weekly' ? 'week(s)' : 'month(s)'}</span>
                </span>
              </label>
              <label className="sfa-rc-field">
                <span>Time</span>
                <input type="time" className="sfa-input" value={form.time} onChange={(event) => set('time', event.target.value)} data-testid="input-recurrence-time" />
              </label>
              <label className="sfa-rc-field">
                <span>Time zone</span>
                <select className="sfa-select" value={form.timezone} onChange={(event) => set('timezone', event.target.value)} data-testid="select-recurrence-timezone">
                  {zones.map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>)}
                </select>
              </label>
            </div>

            {form.frequency === 'weekly' && <div className="sfa-rc-field">
              <span id="recurrence-weekdays">On</span>
              <div className="sfa-rc-days" role="group" aria-labelledby="recurrence-weekdays">
                {WEEKDAY_ORDER.map((day) => {
                  const on = form.weekdays.includes(day);
                  return <button key={day} type="button" className={`sfa-rc-day ${on ? 'is-on' : ''}`} aria-pressed={on} aria-label={WEEKDAY_LONG[day]}
                    onClick={() => set('weekdays', on ? form.weekdays.filter((item) => item !== day) : [...form.weekdays, day])} data-testid={`button-recurrence-weekday-${day}`}>{WEEKDAY_SHORT[day]}</button>;
                })}
              </div>
            </div>}

            {form.frequency === 'monthly' && <label className="sfa-rc-field sfa-rc-field--narrow">
              <span>Day of month</span>
              <input type="number" className="sfa-input sfa-rc-num" min={1} max={31} inputMode="numeric" value={form.dayOfMonth} onChange={(event) => set('dayOfMonth', event.target.value)} data-testid="input-recurrence-day-of-month" />
            </label>}

            <div className="sfa-rc-grid">
              <label className="sfa-rc-field">
                <span>Starts</span>
                <input type="date" className="sfa-input" value={form.startDate} onChange={(event) => set('startDate', event.target.value)} data-testid="input-recurrence-start" />
              </label>
              <label className="sfa-rc-field">
                <span>Ends <span className="sfa-muted">(optional)</span></span>
                <input type="date" className="sfa-input" value={form.endDate} min={form.startDate || undefined} onChange={(event) => set('endDate', event.target.value)} data-testid="input-recurrence-end" />
              </label>
              <label className="sfa-rc-field">
                <span>Max posts <span className="sfa-muted">(optional)</span></span>
                <input type="number" className="sfa-input" min={1} inputMode="numeric" placeholder="No limit" value={form.maxOccurrences} onChange={(event) => set('maxOccurrences', event.target.value)} data-testid="input-recurrence-max" />
              </label>
            </div>

            <div className="sfa-rc-preview" aria-live="polite">
              <span className="sfa-label"><CalendarClock size={14} /> Next dates</span>
              {!ruleValid ? <p className="sfa-muted">{blocker}</p>
                : preview.isPending && dates.length === 0 ? <div className="sfa-rc-preview__list"><Skeleton width={150} /><Skeleton width={150} /><Skeleton width={150} /></div>
                : preview.isError ? <p className="sfa-muted">Couldn’t preview this rule{preview.error?.data?.message ? `: ${preview.error.data.message}` : '.'}</p>
                : dates.length === 0 ? <p className="sfa-muted">This rule doesn’t produce any upcoming dates.</p>
                : <ul className="sfa-rc-preview__list" data-testid="list-recurrence-preview">{dates.slice(0, 6).map((iso) => <li key={iso} className="sfa-num">{format(new Date(iso), 'EEE, MMM d, yyyy · h:mm a')}</li>)}</ul>}
              <p className="sfa-muted">{describeRule({ frequency: form.frequency, interval: toInt(form.interval) ?? 1, weekdays: form.weekdays, dayOfMonth: toInt(form.dayOfMonth), time: form.time, timezone: form.timezone })}</p>
            </div>
          </fieldset>

          <fieldset className="sfa-rc-fieldset">
            <legend className="sfa-label">Content</legend>
            <label className="sfa-rc-field">
              <span>Post text</span>
              <textarea className="sfa-textarea sfa-rc-textarea" rows={5} value={form.content} onChange={(event) => set('content', event.target.value)} placeholder="What should go out each time?" data-testid="input-recurrence-content" />
            </label>
            <label className="sfa-rc-field">
              <span>First comment <span className="sfa-muted">(optional)</span></span>
              <textarea className="sfa-textarea sfa-rc-textarea sfa-rc-textarea--short" rows={2} value={form.firstComment} onChange={(event) => set('firstComment', event.target.value)} placeholder="Posted as the first comment where supported" data-testid="input-recurrence-first-comment" />
            </label>
          </fieldset>

          <fieldset className="sfa-rc-fieldset">
            <legend className="sfa-label">Post to {form.accountIds.length > 0 && <span className="sfa-count sfa-num">{form.accountIds.length}</span>}</legend>
            {accounts.length === 0 ? <p className="sfa-muted">No connected accounts.</p>
              : <ul className="sfa-accountpick" aria-label="Accounts">
                {accounts.map((account) => {
                  const on = form.accountIds.includes(account.id);
                  return <li key={account.id}>
                    <button type="button" className={`sfa-acctchip ${on ? 'is-on' : ''}`} aria-pressed={on} onClick={() => set('accountIds', toggleIn(form.accountIds, account.id))} data-testid={`button-recurrence-account-${account.id}`}>
                      <AccountAvatar account={account} size={26} />
                      <span className="sfa-acctchip__name">{account.displayName}</span>
                    </button>
                  </li>;
                })}
              </ul>}
          </fieldset>

          {tags.length > 0 && <fieldset className="sfa-rc-fieldset">
            <legend className="sfa-label">Tags</legend>
            <div className="sfa-rc-tagpick" role="group" aria-label="Tags">
              {tags.map((tag) => {
                const on = form.tagIds.includes(tag.id);
                return <button key={tag.id} type="button" className={`sfa-tagchip sfa-tagchip--button sfa-q-tag ${on ? 'is-on' : ''}`} aria-pressed={on} onClick={() => set('tagIds', toggleIn(form.tagIds, tag.id))} data-testid={`button-recurrence-tag-${tag.id}`}>
                  <i style={{ background: tag.color }} aria-hidden="true" />{tag.name}
                </button>;
              })}
            </div>
          </fieldset>}

          {error && <div className="sfa-alert" role="alert" data-testid="status-recurrence-error">{error}</div>}

          <div className="sfa-rc-foot">
            <span className="sfa-muted sfa-rc-foot__hint" role="status">{blocker ?? ''}</span>
            <Button variant="secondary" disabled={update.isPending} onClick={onClose} data-testid="button-recurrence-cancel">Cancel</Button>
            <Button type="submit" variant="primary" disabled={update.isPending || blocker !== null} loading={update.isPending} title="Save (Ctrl+Enter)" data-testid="button-recurrence-save">Save changes</Button>
          </div>
        </form>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

/* ---------- Page ---------- */

function CardsSkeleton() {
  return <ul className="sfa-rc-list" aria-busy="true" aria-label="Loading recurring posts">
    {[0, 1, 2].map((i) => <li key={i} className="sfa-card sfa-rc-card"><div className="sfa-rc-card__row"><div className="sfa-rc-card__main sfa-rc-card__main--skel">
      <Skeleton width={32} height={32} radius={8} />
      <span className="sfa-rc-card__copy"><Skeleton width={`${55 - i * 8}%`} /><Skeleton width="80%" /><Skeleton width={120} height={24} radius={999} /></span>
      <span className="sfa-rc-card__side"><Skeleton width={70} height={22} radius={999} /><Skeleton width={110} /></span>
    </div></div></li>)}
  </ul>;
}

export function RecurringPage() {
  const composer = useComposer();
  const { data, isLoading, isError, refetch } = useListRecurrences({ query: { queryKey: getListRecurrencesQueryKey(), refetchInterval: 30_000 } });
  const { data: accountData } = useListConnectedAccounts({ query: { queryKey: getListConnectedAccountsQueryKey() } });
  const { data: tagData } = useListTags({ query: { queryKey: getListTagsQueryKey() } });
  const accounts = accountData?.accounts ?? [];
  const tags = tagData?.tags ?? [];
  const [editingId, setEditingId] = useState<string | null>(null);
  const recurrences = useMemo(() => {
    const rank: Record<RuleStatus, number> = { active: 0, paused: 1, finished: 2 };
    return [...(data?.recurrences ?? [])].sort((a, b) => {
      const byStatus = rank[statusOf(a)] - rank[statusOf(b)];
      if (byStatus !== 0) return byStatus;
      const nextA = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
      const nextB = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
      return nextA - nextB || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [data]);
  const editing = recurrences.find((item) => item.id === editingId) ?? null;
  const active = recurrences.filter((item) => statusOf(item) === 'active').length;

  return <div className="sfa-page" data-testid="page-recurring">
    <PageHeader title="Recurring posts" description="Rules that create a new post on a schedule. Pause, edit or stop them here; each occurrence shows up on the calendar like any other post."
      actions={<Button variant="primary" icon={<Plus size={16} />} onClick={() => composer.open()} data-testid="button-recurring-create">Create post</Button>} />
    {isError ? <div className="sfa-card"><ErrorState title="Couldn't load your recurring posts" onRetry={() => refetch()} /></div>
      : isLoading ? <CardsSkeleton />
      : recurrences.length === 0 ? <div className="sfa-card"><EmptyState icon={<Repeat size={22} />} title="No recurring posts yet"
        description="Create a post and choose Repeat in the composer. Pick how often it should go out and it will show up here, where you can pause, edit or stop it."
        action={<Button variant="primary" icon={<Plus size={15} />} onClick={() => composer.open()}>Create a post</Button>} /></div>
      : <>
        <p className="sfa-muted sfa-rc-summary" role="status">{active} active · {recurrences.length - active} paused or finished{data?.recurrences.length ? ` · updated ${formatDistanceToNow(new Date(Math.max(...recurrences.map((item) => new Date(item.updatedAt).getTime()))), { addSuffix: true })}` : ''}</p>
        <ul className="sfa-rc-list" aria-label="Recurring posts">
          {recurrences.map((recurrence) => <RecurrenceCard key={recurrence.id} recurrence={recurrence} accounts={accounts} tags={tags} onEdit={() => setEditingId(recurrence.id)} />)}
        </ul>
      </>}
    {editing && <EditRecurrenceDialog key={editing.id} recurrence={editing} accounts={accounts} tags={tags} onClose={() => setEditingId(null)} />}
  </div>;
}

export default RecurringPage;
