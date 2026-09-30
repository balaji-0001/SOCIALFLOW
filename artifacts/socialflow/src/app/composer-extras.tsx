import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { format } from 'date-fns';
import { AtSign, Check, CircleAlert, Info, MessageSquareText, Plus, Repeat, Tag as TagIcon, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getListTagsQueryKey,
  useCreateTag,
  useListCustomFields,
  useListMentionGroups,
  useListTags,
  getListCustomFieldsQueryKey,
  getListMentionGroupsQueryKey,
  type ConnectedAccount,
  type CustomField,
  type Platform,
  type Tag,
} from '@workspace/api-client-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { PLATFORM_META, PlatformBadge } from './platforms';
import { Button } from './ui';

/* Composer sections added in Phase 1: per-network text tabs, first comment, tags, custom fields, mention groups, repeat. */

export type PlatformContent = Partial<Record<Platform, string>>;

/** The text a network receives: its own version when the user wrote one, otherwise the base text. */
export function textFor(base: string, platformContent: PlatformContent, platform: Platform): string {
  const own = platformContent[platform];
  return own && own.trim().length > 0 ? own : base;
}

/* ---------- Per-network tabs ---------- */

export function NetworkTabs({ platforms, active, platformContent, customizing, onPick, onToggleCustomize, base }: {
  platforms: Platform[]; active: 'base' | Platform; platformContent: PlatformContent; customizing: boolean; base: string;
  onPick: (tab: 'base' | Platform) => void; onToggleCustomize: (on: boolean) => void;
}) {
  if (platforms.length === 0) return null;
  if (!customizing) {
    return <button type="button" className="sfa-linkbtn" onClick={() => onToggleCustomize(true)} data-testid="button-customize-networks">Customize per network</button>;
  }
  return <div className="sfa-nettabs" role="tablist" aria-label="Text per network">
    <button type="button" role="tab" aria-selected={active === 'base'} className={active === 'base' ? 'is-on' : ''} onClick={() => onPick('base')} data-testid="nettab-base">All networks</button>
    {platforms.map((platform) => {
      const own = (platformContent[platform] ?? '').trim().length > 0;
      const over = textFor(base, platformContent, platform).length > PLATFORM_META[platform].charLimit;
      return <button key={platform} type="button" role="tab" aria-selected={active === platform} className={`${active === platform ? 'is-on' : ''} ${over ? 'is-over' : ''}`} onClick={() => onPick(platform)} data-testid={`nettab-${platform}`}>
        <PlatformBadge platform={platform} size={14} /> {PLATFORM_META[platform].name}{own && <span className="sfa-nettabs__dot" title="Has its own text" aria-label="customized" />}
      </button>;
    })}
    <button type="button" className="sfa-linkbtn sfa-nettabs__off" onClick={() => onToggleCustomize(false)} data-testid="button-customize-off">Use one text</button>
  </div>;
}

/* ---------- First comment ---------- */

const FIRST_COMMENT_LIMIT = 2000;

export function FirstCommentField({ value, onChange, accounts, disabled }: { value: string; onChange: (value: string) => void; accounts: ConnectedAccount[]; disabled: boolean }) {
  const [open, setOpen] = useState(value.trim().length > 0);
  useEffect(() => { if (value.trim().length > 0) setOpen(true); }, [value]);
  const notes = useMemo(() => accounts.map((account) => {
    const support = account.firstComment;
    const text = support === 'supported' ? 'Supported' : support === 'needs_permission' ? 'Needs a permission: reconnect this account to grant it' : 'Not supported by this network';
    return { account, support, text };
  }), [accounts]);
  if (!open) {
    return <button type="button" className="sfa-linkbtn" onClick={() => setOpen(true)} disabled={disabled} data-testid="button-add-first-comment"><MessageSquareText size={13} aria-hidden /> Add a first comment</button>;
  }
  return <section aria-labelledby="composer-first-comment" className="sfa-firstcomment">
    <div className="sfa-labelrow">
      <label className="sfa-label" htmlFor="composer-first-comment-input" id="composer-first-comment">First comment <span className="sfa-muted">(posted right after the post)</span></label>
      {!disabled && <button type="button" className="sfa-linkbtn" onClick={() => { onChange(''); setOpen(false); }} data-testid="button-remove-first-comment">Remove</button>}
    </div>
    <textarea id="composer-first-comment-input" className="sfa-input sfa-firstcomment__input" rows={2} value={value} maxLength={FIRST_COMMENT_LIMIT} onChange={(event) => onChange(event.target.value)} readOnly={disabled}
      placeholder="Links, hashtags or a follow-up for the comments" data-testid="input-first-comment" />
    <div className="sfa-firstcomment__foot">
      <span className="sfa-muted sfa-num">{value.length} / {FIRST_COMMENT_LIMIT}</span>
      {notes.length > 0 && <ul className="sfa-firstcomment__support" aria-label="First comment support">
        {notes.map(({ account, support, text }) => <li key={account.id} className={`is-${support}`} data-testid={`first-comment-support-${account.id}`}>
          <PlatformBadge platform={account.platform} size={13} /> <span>{account.displayName}:</span> {text}
        </li>)}
      </ul>}
    </div>
  </section>;
}

/* ---------- Tags ---------- */

export function TagPicker({ selected, onChange, disabled }: { selected: string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListTags({ query: { queryKey: getListTagsQueryKey() } });
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateTag({ mutation: {
    onSuccess: (tag) => { queryClient.invalidateQueries({ queryKey: [getListTagsQueryKey()[0]] }); onChange([...selected, tag.id]); setName(''); setError(null); },
    onError: (err) => setError(err.data?.message ?? "Couldn't create the tag."),
  } });
  const tags: Tag[] = data?.tags ?? [];
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const submit = () => { if (name.trim()) create.mutate({ data: { name: name.trim() } }); };
  return <div className="sfa-tagpick" data-testid="tag-picker">
    <div className="sfa-chips">
      {isLoading && <span className="sfa-muted">Loading tags…</span>}
      {tags.map((tag) => <button key={tag.id} type="button" className={`sfa-tagchip sfa-tagchip--button ${selected.includes(tag.id) ? 'is-on' : ''}`} style={{ ['--tag' as string]: tag.color }} aria-pressed={selected.includes(tag.id)} disabled={disabled} onClick={() => toggle(tag.id)} data-testid={`tag-option-${tag.id}`}>
        <span className="sfa-tagchip__swatch" aria-hidden /> {tag.name}{selected.includes(tag.id) && <Check size={12} aria-hidden />}
      </button>)}
      {!isLoading && tags.length === 0 && <span className="sfa-muted">No tags yet. Create one to organise posts by campaign or client.</span>}
    </div>
    {!disabled && <div className="sfa-tagpick__new">
      <input className="sfa-input" value={name} placeholder="New tag" maxLength={60} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} data-testid="input-new-tag" />
      <Button size="sm" variant="secondary" icon={<Plus size={13} />} disabled={!name.trim()} loading={create.isPending} onClick={submit} data-testid="button-create-tag">Add</Button>
    </div>}
    {error && <p className="sfa-field__hint sfa-field__hint--error" role="alert">{error}</p>}
  </div>;
}

/* ---------- Custom fields ---------- */

export function CustomFieldsForm({ values, onChange, disabled }: { values: Record<string, string>; onChange: (values: Record<string, string>) => void; disabled: boolean }) {
  const { data } = useListCustomFields({ query: { queryKey: getListCustomFieldsQueryKey() } });
  const fields: CustomField[] = data?.fields ?? [];
  if (fields.length === 0) return null;
  const set = (id: string, value: string) => onChange({ ...values, [id]: value });
  return <div className="sfa-customfields" data-testid="custom-fields">
    {fields.map((field) => {
      const id = `cf-${field.id}`;
      const value = values[field.id] ?? '';
      return <div className="sfa-field" key={field.id}>
        <label htmlFor={id}>{field.label}{field.required && <span className="sfa-muted"> (required to schedule)</span>}</label>
        {field.type === 'select'
          ? <select id={id} className="sfa-input" value={value} disabled={disabled} onChange={(event) => set(field.id, event.target.value)} data-testid={`custom-field-${field.key}`}>
            <option value="">—</option>
            {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          : <input id={id} className="sfa-input" type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'url' ? 'url' : 'text'} value={value} readOnly={disabled} placeholder={field.type === 'url' ? 'https://' : undefined}
            onChange={(event) => set(field.id, event.target.value)} data-testid={`custom-field-${field.key}`} />}
      </div>;
    })}
  </div>;
}

/* ---------- Mention groups ---------- */

export function MentionGroupsTool({ onInsert, disabled }: { onInsert: (text: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const { data } = useListMentionGroups({ query: { queryKey: getListMentionGroupsQueryKey(), enabled: open } });
  const groups = data?.groups ?? [];
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><button type="button" className="sfa-tool" aria-label="Insert a mention group" title="Insert a mention group" disabled={disabled} data-testid="tool-mentions"><AtSign size={17} /></button></PopoverTrigger>
    <PopoverContent className="sfa-popcard" align="start" data-testid="popover-mentions">
      <h4>Mention groups</h4>
      {groups.length === 0
        ? <p className="sfa-muted">Save sets of @handles under Settings → Mention groups, then insert them here in one click.</p>
        : <ul className="sfa-mentionlist">{groups.map((group) => <li key={group.id}>
          <button type="button" onClick={() => { onInsert(group.handles.join(' ')); setOpen(false); }} data-testid={`mention-group-${group.id}`}>
            <strong>{group.name}</strong><span className="sfa-muted">{group.handles.join(' ')}</span>
          </button>
        </li>)}</ul>}
      <p className="sfa-muted sfa-mentionlist__note"><Info size={12} aria-hidden /> Handles are inserted as text. Each network decides whether a handle links to a profile.</p>
    </PopoverContent>
  </Popover>;
}

/* ---------- Repeat ---------- */

export type RepeatState = { frequency: 'daily' | 'weekly' | 'monthly'; interval: number; weekdays: number[]; dayOfMonth: number | null; endMode: 'never' | 'date' | 'count'; endDate: string; count: number };

export const DEFAULT_REPEAT: RepeatState = { frequency: 'weekly', interval: 1, weekdays: [], dayOfMonth: null, endMode: 'never', endDate: '', count: 10 };

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The request body the recurrence API expects for a rule, from the composer's state. */
export function repeatToRule(repeat: RepeatState, date: string, time: string, timezone: string) {
  const start = new Date(`${date}T00:00`);
  return {
    frequency: repeat.frequency,
    interval: repeat.interval,
    weekdays: repeat.frequency === 'weekly' ? (repeat.weekdays.length > 0 ? repeat.weekdays : [start.getDay()]) : [],
    dayOfMonth: repeat.frequency === 'monthly' ? (repeat.dayOfMonth ?? start.getDate()) : null,
    time,
    timezone,
    startDate: date,
    endDate: repeat.endMode === 'date' && repeat.endDate ? repeat.endDate : null,
    maxOccurrences: repeat.endMode === 'count' ? repeat.count : null,
  };
}

export function describeRepeat(rule: ReturnType<typeof repeatToRule>): string {
  const every = rule.interval > 1 ? `every ${rule.interval} ` : '';
  const unit = rule.frequency === 'daily' ? (rule.interval > 1 ? 'days' : 'day') : rule.frequency === 'weekly' ? (rule.interval > 1 ? 'weeks' : 'week') : (rule.interval > 1 ? 'months' : 'month');
  const when = rule.frequency === 'weekly' ? ` on ${rule.weekdays.slice().sort().map((d) => WEEKDAY_LABELS[d]).join(', ')}` : rule.frequency === 'monthly' ? ` on day ${rule.dayOfMonth}` : '';
  const end = rule.endDate ? `, until ${rule.endDate}` : rule.maxOccurrences ? `, ${rule.maxOccurrences} times` : '';
  return `Repeats ${every ? every + unit : 'every ' + unit}${when} at ${rule.time}${end}`;
}

export function RepeatSection({ repeat, onChange, date, time, timezone, disabled }: { repeat: RepeatState | null; onChange: (value: RepeatState | null) => void; date: string; time: string; timezone: string; disabled: boolean }) {
  const [preview, setPreview] = useState<string[]>([]);
  const rule = repeat ? repeatToRule(repeat, date, time, timezone) : null;
  const ruleKey = JSON.stringify(rule);
  useEffect(() => {
    if (!rule) { setPreview([]); return; }
    const handle = window.setTimeout(() => {
      fetch('/api/recurrences/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ruleKey })
        .then((response) => (response.ok ? (response.json() as Promise<{ dates: string[] }>) : null))
        .then((body) => setPreview(body?.dates ?? []))
        .catch(() => setPreview([]));
    }, 300);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleKey]);
  const set = (change: Partial<RepeatState>) => onChange({ ...(repeat ?? DEFAULT_REPEAT), ...change });
  return <section aria-labelledby="composer-repeat" className="sfa-repeat">
    <h3 className="sfa-label" id="composer-repeat"><Repeat size={15} /> Repeat</h3>
    <div className="sfa-repeat__row">
      <select className="sfa-input" value={repeat?.frequency ?? 'none'} disabled={disabled} aria-label="Repeat" data-testid="select-repeat"
        onChange={(event) => { const value = event.target.value; if (value === 'none') onChange(null); else set({ frequency: value as RepeatState['frequency'] }); }}>
        <option value="none">Doesn’t repeat</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </select>
      {repeat && <label className="sfa-repeat__every">every <input className="sfa-input" type="number" min={1} max={52} value={repeat.interval} disabled={disabled} onChange={(event) => set({ interval: Math.max(1, Math.min(52, Number(event.target.value) || 1)) })} data-testid="input-repeat-interval" /> {repeat.frequency === 'daily' ? 'day(s)' : repeat.frequency === 'weekly' ? 'week(s)' : 'month(s)'}</label>}
    </div>
    {repeat?.frequency === 'weekly' && <div className="sfa-repeat__days" role="group" aria-label="Weekdays">
      {WEEKDAY_LABELS.map((label, day) => <button key={day} type="button" className={`sfa-tagchip sfa-tagchip--button ${repeat.weekdays.includes(day) ? 'is-on' : ''}`} aria-pressed={repeat.weekdays.includes(day)} disabled={disabled}
        onClick={() => set({ weekdays: repeat.weekdays.includes(day) ? repeat.weekdays.filter((d) => d !== day) : [...repeat.weekdays, day] })} data-testid={`repeat-day-${day}`}>{label}</button>)}
    </div>}
    {repeat?.frequency === 'monthly' && <label className="sfa-repeat__every">on day <input className="sfa-input" type="number" min={1} max={31} value={repeat.dayOfMonth ?? new Date(`${date}T00:00`).getDate()} disabled={disabled} onChange={(event) => set({ dayOfMonth: Math.max(1, Math.min(31, Number(event.target.value) || 1)) })} data-testid="input-repeat-day" /> <span className="sfa-muted">(shorter months use their last day)</span></label>}
    {repeat && <div className="sfa-repeat__row">
      <select className="sfa-input" value={repeat.endMode} disabled={disabled} aria-label="Ends" onChange={(event) => set({ endMode: event.target.value as RepeatState['endMode'] })} data-testid="select-repeat-end">
        <option value="never">Never ends</option>
        <option value="date">Ends on a date</option>
        <option value="count">Ends after</option>
      </select>
      {repeat.endMode === 'date' && <input className="sfa-input" type="date" min={date} value={repeat.endDate} disabled={disabled} onChange={(event) => set({ endDate: event.target.value })} aria-label="End date" data-testid="input-repeat-end-date" />}
      {repeat.endMode === 'count' && <label className="sfa-repeat__every"><input className="sfa-input" type="number" min={1} max={1000} value={repeat.count} disabled={disabled} onChange={(event) => set({ count: Math.max(1, Math.min(1000, Number(event.target.value) || 1)) })} aria-label="Number of posts" data-testid="input-repeat-count" /> posts</label>}
    </div>}
    {rule && <p className="sfa-muted sfa-repeat__summary" data-testid="repeat-summary">{describeRepeat(rule)} ({timezone}). The first post goes out at the scheduled time above; each one appears on the calendar a week ahead.</p>}
    {preview.length > 0 && <ul className="sfa-repeat__preview" aria-label="Next dates" data-testid="repeat-preview">
      {preview.map((iso) => <li key={iso} className="sfa-num">{format(new Date(iso), 'EEE, MMM d · h:mm a')}</li>)}
    </ul>}
  </section>;
}

/* ---------- Small helpers used by the composer ---------- */

export function SectionNote({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return <p className={`sfa-note ${tone === 'warn' ? 'sfa-note--warn' : ''}`}>{tone === 'warn' ? <CircleAlert size={14} /> : <Info size={14} />} <span>{children}</span></p>;
}

export const TagChip = ({ tag, onRemove }: { tag: { id: string; name: string; color: string }; onRemove?: () => void }) => (
  <span className="sfa-tagchip sfa-tagchip--tag" style={{ ['--tag' as string]: tag.color }} data-testid={`post-tag-${tag.id}`}>
    <TagIcon size={11} aria-hidden /> {tag.name}{onRemove && <button type="button" onClick={onRemove} aria-label={`Remove ${tag.name}`}><X size={11} /></button>}
  </span>
);
