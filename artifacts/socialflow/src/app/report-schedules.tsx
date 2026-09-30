import { useState, type FormEvent, type KeyboardEvent } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Mail, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import {
  getAuthMeQueryKey,
  getListReportScheduleRunsQueryKey,
  getListReportSchedulesQueryKey,
  useAuthMe,
  useCreateReportSchedule,
  useDeleteReportSchedule,
  useListConnectedAccounts,
  useListReportScheduleRuns,
  useListReportSchedules,
  useSendReportScheduleNow,
  useUpdateReportSchedule,
  type ReportSchedule,
  type ReportScheduleCreateInput,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { PLATFORM_META } from './platforms';
import { useConfirm } from './confirm';
import { Button, EmptyState, ErrorState, Skeleton } from './ui';
import './report-schedules.css';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const RANGE_OPTS = [{ key: '7d', label: 'Last 7 days' }, { key: '30d', label: 'Last 30 days' }, { key: '90d', label: 'Last 90 days' }] as const;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const MAX_RECIPIENTS = 10;
const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;
const ordinal = (n: number) => { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`; };

function fmtIn(iso: string | null, tz: string): string {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso)); }
  catch { return new Date(iso).toLocaleString(); }
}
const fmtLocal = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const cadence = (s: ReportSchedule) => (s.frequency === 'weekly' ? `Weekly on ${WEEKDAYS[s.weekday ?? 0]}` : `Monthly on the ${ordinal(s.dayOfMonth ?? 1)}`) + ` at ${hourLabel(s.hour)}`;
const errInfo = (e: unknown) => {
  const x = e as { status?: number; data?: { message?: string } | null; message?: string } | null;
  return { status: x?.status, message: x?.data?.message ?? x?.message ?? 'Something went wrong.' };
};
function timezones(current: string): string[] {
  let list: string[] = [];
  try { list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { list = []; }
  const set = new Set(list); set.add(current); set.add('UTC');
  return [...set].sort();
}

/* ---------- Run history ---------- */
function RunHistory({ scheduleId }: { scheduleId: string }) {
  const { data, isLoading, isError, refetch } = useListReportScheduleRuns(scheduleId);
  if (isLoading) return <div className="sfrs-runs"><Skeleton height={16} /></div>;
  if (isError) return <div className="sfrs-runs"><ErrorState title="Couldn't load run history" onRetry={() => { void refetch(); }} /></div>;
  const runs = data?.runs ?? [];
  if (runs.length === 0) return <div className="sfrs-runs sfa-muted" data-testid={`text-no-runs-${scheduleId}`}>No runs yet.</div>;
  return <ul className="sfrs-runs" data-testid={`list-runs-${scheduleId}`}>
    {runs.map((r) => <li key={r.id} className="sfrs-run">
      <span className={`sfa-pill sfa-pill--${r.status === 'sent' ? 'success' : 'error'}`}>{r.status === 'sent' ? 'Sent' : 'Failed'}</span>
      <span>{fmtLocal(r.ranAt)}</span>
      <span className="sfa-muted">{r.recipientCount} recipient{r.recipientCount === 1 ? '' : 's'}</span>
      {r.error && <span className="sfrs-run__err">{r.error}</span>}
    </li>)}
  </ul>;
}

/* ---------- Create / edit dialog ---------- */
type Draft = { name: string; frequency: 'weekly' | 'monthly'; weekday: number; dayOfMonth: number; hour: number; timezone: string; rangeKey: '7d' | '30d' | '90d'; platform: string; accountId: string; recipients: string[]; enabled: boolean };

function toDraft(s: ReportSchedule | null): Draft {
  if (!s) return { name: '', frequency: 'weekly', weekday: 1, dayOfMonth: 1, hour: 9, timezone: browserTz(), rangeKey: '30d', platform: '', accountId: '', recipients: [], enabled: true };
  return { name: s.name, frequency: s.frequency, weekday: s.weekday ?? 1, dayOfMonth: s.dayOfMonth ?? 1, hour: s.hour, timezone: s.timezone, rangeKey: s.rangeKey, platform: s.platform ?? '', accountId: s.accountId ?? '', recipients: s.recipients, enabled: s.enabled };
}

function ScheduleDialog({ schedule, onClose }: { schedule: ReportSchedule | null; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(() => toDraft(schedule));
  const [emailText, setEmailText] = useState('');
  const [emailErr, setEmailErr] = useState('');
  const { data: accountData } = useListConnectedAccounts();
  const accounts = (accountData?.accounts ?? []).filter((a) => !d.platform || a.platform === d.platform);
  const set = (patch: Partial<Draft>) => setD((p) => ({ ...p, ...patch }));

  const done = () => { void qc.invalidateQueries({ queryKey: getListReportSchedulesQueryKey() }); onClose(); };
  const fail = (e: unknown) => toast({ title: "Couldn't save the schedule", description: errInfo(e).message, variant: 'destructive' });
  const create = useCreateReportSchedule({ mutation: { onSuccess: () => { toast({ title: 'Schedule created' }); done(); }, onError: fail } });
  const update = useUpdateReportSchedule({ mutation: { onSuccess: () => { toast({ title: 'Schedule saved' }); done(); }, onError: fail } });
  const saving = create.isPending || update.isPending;

  /** Validates and merges pending addresses; returns the merged list or null on error. */
  const merge = (raw: string): string[] | null => {
    const parts = raw.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    const bad = parts.find((x) => !EMAIL_RE.test(x));
    if (bad) { setEmailErr(`"${bad}" is not a valid email address.`); return null; }
    const next = [...new Set([...d.recipients, ...parts.map((x) => x.toLowerCase())])];
    if (next.length > MAX_RECIPIENTS) { setEmailErr(`At most ${MAX_RECIPIENTS} recipients.`); return null; }
    setEmailErr('');
    return next;
  };
  const addEmails = (raw: string) => {
    if (!raw.trim()) return;
    const next = merge(raw);
    if (next) { set({ recipients: next }); setEmailText(''); }
  };
  const onEmailKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') { e.preventDefault(); addEmails(emailText); }
    else if (e.key === 'Backspace' && emailText === '' && d.recipients.length > 0) set({ recipients: d.recipients.slice(0, -1) });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const recipients = merge(emailText);
    if (!recipients) return;
    if (recipients.length === 0) { setEmailErr('Add at least one recipient.'); return; }
    if (!d.name.trim()) return;
    const base = {
      name: d.name.trim(), frequency: d.frequency, hour: d.hour, timezone: d.timezone, rangeKey: d.rangeKey, recipients, enabled: d.enabled,
      platform: d.platform || null, accountId: d.accountId || null,
      ...(d.frequency === 'weekly' ? { weekday: d.weekday } : { dayOfMonth: d.dayOfMonth }),
    };
    if (schedule) update.mutate({ id: schedule.id, data: base });
    else create.mutate({ data: base as ReportScheduleCreateInput });
  };

  return <DialogPrimitive.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="sfa-overlay" />
      <DialogPrimitive.Content className="sfa-dialog sfrs-dialog" data-testid="dialog-report-schedule">
        <DialogPrimitive.Close asChild><button type="button" className="sfa-iconbtn sfa-dialog__close" aria-label="Close" data-testid="button-close-report-schedule"><X size={18} /></button></DialogPrimitive.Close>
        <DialogPrimitive.Title className="sfa-dialog__title">{schedule ? 'Edit schedule' : 'New scheduled report'}</DialogPrimitive.Title>
        <DialogPrimitive.Description className="sfa-dialog__desc">The analytics PDF is emailed to the recipients on this schedule.</DialogPrimitive.Description>
        <form className="sfrs-form" onSubmit={submit}>
          <label className="sfrs-field"><span>Name</span>
            <input className="sfa-input" value={d.name} maxLength={100} required onChange={(e) => set({ name: e.target.value })} placeholder="Weekly performance" data-testid="input-schedule-name" /></label>
          <div className="sfrs-row">
            <label className="sfrs-field"><span>Frequency</span>
              <select className="sfa-select" value={d.frequency} onChange={(e) => set({ frequency: e.target.value === 'monthly' ? 'monthly' : 'weekly' })} data-testid="select-schedule-frequency">
                <option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
            {d.frequency === 'weekly'
              ? <label className="sfrs-field"><span>Weekday</span>
                <select className="sfa-select" value={d.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })} data-testid="select-schedule-weekday">
                  {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}</select></label>
              : <label className="sfrs-field"><span>Day of month (1 to 28)</span>
                <select className="sfa-select" value={d.dayOfMonth} onChange={(e) => set({ dayOfMonth: Number(e.target.value) })} data-testid="select-schedule-day">
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{ordinal(n)}</option>)}</select></label>}
            <label className="sfrs-field"><span>Hour</span>
              <select className="sfa-select" value={d.hour} onChange={(e) => set({ hour: Number(e.target.value) })} data-testid="select-schedule-hour">
                {Array.from({ length: 24 }, (_, i) => i).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></label>
          </div>
          <div className="sfrs-row">
            <label className="sfrs-field"><span>Timezone</span>
              <select className="sfa-select" value={d.timezone} onChange={(e) => set({ timezone: e.target.value })} data-testid="select-schedule-timezone">
                {timezones(d.timezone).map((z) => <option key={z} value={z}>{z}</option>)}</select></label>
            <label className="sfrs-field"><span>Report range</span>
              <select className="sfa-select" value={d.rangeKey} onChange={(e) => set({ rangeKey: e.target.value === '7d' ? '7d' : e.target.value === '90d' ? '90d' : '30d' })} data-testid="select-schedule-range">
                {RANGE_OPTS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></label>
          </div>
          <div className="sfrs-row">
            <label className="sfrs-field"><span>Platform (optional)</span>
              <select className="sfa-select" value={d.platform} onChange={(e) => set({ platform: e.target.value, accountId: '' })} data-testid="select-schedule-platform">
                <option value="">All platforms</option>
                {(Object.keys(PLATFORM_META) as (keyof typeof PLATFORM_META)[]).map((p) => <option key={p} value={p}>{PLATFORM_META[p].name}</option>)}</select></label>
            <label className="sfrs-field"><span>Account (optional)</span>
              <select className="sfa-select" value={d.accountId} onChange={(e) => set({ accountId: e.target.value })} data-testid="select-schedule-account">
                <option value="">All accounts</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName} ({PLATFORM_META[a.platform].name})</option>)}</select></label>
          </div>
          <div className="sfrs-field">
            <label htmlFor="sfrs-email"><span>Recipients ({d.recipients.length}/{MAX_RECIPIENTS})</span></label>
            <div className="sfrs-chips">
              {d.recipients.map((r) => <span key={r} className="sfrs-chip">{r}
                <button type="button" aria-label={`Remove ${r}`} onClick={() => set({ recipients: d.recipients.filter((x) => x !== r) })} data-testid={`button-remove-recipient-${r}`}><X size={12} /></button></span>)}
              <input id="sfrs-email" className="sfrs-chips__input" type="text" inputMode="email" autoComplete="off" value={emailText} placeholder={d.recipients.length ? 'Add another' : 'name@example.com'}
                disabled={d.recipients.length >= MAX_RECIPIENTS} aria-invalid={emailErr ? true : undefined} aria-describedby={emailErr ? 'sfrs-email-err' : undefined}
                onChange={(e) => { setEmailText(e.target.value); if (emailErr) setEmailErr(''); }} onKeyDown={onEmailKey} onBlur={() => addEmails(emailText)} data-testid="input-schedule-recipient" />
            </div>
            {emailErr && <span id="sfrs-email-err" className="sfrs-err" role="alert">{emailErr}</span>}
            <span className="sfa-muted">Press Enter or comma to add an address.</span>
          </div>
          <label className="sfrs-check"><input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} data-testid="checkbox-schedule-enabled" /> Enabled</label>
          <div className="sfrs-actions">
            <Button variant="secondary" onClick={onClose} data-testid="button-cancel-schedule">Cancel</Button>
            <Button type="submit" variant="primary" loading={saving} data-testid="button-save-schedule">{schedule ? 'Save changes' : 'Create schedule'}</Button>
          </div>
        </form>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

/* ---------- Row ---------- */
function ScheduleRow({ s, canManage, onEdit }: { s: ReportSchedule; canManage: boolean; onEdit: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: getListReportSchedulesQueryKey() }); void qc.invalidateQueries({ queryKey: getListReportScheduleRunsQueryKey(s.id) }); };
  const toggle = useUpdateReportSchedule({ mutation: { onSuccess: refresh, onError: (e) => toast({ title: "Couldn't update the schedule", description: errInfo(e).message, variant: 'destructive' }) } });
  const del = useDeleteReportSchedule({ mutation: { onSuccess: () => { toast({ title: 'Schedule deleted' }); refresh(); }, onError: (e) => toast({ title: "Couldn't delete the schedule", description: errInfo(e).message, variant: 'destructive' }) } });
  const send = useSendReportScheduleNow({
    mutation: {
      onSuccess: (run) => {
        refresh();
        if (run.status === 'failed') toast({ title: 'Report could not be sent', description: run.error ?? 'The email failed to send.', variant: 'destructive' });
        else toast({ title: 'Report sent', description: `Emailed to ${run.recipientCount} recipient${run.recipientCount === 1 ? '' : 's'}.` });
      },
      onError: (e) => {
        const { status, message } = errInfo(e);
        toast({ title: status === 429 ? 'Too many sends' : "Couldn't send the report", description: status === 429 ? `${message} Wait a few minutes and try again.` : message, variant: 'destructive' });
      },
    },
  });

  const onDelete = async () => {
    if (await confirm({ title: `Delete “${s.name}”?`, description: 'Reports stop being sent and its run history is removed.', confirmLabel: 'Delete', destructive: true })) del.mutate({ id: s.id });
  };
  const filters = [s.platform ? (PLATFORM_META[s.platform as keyof typeof PLATFORM_META]?.name ?? s.platform) : 'All platforms', s.accountId ? 'one account' : 'all accounts'].join(', ');

  return <li className={`sfrs-item ${s.enabled ? '' : 'is-off'}`} data-testid={`row-schedule-${s.id}`}>
    <div className="sfrs-item__main">
      <div className="sfrs-item__title">
        <strong data-testid={`text-schedule-name-${s.id}`}>{s.name}</strong>
        {!s.enabled && <span className="sfa-pill sfa-pill--draft">Paused</span>}
        {s.lastStatus && <span className={`sfa-pill sfa-pill--${s.lastStatus === 'sent' ? 'success' : 'error'}`} data-testid={`status-last-run-${s.id}`}>Last run: {s.lastStatus === 'sent' ? 'sent' : 'failed'}</span>}
      </div>
      <dl className="sfrs-meta">
        <div><dt>Schedule</dt><dd>{cadence(s)} ({s.timezone})</dd></div>
        <div><dt>Next run</dt><dd data-testid={`text-next-run-${s.id}`}>{s.enabled ? `${fmtIn(s.nextRunAt, s.timezone)} (${s.timezone})` : 'Paused'}</dd></div>
        <div><dt>Range</dt><dd>{RANGE_OPTS.find((r) => r.key === s.rangeKey)?.label ?? s.rangeKey}, {filters}</dd></div>
        <div><dt>Recipients</dt><dd>{s.recipients.join(', ')}</dd></div>
        {s.lastRunAt && <div><dt>Last run</dt><dd>{fmtLocal(s.lastRunAt)}</dd></div>}
      </dl>
      {s.lastStatus === 'failed' && s.lastError && <p className="sfrs-err" role="status" data-testid={`text-last-error-${s.id}`}>{s.lastError}</p>}
    </div>
    <div className="sfrs-item__actions">
      {canManage && <label className="sfrs-check"><input type="checkbox" checked={s.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate({ id: s.id, data: { enabled: e.target.checked } })} data-testid={`switch-schedule-enabled-${s.id}`} /> Enabled</label>}
      {canManage && <Button size="sm" variant="secondary" icon={<Send size={13} />} loading={send.isPending} onClick={() => send.mutate({ id: s.id })} data-testid={`button-send-now-${s.id}`}>Send now</Button>}
      {canManage && <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={onEdit} data-testid={`button-edit-schedule-${s.id}`}>Edit</Button>}
      {canManage && <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} loading={del.isPending} onClick={() => { void onDelete(); }} data-testid={`button-delete-schedule-${s.id}`}>Delete</Button>}
      <Button size="sm" variant="ghost" icon={open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} aria-expanded={open} onClick={() => setOpen(!open)} data-testid={`button-toggle-runs-${s.id}`}>Run history</Button>
    </div>
    {open && <RunHistory scheduleId={s.id} />}
  </li>;
}

/* ---------- Section ---------- */
export function ReportSchedules() {
  const me = useAuthMe({ query: { queryKey: getAuthMeQueryKey(), retry: false } });
  const perms = me.data?.permissions ?? [];
  const canManage = perms.includes('reports:manage');
  const canRead = canManage || perms.includes('reports:read');
  const list = useListReportSchedules({ query: { queryKey: getListReportSchedulesQueryKey(), enabled: canRead } });
  const [dialog, setDialog] = useState<{ schedule: ReportSchedule | null } | null>(null);

  if (!canRead) return null;
  const schedules = list.data?.schedules ?? [];

  return <section className="sfa-card sfrs" aria-label="Scheduled reports" data-testid="section-report-schedules">
    <div className="sfa-card__head">
      <h2><Mail size={16} /> Scheduled reports</h2>
      {canManage && <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setDialog({ schedule: null })} data-testid="button-new-report-schedule">New schedule</Button>}
    </div>
    <p className="sfrs-note" data-testid="text-reports-note">Reports are emailed as a PDF. Email must be set up on the server. If it isn’t, runs fail and the reason is shown on the schedule.</p>
    {!canManage && <p className="sfrs-note">You can view schedules but not change them.</p>}
    <div className="sfrs-body">
      {list.isLoading ? <Skeleton height={72} />
        : list.isError ? <ErrorState title="Couldn't load scheduled reports" description={errInfo(list.error).message} onRetry={() => { void list.refetch(); }} />
        : schedules.length === 0 ? <EmptyState icon={<Mail size={22} />} title="No scheduled reports" description={canManage ? 'Create a schedule to email an analytics PDF to your team.' : 'No schedules have been set up for this workspace.'} />
        : <ul className="sfrs-list">{schedules.map((s) => <ScheduleRow key={s.id} s={s} canManage={canManage} onEdit={() => setDialog({ schedule: s })} />)}</ul>}
    </div>
    {dialog && <ScheduleDialog key={dialog.schedule?.id ?? 'new'} schedule={dialog.schedule} onClose={() => setDialog(null)} />}
  </section>;
}

export default ReportSchedules;
