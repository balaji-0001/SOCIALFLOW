import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useLocation, useSearch } from 'wouter';
import { format, formatDistanceToNow } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CirclePause, CirclePlay, Clock, Download, ExternalLink, FilePen, FileSpreadsheet, FlaskConical,
  History, Image as ImageIcon, ImageOff, Info, Link2, ListOrdered, MessageSquare, Pause, Pencil, Play, Plus, RefreshCw, Rss, Send, ShieldCheck, Trash2, TriangleAlert, UploadCloud, Workflow, X,
  type LucideIcon,
} from 'lucide-react';
import {
  getAuthMeQueryKey,
  getGetApprovalSettingsQueryKey,
  getGetAutomationQueryKey,
  getListAutomationItemsQueryKey,
  getListAutomationRunsQueryKey,
  getListAutomationsQueryKey,
  getListBulkImportsQueryKey,
  getListConnectedAccountsQueryKey,
  getListPostsQueryKey,
  useAuthMe,
  useCreateAutomation,
  useCreateBulkImport,
  useDeleteAutomation,
  useGetApprovalSettings,
  useListAutomationItems,
  useListAutomationRuns,
  useListAutomations,
  useListBulkImports,
  useListConnectedAccounts,
  usePauseAutomation,
  usePreviewBulkImport,
  useResumeAutomation,
  useRunAutomationNow,
  useTestAutomationSource,
  useUpdateAutomation,
  type Automation,
  type AutomationConfigInput,
  type AutomationItem,
  type AutomationItemStatus,
  type AutomationKind,
  type AutomationList,
  type AutomationMode,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationSourceItem,
  type AutomationSourceTest,
  type AutomationStatus,
  type BulkImportInput,
  type BulkImportMode,
  type BulkImportPreview,
  type BulkImportRecord,
  type BulkImportResult,
  type BulkImportRowError,
  type ConnectedAccount,
  type Platform,
} from '@workspace/api-client-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { insertAt } from './composer-utils';
import { useConfirm } from './confirm';
import { useLinkImage } from './link-preview-card';
import { AccountAvatar, PLATFORM_META, PlatformBadge, STATUS_LABEL } from './platforms';
import { Button, EmptyState, ErrorState, IconButton, PageHeader, Skeleton } from './ui';
import './automations.css';

/*
 * Automations: WordPress auto-share and RSS feeds that turn new articles into posts, plus CSV bulk import.
 * Everything on this page comes from the API (routes/automations.ts and routes/bulk-imports.ts). There is no sample data:
 * with nothing set up the page says so and offers the three ways to start.
 */

/* ---------- Limits (the server enforces them; these only save a round trip) ---------- */

const MAX_NAME = 120;
const MAX_URL = 2048;
const MAX_TEMPLATE = 2000;
const MAX_EXCERPT_IN_POST = 300;
const MAX_ITEM_ATTEMPTS = 3;
const DEFAULT_TEMPLATE = '{title}\n\n{url}';
const MAX_CSV_BYTES = 1_048_576;
const MAX_CSV_ROWS = 500;
const CSV_HEADER = 'content,scheduled_at,accounts,link,image_url,first_comment,tags';
const OFFLINE = "Couldn't reach the server. Check your connection and try again.";

/* ---------- Shared helpers ---------- */

/** The status and the server's own message from a failed request. A network failure has neither. */
function errInfo(error: unknown): { status: number | undefined; message: string | undefined } {
  if (typeof error !== 'object' || error === null) return { status: undefined, message: undefined };
  const status = (error as { status?: unknown }).status;
  const data = (error as { data?: unknown }).data;
  const message = typeof data === 'object' && data !== null ? (data as { message?: unknown }).message : undefined;
  return { status: typeof status === 'number' ? status : undefined, message: typeof message === 'string' && message.trim() !== '' ? message : undefined };
}

/** What to show the user: the server's message when it sent one, otherwise a plain fallback. */
function explain(error: unknown, fallback: string): string {
  const { status, message } = errInfo(error);
  return message ?? (status === undefined ? OFFLINE : fallback);
}

/** A missing permission or a deleted automation won't fix itself, so only network and server failures are retried. */
const retryTransient = (failureCount: number, error: unknown): boolean => {
  const { status } = errInfo(error);
  return (status === undefined || status >= 500) && failureCount < 2;
};

const toDate = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};
const ago = (iso: string | null | undefined): string => { const date = toDate(iso); return date ? formatDistanceToNow(date, { addSuffix: true }) : ''; };
const exact = (iso: string | null | undefined): string => { const date = toDate(iso); return date ? format(date, 'PPp') : ''; };
const plural = (count: number, one: string, many = `${one}s`): string => `${count.toLocaleString()} ${count === 1 ? one : many}`;
/** Only web addresses become links; anything else is shown as text. */
const safeHref = (url: string | null | undefined): string | undefined => (url && /^https?:\/\//i.test(url) ? url : undefined);
const hostOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return url.trim(); } };
const isPlatform = (value: string): value is Platform => Object.prototype.hasOwnProperty.call(PLATFORM_META, value);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function useGo() {
  const [, navigate] = useLocation();
  return (href: string) => (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(href);
  };
}

/** Re-renders on a timer so "5 minutes ago" and "in 10 minutes" stay true while the page is open. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/* ---------- Words for the API's values ---------- */

const KIND_META: Record<AutomationKind, { label: string; longLabel: string; color: string; sources: string; urlLabel: string; urlHelp: string; urlPlaceholder: string; title: string; about: string }> = {
  wordpress: {
    label: 'WordPress', longLabel: 'WordPress auto-share', color: '#21759b',
    sources: 'WordPress sites',
    urlLabel: 'Site address', urlHelp: 'Your site address, for example https://yoursite.com', urlPlaceholder: 'https://yoursite.com',
    title: 'Share new WordPress articles', about: 'Each new article on your WordPress site becomes a post for the accounts you choose.',
  },
  rss: {
    label: 'RSS', longLabel: 'RSS feed', color: '#ee802f',
    sources: 'RSS feeds',
    urlLabel: 'Feed address', urlHelp: 'The feed address', urlPlaceholder: 'https://example.com/feed',
    title: 'Share new items from a feed', about: 'Each new item in an RSS or Atom feed becomes a post for the accounts you choose.',
  },
};

type PollMinutes = AutomationList['pollMinutes'];

/** How often the server checks a kind of source, in words ("every 15 minutes", "every hour"), or '' until it has said. */
function cadenceOf(kind: AutomationKind, poll: PollMinutes | null | undefined): string {
  const minutes = poll?.[kind];
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 1) return '';
  if (minutes % 60 === 0) return minutes === 60 ? 'every hour' : `every ${minutes / 60} hours`;
  return minutes === 1 ? 'every minute' : `every ${minutes} minutes`;
}

const STATUS_META: Record<AutomationStatus, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'success' },
  paused: { label: 'Paused', tone: 'draft' },
  error: { label: 'Needs attention', tone: 'error' },
};

const MODE_WORDS: Record<AutomationMode, string> = { publish: 'Publishes immediately', queue: 'Adds to queue', draft: 'Saves as draft' };

const RUN_META: Record<AutomationRunStatus, { label: string; tone: string }> = {
  success: { label: 'Posts created', tone: 'success' },
  no_new: { label: 'Nothing new', tone: 'draft' },
  partial: { label: 'Some items failed', tone: 'warning' },
  failed: { label: 'Failed', tone: 'error' },
};

const ITEM_META: Record<AutomationItemStatus, { label: string; tone: string }> = {
  posted: { label: 'Posted', tone: 'success' },
  skipped: { label: 'Skipped', tone: 'draft' },
  failed: { label: 'Failed', tone: 'error' },
  seen: { label: 'Seen', tone: 'draft' },
  pending: { label: 'Pending', tone: 'info' },
};

const IMPORT_STATUS: Record<string, { label: string; tone: string }> = {
  completed: { label: 'Completed', tone: 'success' },
  partial: { label: 'Partly imported', tone: 'warning' },
  failed: { label: 'Failed', tone: 'error' },
};

const IMPORT_MODE_WORDS: Record<string, string> = { schedule: 'Scheduled', queue: 'Added to queue', draft: 'Saved as drafts' };

type RadioOption<T extends string> = { value: T; label: string; description: string; Icon: LucideIcon };

const AUTOMATION_MODES: RadioOption<AutomationMode>[] = [
  { value: 'publish', label: 'Publish immediately', description: 'Goes out within about a minute of being found.', Icon: Send },
  { value: 'queue', label: 'Add to queue', description: "Takes the next free time in each account's posting schedule.", Icon: ListOrdered },
  { value: 'draft', label: 'Save as draft', description: 'Nothing is sent until you review it.', Icon: FilePen },
];

const IMPORT_MODES: RadioOption<BulkImportMode>[] = [
  { value: 'schedule', label: "Schedule at each row's time", description: 'Every row needs a scheduled_at that is in the future.', Icon: CalendarClock },
  { value: 'queue', label: 'Add to queue', description: "Each post takes the next free time in its accounts' posting schedules. scheduled_at is ignored.", Icon: ListOrdered },
  { value: 'draft', label: 'Save as drafts', description: 'Nothing is scheduled or sent. scheduled_at is ignored.', Icon: FilePen },
];

const TOKENS: Array<{ token: string; hint: string }> = [
  { token: '{title}', hint: "The article's title" },
  { token: '{url}', hint: "The article's link" },
  { token: '{excerpt}', hint: 'The start of the article, up to 300 characters' },
  { token: '{author}', hint: "The author's name, when the source gives one" },
  { token: '{site}', hint: "The site or feed's name" },
];

const CSV_COLUMNS: Array<{ name: string; need: string; text: string }> = [
  { name: 'content', need: 'Required', text: 'The post text.' },
  { name: 'scheduled_at', need: 'Required to schedule', text: 'YYYY-MM-DD HH:mm in the time zone you choose in step 2, or an ISO date such as 2027-03-01T09:30:00Z. Ignored when adding to the queue or saving drafts.' },
  { name: 'accounts', need: 'Optional', text: 'Account names, usernames or IDs, separated by ; or |. Rows that leave it empty use the default accounts.' },
  { name: 'link', need: 'Optional', text: "A web address attached as the post's link." },
  { name: 'image_url', need: 'Optional', text: 'A picture to download and attach when importing. Instagram needs one.' },
  { name: 'first_comment', need: 'Optional', text: 'Posted as the first comment where the network allows it.' },
  { name: 'tags', need: 'Optional', text: 'Names of tags that already exist, separated by ;.' },
];

/* ---------- Kind marks ---------- */

/** The WordPress mark (Simple Icons, CC0). lucide has no WordPress icon. */
function WordPressGlyph({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
    <path d="M21.469 6.825c.84 1.537 1.318 3.3 1.318 5.175 0 3.979-2.156 7.456-5.363 9.325l3.295-9.527c.615-1.54.82-2.771.82-3.864 0-.405-.026-.78-.07-1.11m-7.981.105c.647-.03 1.232-.105 1.232-.105.582-.075.514-.93-.067-.899 0 0-1.755.135-2.88.135-1.064 0-2.85-.15-2.85-.15-.585-.03-.661.855-.075.885 0 0 .54.061 1.125.09l1.68 4.605-2.37 7.08L5.354 6.9c.649-.03 1.234-.1 1.234-.1.585-.075.516-.93-.065-.896 0 0-1.746.138-2.874.138-.2 0-.438-.008-.69-.015C4.911 3.15 8.235 1.215 12 1.215c2.809 0 5.365 1.072 7.286 2.833-.046-.003-.091-.009-.141-.009-1.06 0-1.812.923-1.812 1.914 0 .89.513 1.643 1.06 2.531.411.72.89 1.643.89 2.977 0 .915-.354 1.994-.821 3.479l-1.075 3.585-3.9-11.61.001.014zM12 22.784c-1.059 0-2.081-.153-3.048-.437l3.237-9.406 3.315 9.087c.024.053.05.101.078.149-1.12.393-2.325.609-3.582.609M1.211 12c0-1.564.336-3.05.935-4.39L7.29 21.709C3.694 19.96 1.212 16.271 1.211 12M12 0C5.385 0 0 5.385 0 12s5.385 12 12 12 12-5.385 12-12S18.615 0 12 0" />
  </svg>;
}

function KindMark({ kind, size = 36 }: { kind: AutomationKind; size?: number }) {
  const meta = KIND_META[kind] ?? KIND_META.rss;
  return <span className="sfa-auto-mark" style={{ background: meta.color, height: size, width: size }} aria-hidden="true">
    {kind === 'wordpress' ? <WordPressGlyph size={Math.round(size * 0.6)} /> : <Rss size={Math.round(size * 0.52)} strokeWidth={2.6} />}
  </span>;
}

/* ---------- Small controls ---------- */

function SwitchRow({ label, hint, checked, onChange, disabled = false, testid }: { label: string; hint: ReactNode; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; testid: string }) {
  const uid = useId();
  return <div className="sfa-auto-switchrow">
    <div className="sfa-auto-switchrow__copy">
      <span id={`${uid}-label`} className="sfa-auto-switchrow__label" onClick={() => { if (!disabled) onChange(!checked); }}>{label}</span>
      <span id={`${uid}-hint`} className="sfa-field__hint">{hint}</span>
    </div>
    <button type="button" role="switch" aria-checked={checked} aria-labelledby={`${uid}-label`} aria-describedby={`${uid}-hint`} className="sfa-auto-switch" disabled={disabled}
      onClick={() => onChange(!checked)} data-testid={testid}><span /></button>
  </div>;
}

function RadioCards<T extends string>({ name, value, options, onChange, disabled = false, testidPrefix }: { name: string; value: T; options: RadioOption<T>[]; onChange: (next: T) => void; disabled?: boolean; testidPrefix: string }) {
  return <div className="sfa-auto-radios">
    {options.map(({ value: option, label, description, Icon }) => <label key={option} className={`sfa-auto-radio ${value === option ? 'is-on' : ''} ${disabled ? 'is-disabled' : ''}`}>
      <input type="radio" name={name} value={option} checked={value === option} disabled={disabled} onChange={() => onChange(option)} data-testid={`${testidPrefix}-${option}`} />
      <strong><Icon size={15} aria-hidden="true" /> {label}</strong>
      <span>{description}</span>
    </label>)}
  </div>;
}

/** Shown only while the workspace has "require approval" on: nobody presses Send for approval on a post made for them. */
function ApprovalNote({ posts, testid }: { posts: string; testid: string }) {
  return <p className="sfa-auto-note" role="note" data-testid={testid}>
    <ShieldCheck size={15} aria-hidden="true" />
    <span>This workspace requires approval before publishing. {posts} wait until someone sends them for approval and they are approved. A post approved too long after its time is marked as missed and has to be published by hand.</span>
  </p>;
}

/* ---------- Account picker (the automation dialog and the import options) ---------- */

/** Why an account can't be chosen, or null when it can. */
function accountBlock(account: ConnectedAccount): string | null {
  if (account.platform === 'youtube') return 'YouTube posts need a video';
  if (account.status !== 'active') return 'Needs reconnecting';
  return null;
}

function AccountPicker({ name, accounts, loading, failed, onRetry, selected, onChange, disabled = false }: {
  name: string; accounts: ConnectedAccount[]; loading: boolean; failed: boolean; onRetry: () => void; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean;
}) {
  const go = useGo();
  if (loading) {
    return <ul className="sfa-auto-accounts" aria-busy="true" aria-label="Loading accounts">
      {[0, 1, 2, 3].map((i) => <li key={i}><span className="sfa-auto-account is-skel"><Skeleton width={18} height={18} radius={5} /><Skeleton width={32} height={32} radius={999} /><Skeleton width="55%" /></span></li>)}
    </ul>;
  }
  if (failed) return <p className="sfa-auto-err" role="alert">Couldn't load your connected accounts. <button type="button" className="sfa-linkbtn" onClick={onRetry}>Try again</button></p>;
  if (accounts.length === 0) {
    return <p className="sfa-empty-note" data-testid={`${name}-none`}>No accounts connected yet. <a href="/workspace" onClick={go('/workspace')}>Open Connected Accounts</a> to connect one, then come back.</p>;
  }
  const usable = accounts.filter((account) => accountBlock(account) === null);
  const usableIds = new Set(usable.map((account) => account.id));
  const allOn = usable.length > 0 && usable.every((account) => selected.includes(account.id));
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  return <div className="sfa-auto-pick">
    {usable.length > 1 && <div className="sfa-auto-pick__bar">
      <button type="button" className="sfa-linkbtn" disabled={disabled} onClick={() => onChange(allOn ? selected.filter((id) => !usableIds.has(id)) : [...new Set([...selected, ...usable.map((account) => account.id)])])}
        data-testid={`${name}-all`}>{allOn ? 'Clear selection' : 'Select all'}</button>
    </div>}
    <ul className="sfa-auto-accounts">
      {accounts.map((account) => {
        const on = selected.includes(account.id);
        const block = accountBlock(account);
        // An account that can no longer be used stays tickable only so it can be unticked.
        const locked = disabled || (block !== null && !on);
        const hintId = `${name}-${account.id}-hint`;
        return <li key={account.id}>
          <label className={`sfa-auto-account ${on ? 'is-on' : ''} ${locked ? 'is-disabled' : ''}`} data-testid={`${name}-${account.id}`}>
            <input type="checkbox" checked={on} disabled={locked} onChange={() => toggle(account.id)} aria-describedby={hintId} />
            <AccountAvatar account={account} size={32} />
            <span className="sfa-auto-account__copy">
              <strong>{account.displayName}</strong>
              <small id={hintId} className={block ? 'is-warn' : undefined}>{block ?? PLATFORM_META[account.platform].name}</small>
            </span>
          </label>
        </li>;
      })}
    </ul>
  </div>;
}

/* ---------- Post text template ---------- */

const TOKEN_PATTERN = /\{(title|url|excerpt|author|site)\}/g;
/** Stands in for {author} in a preview: the source test doesn't return the author. */
const AUTHOR_MARK = '';

/** Shortens text at a word boundary, ending with an ellipsis (the same rule the server uses for {excerpt}). */
function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, '')}…`;
}

/** Fills the template the way the server does when it creates the post. */
function renderTemplate(template: string, item: AutomationSourceItem, site: string): string {
  const values: Record<string, string> = { title: item.title, url: item.url ?? '', excerpt: truncateText(item.excerpt, MAX_EXCERPT_IN_POST), author: AUTHOR_MARK, site };
  return template
    .replace(TOKEN_PATTERN, (_match, key: string) => values[key] ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitTokens(text: string): Array<{ token: boolean; value: string }> {
  const parts: Array<{ token: boolean; value: string }> = [];
  let cursor = 0;
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ token: false, value: text.slice(cursor, index) });
    parts.push({ token: true, value: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push({ token: false, value: text.slice(cursor) });
  return parts;
}

/* ---------- Source test result ---------- */

function SourceThumb({ url }: { url: string | null }) {
  const image = useLinkImage(url);
  return <span className="sfa-auto-thumb" aria-hidden="true">
    {image.src ? <img src={image.src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={image.onError} /> : <ImageOff size={16} />}
  </span>;
}

type Tested = { input: string; result: AutomationSourceTest | null; error: string | null };

function TestResult({ tested, stale }: { tested: Tested; stale: boolean }) {
  const staleNote = stale ? <p className="sfa-auto-warn">The address has changed since this test. Test again to check the new one.</p> : null;
  if (!tested.result) {
    return <div className="sfa-auto-test is-error" data-testid="auto-test-result">
      <p className="sfa-auto-test__status"><CircleAlert size={15} aria-hidden="true" /> <span>{tested.error}</span></p>
      {staleNote}
    </div>;
  }
  const { result } = tested;
  return <div className="sfa-auto-test is-ok" data-testid="auto-test-result">
    <p className="sfa-auto-test__status"><CircleCheck size={15} aria-hidden="true" /> <span><strong>{result.sourceTitle?.trim() || 'The source answered'}</strong>{result.items.length > 0 ? ` · its latest ${plural(result.items.length, 'item')}` : ''}</span></p>
    <p className="sfa-auto-muted">Address as it will be saved: <span className="sfa-auto-code">{result.url}</span></p>
    {staleNote}
    {result.items.length === 0
      ? <p className="sfa-auto-muted">It has no items right now. New ones are posted as they appear.</p>
      : <ul className="sfa-auto-items" aria-label="Latest items">
        {result.items.map((item, index) => {
          const href = safeHref(item.url);
          const published = toDate(item.publishedAt);
          return <li key={`${item.url ?? item.title}-${index}`} className="sfa-auto-item">
            <SourceThumb url={item.imageUrl} />
            <span className="sfa-auto-item__copy">
              {href ? <a href={href} target="_blank" rel="noopener noreferrer" title={item.title}>{item.title || href}</a> : <strong title={item.title}>{item.title || 'Untitled item'}</strong>}
              <span>{published ? format(published, 'PP') : 'No date'}</span>
            </span>
          </li>;
        })}
      </ul>}
  </div>;
}

/* ---------- Create / edit dialog ---------- */

type DialogTarget = { mode: 'create'; kind: AutomationKind } | { mode: 'edit'; automation: Automation };

type FormState = { name: string; url: string; accountIds: string[]; mode: AutomationMode; template: string; includeImage: boolean; maxPosts: string; postExisting: boolean };

function initialForm(target: DialogTarget): FormState {
  if (target.mode === 'edit') {
    const { name, sourceUrl, config } = target.automation;
    return { name, url: sourceUrl, accountIds: [...config.connectedAccountIds], mode: config.mode, template: config.template, includeImage: config.includeImage, maxPosts: String(config.maxPostsPerRun), postExisting: config.postExistingOnFirstRun };
  }
  return { name: '', url: '', accountIds: [], mode: 'publish', template: DEFAULT_TEMPLATE, includeImage: true, maxPosts: '3', postExisting: false };
}

type FieldKey = 'name' | 'url' | 'accounts' | 'template' | 'maxPosts';
const FIELD_ORDER: FieldKey[] = ['name', 'url', 'accounts', 'template', 'maxPosts'];

function AutomationDialog({ target, accounts, accountsLoading, accountsFailed, onRetryAccounts, pollMinutes, approvalRequired, onClose, onCloseAutoFocus }: {
  target: DialogTarget; accounts: ConnectedAccount[]; accountsLoading: boolean; accountsFailed: boolean; onRetryAccounts: () => void;
  pollMinutes: PollMinutes | null; approvalRequired: boolean; onClose: () => void; onCloseAutoFocus: (event: Event) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const uid = useId();
  const editing = target.mode === 'edit' ? target.automation : null;
  const kind: AutomationKind = target.mode === 'edit' ? target.automation.kind : target.kind;
  const meta = KIND_META[kind] ?? KIND_META.rss;
  const cadence = cadenceOf(kind, pollMinutes);
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const templateRef = useRef<HTMLTextAreaElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState<FormState>(() => initialForm(target));
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [tested, setTested] = useState<Tested | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => { setForm((current) => ({ ...current, [key]: value })); setServerError(null); };
  // The server's answer sits just above the buttons at the foot of a long form; saving with Enter from a field
  // further up would leave it out of sight, so the foot (and the answer with it) is brought into view.
  useEffect(() => { if (serverError) footRef.current?.scrollIntoView({ block: 'nearest' }); }, [serverError]);

  const test = useTestAutomationSource({
    mutation: {
      onSuccess: (result, variables) => {
        setTested({ input: variables.data.url, result, error: null });
        // A new automation with no name yet takes the source's own title as a starting point.
        const title = result.sourceTitle?.trim();
        if (title) setForm((current) => (current.name.trim() === '' ? { ...current, name: title.slice(0, MAX_NAME) } : current));
      },
      onError: (error, variables) => setTested({ input: variables.data.url, result: null, error: explain(error, "The source couldn't be tested. Try again in a moment.") }),
    },
  });

  const refresh = (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: getListAutomationsQueryKey() });
    if (!id) return;
    void queryClient.invalidateQueries({ queryKey: getGetAutomationQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: getListAutomationRunsQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: getListAutomationItemsQueryKey(id) });
  };
  const failed = (error: unknown) => setServerError(explain(error, "The automation couldn't be saved. Try again."));
  const create = useCreateAutomation({
    mutation: {
      onSuccess: (saved) => {
        refresh();
        toast({ title: 'Automation created', description: saved.config.postExistingOnFirstRun
          ? 'It checks the source within about a minute and posts the newest article. After that, only new ones.'
          : 'It checks the source within about a minute. Articles already there are skipped; new ones are posted.' });
        onClose();
      },
      onError: failed,
    },
  });
  const update = useUpdateAutomation({
    mutation: {
      onSuccess: (saved) => {
        refresh(saved.id);
        toast({ title: 'Automation saved', description: editing && saved.sourceUrl !== editing.sourceUrl ? 'The new address starts fresh: articles already there are not posted again.' : undefined });
        onClose();
      },
      onError: failed,
    },
  });
  const saving = create.isPending || update.isPending;

  const url = form.url.trim();
  const accountsReady = !accountsLoading && !accountsFailed;
  const known = useMemo(() => new Set(accounts.map((account) => account.id)), [accounts]);
  // Accounts disconnected since the automation was saved can't be sent back: the server refuses unknown accounts.
  const chosen = accountsReady ? form.accountIds.filter((id) => known.has(id)) : form.accountIds;
  const gone = form.accountIds.length - chosen.length;
  const chosenAccounts = accounts.filter((account) => chosen.includes(account.id));
  const hasInstagram = chosenAccounts.some((account) => account.platform === 'instagram');
  const maxPosts = Number(form.maxPosts);

  const errors: Record<FieldKey, string | null> = {
    name: form.name.trim() === '' ? 'Give the automation a name.' : form.name.trim().length > MAX_NAME ? `The name can be up to ${MAX_NAME} characters.` : null,
    url: url === '' ? (kind === 'wordpress' ? "Enter your WordPress site's address." : "Enter the feed's address.") : url.length > MAX_URL ? 'That address is too long.' : null,
    accounts: chosen.length === 0 ? 'Choose at least one account to post to.' : chosen.length > 50 ? 'Choose at most 50 accounts.' : null,
    template: !form.template.includes('{title}') && !form.template.includes('{url}') ? 'The post text must include {title} or {url}.'
      : form.template.length > MAX_TEMPLATE ? `The post text can be up to ${MAX_TEMPLATE.toLocaleString()} characters.` : null,
    maxPosts: form.maxPosts.trim() === '' || !Number.isInteger(maxPosts) || maxPosts < 1 || maxPosts > 10 ? 'Posts per check must be 1 to 10.' : null,
  };
  // The template rule is shown as you type; the rest wait for the first attempt to save.
  const shown = (key: FieldKey): string | null => (attempted || key === 'template' ? errors[key] : null);
  const hasErrors = FIELD_ORDER.some((key) => errors[key] !== null);

  const focusField = (key: FieldKey) => {
    const holder = formRef.current?.querySelector<HTMLElement>(`[data-field="${key}"]`);
    if (!holder) return;
    const control = holder.matches('input, textarea, select') ? holder : holder.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled), a[href]');
    if (control) control.focus(); else holder.scrollIntoView({ block: 'nearest' });
  };

  const runTest = () => { if (url !== '' && !test.isPending) test.mutate({ data: { kind, url } }); };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setAttempted(true);
    setServerError(null);
    const firstInvalid = FIELD_ORDER.find((key) => errors[key] !== null);
    if (firstInvalid) { focusField(firstInvalid); return; }
    const config: AutomationConfigInput = { connectedAccountIds: chosen, mode: form.mode, template: form.template, includeImage: form.includeImage, maxPostsPerRun: maxPosts, postExistingOnFirstRun: form.postExisting };
    const name = form.name.trim();
    // An unchanged address is left out, so saving other settings never restarts the automation from scratch.
    if (editing) update.mutate({ id: editing.id, data: { name, ...(url !== editing.sourceUrl ? { sourceUrl: url } : {}), config } });
    else create.mutate({ data: { kind, name, sourceUrl: url, config } });
  };

  const insertToken = (token: string) => {
    const field = templateRef.current;
    const next = insertAt(form.template, field?.selectionStart ?? form.template.length, field?.selectionEnd ?? form.template.length, token);
    set('template', next.value);
    window.requestAnimationFrame(() => { field?.focus(); field?.setSelectionRange(next.caret, next.caret); });
  };

  const stale = tested !== null && tested.input !== url;
  const sample = tested?.result?.items[0] ?? null;
  const site = tested?.result?.sourceTitle?.trim() || hostOf(tested?.result?.url ?? url) || form.name.trim();
  const rendered = sample ? renderTemplate(form.template, sample, site) : null;
  const renderedLength = rendered === null ? 0 : rendered.split(AUTHOR_MARK).join('').length;
  const tightest = chosenAccounts.reduce<{ name: string; limit: number } | null>((lowest, account) => {
    const platform = PLATFORM_META[account.platform];
    return platform && (lowest === null || platform.charLimit < lowest.limit) ? { name: platform.name, limit: platform.charLimit } : lowest;
  }, null);
  const sourceChanged = editing !== null && url !== '' && url !== editing.sourceUrl;
  const footHint = attempted && hasErrors ? 'Check the highlighted fields.' : tested?.result && !stale ? '' : 'Tip: test the source before you save.';

  return <DialogPrimitive.Root open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="sfa-overlay" />
      <DialogPrimitive.Content className="sfa-dialog sfa-auto-dialog" data-testid="dialog-automation" onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={(event) => { event.preventDefault(); nameRef.current?.focus(); }}>
        <DialogPrimitive.Close asChild><button type="button" className="sfa-iconbtn sfa-dialog__close" aria-label="Close" data-testid="button-auto-close"><X size={18} /></button></DialogPrimitive.Close>
        <div className="sfa-auto-dialog__kind"><KindMark kind={kind} size={32} /><span className="sfa-eyebrow">{meta.longLabel}</span></div>
        <DialogPrimitive.Title className="sfa-dialog__title">{editing ? 'Edit automation' : meta.title}</DialogPrimitive.Title>
        <DialogPrimitive.Description className="sfa-dialog__desc">{meta.about}</DialogPrimitive.Description>

        <form ref={formRef} className="sfa-auto-form" onSubmit={submit} noValidate>
          <fieldset className="sfa-auto-fieldset">
            <legend className="sfa-label">Source</legend>
            <div className="sfa-field">
              <label htmlFor={`${uid}-name`}>Name</label>
              <input ref={nameRef} id={`${uid}-name`} data-field="name" className="sfa-input" value={form.name} maxLength={MAX_NAME} autoComplete="off"
                aria-invalid={shown('name') ? true : undefined} aria-describedby={shown('name') ? `${uid}-name-err` : undefined}
                onChange={(event) => set('name', event.target.value)} data-testid="input-auto-name" />
              {shown('name') && <p id={`${uid}-name-err`} className="sfa-auto-err" role="alert">{shown('name')}</p>}
            </div>
            <div className="sfa-field">
              <label htmlFor={`${uid}-url`}>{meta.urlLabel}</label>
              <div className="sfa-auto-urlrow">
                <input id={`${uid}-url`} data-field="url" className="sfa-input" type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off"
                  value={form.url} maxLength={MAX_URL} placeholder={meta.urlPlaceholder} aria-invalid={shown('url') ? true : undefined}
                  aria-describedby={`${uid}-url-help${shown('url') ? ` ${uid}-url-err` : ''}`} onChange={(event) => set('url', event.target.value)} data-testid="input-auto-url" />
                <Button variant="secondary" icon={<FlaskConical size={14} />} loading={test.isPending} disabled={url === ''} onClick={runTest} data-testid="button-auto-test">{test.isPending ? 'Testing…' : 'Test source'}</Button>
              </div>
              <span id={`${uid}-url-help`} className="sfa-field__hint">{meta.urlHelp}</span>
              {shown('url') && <p id={`${uid}-url-err`} className="sfa-auto-err" role="alert">{shown('url')}</p>}
              {sourceChanged && <p className="sfa-auto-muted">A new address starts fresh: articles already there are skipped, unless the option further down is on.</p>}
              <div aria-live="polite">
                {test.isPending
                  ? <div className="sfa-auto-test" aria-busy="true"><span className="sr-only">Testing the source</span><Skeleton width="45%" /><Skeleton height={44} radius={8} /><Skeleton height={44} radius={8} /></div>
                  : tested && <TestResult tested={tested} stale={stale} />}
              </div>
            </div>
            <p className="sfa-auto-cadence" data-testid="text-auto-cadence"><Clock size={14} aria-hidden="true" /> {cadence ? `${meta.sources} are checked ${cadence}. ` : ''}The first check happens within about a minute of saving.</p>
          </fieldset>

          <fieldset className="sfa-auto-fieldset" data-field="accounts" aria-describedby={shown('accounts') ? `${uid}-accounts-err` : undefined}>
            <legend className="sfa-label">Post to {chosen.length > 0 && <span className="sfa-count sfa-num">{chosen.length}</span>}</legend>
            <AccountPicker name="auto-account" accounts={accounts} loading={accountsLoading} failed={accountsFailed} onRetry={onRetryAccounts} selected={chosen} onChange={(ids) => set('accountIds', ids)} disabled={saving} />
            {gone > 0 && <p className="sfa-auto-warn" role="note">{gone === 1 ? 'One account this automation used is' : `${gone} accounts this automation used are`} no longer connected. Saving removes {gone === 1 ? 'it' : 'them'}.</p>}
            {shown('accounts') && <p id={`${uid}-accounts-err`} className="sfa-auto-err" role="alert">{shown('accounts')}</p>}
          </fieldset>

          <fieldset className="sfa-auto-fieldset">
            <legend className="sfa-label">When a new article is found</legend>
            <RadioCards name={`${uid}-mode`} value={form.mode} options={AUTOMATION_MODES} onChange={(mode) => set('mode', mode)} disabled={saving} testidPrefix="radio-auto-mode" />
            {form.mode === 'queue' && <p className="sfa-auto-muted">If an account has no free queue time, the post is saved as a draft and History says why.</p>}
            {approvalRequired && form.mode !== 'draft' && <ApprovalNote posts="Posts from this automation" testid="text-auto-approval" />}
          </fieldset>

          <fieldset className="sfa-auto-fieldset">
            <legend className="sfa-label">Post text</legend>
            <div className="sfa-field">
              <div className="sfa-field__row">
                <label htmlFor={`${uid}-template`}>Template</label>
                <span className={`sfa-counter ${form.template.length > MAX_TEMPLATE ? 'is-over' : ''}`} data-testid="text-auto-template-count">{form.template.length.toLocaleString()} / {MAX_TEMPLATE.toLocaleString()}</span>
              </div>
              <div className="sfa-auto-tokens" role="group" aria-label="Insert a placeholder at the cursor">
                {TOKENS.map(({ token, hint }) => <button key={token} type="button" className="sfa-auto-token" title={hint} aria-label={`Insert ${token}: ${hint}`} disabled={saving} onClick={() => insertToken(token)} data-testid={`button-auto-token-${token.slice(1, -1)}`}>{token}</button>)}
              </div>
              <textarea ref={templateRef} id={`${uid}-template`} data-field="template" className="sfa-textarea sfa-auto-template" rows={4} value={form.template}
                aria-invalid={shown('template') ? true : undefined} aria-describedby={`${uid}-template-help${shown('template') ? ` ${uid}-template-err` : ''}`}
                onChange={(event) => set('template', event.target.value)} data-testid="input-auto-template" />
              <span id={`${uid}-template-help`} className="sfa-field__hint">Placeholders are replaced with each article's own details. Click one to insert it where the cursor is.</span>
              {shown('template') && <p id={`${uid}-template-err`} className="sfa-auto-err" role="alert" data-testid="text-auto-template-error">{shown('template')} <button type="button" className="sfa-linkbtn" onClick={() => set('template', DEFAULT_TEMPLATE)}>Use the default</button></p>}
            </div>
            <div className="sfa-auto-tplpreview" aria-live="polite" data-testid="auto-template-preview">
              <span className="sfa-label">Preview</span>
              {rendered !== null
                ? <>
                  <p className="sfa-auto-tplpreview__text">{rendered === '' ? <span className="sfa-muted">This would be an empty post.</span> : rendered.split(AUTHOR_MARK).map((part, index, all) => <Fragment key={index}>{part}{index < all.length - 1 && <span className="sfa-auto-tok">{'{author}'}</span>}</Fragment>)}</p>
                  <p className="sfa-auto-muted">Made from the newest item in your test{sample?.title ? `, “${truncateText(sample.title, 60)}”` : ''}.{rendered.includes(AUTHOR_MARK) ? ' The test doesn’t return the author, so {author} is filled in when the post is created.' : ''}</p>
                  {tightest && renderedLength > tightest.limit && <p className="sfa-auto-warn">This example is {renderedLength.toLocaleString()} characters, more than {tightest.name} allows ({tightest.limit.toLocaleString()}). Items that come out too long aren't posted, so shorten the text.</p>}
                </>
                : <>
                  <p className="sfa-auto-tplpreview__text">{splitTokens(form.template).map((part, index) => (part.token ? <span key={index} className="sfa-auto-tok">{part.value}</span> : <Fragment key={index}>{part.value}</Fragment>))}</p>
                  <p className="sfa-auto-muted">Test the source to preview real text</p>
                </>}
            </div>
          </fieldset>

          <fieldset className="sfa-auto-fieldset">
            <legend className="sfa-label">Options</legend>
            <SwitchRow label="Include the article's picture" hint="Facebook and LinkedIn show it on the link card. Instagram posts it as the photo." checked={form.includeImage} onChange={(next) => set('includeImage', next)} disabled={saving} testid="switch-auto-image" />
            {hasInstagram && <p className={form.includeImage ? 'sfa-auto-muted' : 'sfa-auto-warn'} role="note">{form.includeImage
              ? "Instagram needs a picture, so an article without one can't be posted to Instagram."
              : 'Instagram needs a picture. With this off, nothing can be posted to the Instagram account you chose.'}</p>}
            <div className="sfa-auto-switchrow">
              <div className="sfa-auto-switchrow__copy">
                <label htmlFor={`${uid}-max`} className="sfa-auto-switchrow__label">Posts per check</label>
                <span id={`${uid}-max-help`} className="sfa-field__hint">The most posts one check creates, from 1 to 10. When more new articles are found, the rest follow on the next checks.</span>
                {shown('maxPosts') && <p id={`${uid}-max-err`} className="sfa-auto-err" role="alert">{shown('maxPosts')}</p>}
              </div>
              <input id={`${uid}-max`} data-field="maxPosts" className="sfa-input sfa-auto-num sfa-num" type="number" min={1} max={10} step={1} inputMode="numeric" value={form.maxPosts} disabled={saving}
                aria-invalid={shown('maxPosts') ? true : undefined} aria-describedby={`${uid}-max-help${shown('maxPosts') ? ` ${uid}-max-err` : ''}`}
                onChange={(event) => set('maxPosts', event.target.value)} data-testid="input-auto-max-posts" />
            </div>
            <SwitchRow label="Also post the newest existing article when I turn this on"
              hint={`Otherwise existing articles are skipped and only new ones are posted.${editing ? ' This applies to the first check, and again if you change the address.' : ''}`}
              checked={form.postExisting} onChange={(next) => set('postExisting', next)} disabled={saving} testid="switch-auto-post-existing" />
          </fieldset>

          {serverError && <div className="sfa-alert" role="alert" data-testid="status-auto-error"><CircleAlert size={15} aria-hidden="true" /> <span>{serverError}</span></div>}

          <div ref={footRef} className="sfa-auto-foot">
            <span className={`sfa-auto-foot__hint ${attempted && hasErrors ? 'is-error' : ''}`} role="status">{footHint}</span>
            <Button variant="secondary" disabled={saving} onClick={onClose} data-testid="button-auto-cancel">Cancel</Button>
            <Button type="submit" variant="primary" loading={saving} data-testid="button-auto-save">{editing ? 'Save changes' : 'Create automation'}</Button>
          </div>
        </form>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

/* ---------- History drawer ---------- */

type HistoryTab = 'runs' | 'items';

function RunRow({ run }: { run: AutomationRun }) {
  const meta = RUN_META[run.status] ?? { label: run.status, tone: 'draft' };
  return <li className="sfa-auto-run" data-testid={`row-auto-run-${run.id}`}>
    <div className="sfa-auto-run__top">
      <span className={`sfa-pill sfa-pill--${meta.tone}`}>{meta.label}</span>
      <time dateTime={run.startedAt} title={exact(run.startedAt)}>{exact(run.startedAt)} <span className="sfa-auto-dim">({ago(run.startedAt)})</span></time>
    </div>
    <dl className="sfa-auto-run__counts">
      <div><dt>Found</dt><dd className="sfa-num">{run.itemsFound}</dd></div>
      <div><dt>New</dt><dd className="sfa-num">{run.itemsNew}</dd></div>
      <div><dt>Posts created</dt><dd className="sfa-num">{run.postsCreated}</dd></div>
    </dl>
    {run.error && <p className="sfa-auto-err">{run.error}</p>}
  </li>;
}

function ItemRow({ item, go }: { item: AutomationItem; go: ReturnType<typeof useGo> }) {
  const meta = ITEM_META[item.status] ?? { label: item.status, tone: 'draft' };
  const href = safeHref(item.url);
  const title = item.title?.trim() || item.url || 'Untitled item';
  const published = toDate(item.publishedAt);
  const scheduled = toDate(item.postScheduledAt);
  const postWords = item.postStatus ? (STATUS_LABEL[item.postStatus as keyof typeof STATUS_LABEL] ?? item.postStatus) : null;
  // Drafts aren't listed on Manage Posts, so a draft's link goes to Drafts instead.
  const postHref = item.postStatus === 'draft' ? '/drafts' : '/posts';
  return <li className="sfa-auto-hitem" data-testid={`row-auto-item-${item.id}`}>
    <div className="sfa-auto-hitem__top">
      {href
        ? <a className="sfa-auto-hitem__title" href={href} target="_blank" rel="noopener noreferrer">{title} <ExternalLink size={12} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
        : <strong className="sfa-auto-hitem__title">{title}</strong>}
      <span className={`sfa-pill sfa-pill--${meta.tone}`}>{meta.label}</span>
    </div>
    <p className="sfa-auto-muted">
      {published && <>Published {format(published, 'PP')} · </>}
      recorded <time dateTime={item.createdAt} title={exact(item.createdAt)}>{ago(item.createdAt)}</time>
      {item.status === 'failed' && <> · tried {Math.min(item.attempts, MAX_ITEM_ATTEMPTS)} of {MAX_ITEM_ATTEMPTS} times</>}
    </p>
    {item.postId && (postWords
      ? <p className="sfa-auto-hitem__post">Post: {postWords}{item.postStatus === 'scheduled' && scheduled ? ` for ${format(scheduled, 'PPp')}` : ''} · <a className="sfa-linkbtn" href={postHref} onClick={go(postHref)} data-testid={`link-auto-item-post-${item.id}`}>Open {item.postStatus === 'draft' ? 'Drafts' : 'Manage Posts'}</a></p>
      : <p className="sfa-auto-muted">Its post has since been deleted.</p>)}
    {item.error && <p className={item.status === 'failed' ? 'sfa-auto-err' : 'sfa-auto-muted'}>{item.error}</p>}
  </li>;
}

function HistoryDrawer({ automation, onClose, onCloseAutoFocus }: { automation: Automation; onClose: () => void; onCloseAutoFocus: (event: Event) => void }) {
  const go = useGo();
  const uid = useId();
  const { id } = automation;
  const [tab, setTab] = useState<HistoryTab>('runs');
  const [refreshing, setRefreshing] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const runs = useListAutomationRuns(id, { query: { queryKey: getListAutomationRunsQueryKey(id), refetchInterval: 30_000, retry: retryTransient } });
  const items = useListAutomationItems(id, { query: { queryKey: getListAutomationItemsQueryKey(id), refetchInterval: 30_000, retry: retryTransient } });
  const runList = runs.data?.runs ?? [];
  const itemList = items.data?.items ?? [];
  const tabs: Array<{ id: HistoryTab; label: string; count: number | null }> = [
    { id: 'runs', label: 'Runs', count: runs.data ? runList.length : null },
    { id: 'items', label: 'Items', count: items.data ? itemList.length : null },
  ];
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'Home' ? -index : event.key === 'End' ? tabs.length - 1 - index : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + tabs.length) % tabs.length;
    setTab(tabs[next]!.id);
    tabRefs.current[next]?.focus();
  };
  const reload = () => {
    setRefreshing(true);
    void Promise.all([runs.refetch(), items.refetch()]).finally(() => setRefreshing(false));
  };

  return <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="sfa-overlay" />
      <DialogPrimitive.Content className="sfa-auto-drawer" aria-describedby={undefined} data-testid="drawer-auto-history" onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={(event) => { event.preventDefault(); tabRefs.current[0]?.focus(); }}>
        <header className="sfa-auto-drawer__head">
          <KindMark kind={automation.kind} size={32} />
          <div className="sfa-auto-drawer__title">
            <DialogPrimitive.Title asChild><h2>History</h2></DialogPrimitive.Title>
            <span title={automation.name}>{automation.name}</span>
          </div>
          <IconButton label="Refresh" disabled={refreshing} onClick={reload} data-testid="button-auto-history-refresh"><RefreshCw size={15} className={refreshing ? 'sfa-spin' : undefined} /></IconButton>
          <DialogPrimitive.Close asChild><button type="button" className="sfa-iconbtn" aria-label="Close" title="Close" data-testid="button-auto-history-close"><X size={18} /></button></DialogPrimitive.Close>
        </header>
        <div className="sfa-auto-dtabs" role="tablist" aria-label="History">
          {tabs.map((entry, index) => <button key={entry.id} type="button" role="tab" id={`${uid}-tab-${entry.id}`} aria-selected={tab === entry.id} aria-controls={`${uid}-panel`} tabIndex={tab === entry.id ? 0 : -1}
            ref={(el) => { tabRefs.current[index] = el; }} className={tab === entry.id ? 'is-on' : ''} onClick={() => setTab(entry.id)} onKeyDown={(event) => onTabKey(event, index)} data-testid={`tab-auto-history-${entry.id}`}>
            {entry.label}{entry.count !== null && entry.count > 0 && <span className="sfa-auto-dtabs__count sfa-num">{entry.count}</span>}
          </button>)}
        </div>
        <div className="sfa-auto-drawer__body" role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${tab}`}>
          {tab === 'runs' && <>
            <p className="sfa-auto-muted">Each time the source was checked: what was found and how many posts were created.</p>
            {runs.isError && !runs.data ? <ErrorState title="Couldn't load the runs" description={errInfo(runs.error).message} onRetry={() => { void runs.refetch(); }} />
              : runs.isLoading ? <ul className="sfa-auto-hlist" aria-busy="true" aria-label="Loading runs">{[0, 1, 2].map((i) => <li key={i} className="sfa-auto-run"><Skeleton width={110} height={22} radius={999} /><Skeleton width={`${70 - i * 12}%`} /></li>)}</ul>
              : runList.length === 0 ? <p className="sfa-auto-drawer__empty" data-testid="text-auto-no-runs">{automation.status === 'active' ? 'No runs yet. The first check happens within about a minute of creating the automation.' : 'No runs yet.'}</p>
              : <>
                <ul className="sfa-auto-hlist" aria-label="Runs, newest first" data-testid="list-auto-runs">{runList.map((run) => <RunRow key={run.id} run={run} />)}</ul>
                {runList.length >= 50 && <p className="sfa-auto-muted">Only the latest 50 runs are kept.</p>}
              </>}
          </>}
          {tab === 'items' && <>
            <p className="sfa-auto-drawer__note" role="note" data-testid="text-auto-seen-note"><Info size={14} aria-hidden="true" /> <span>“Seen” items already existed when the automation was switched on. They are recorded but not posted.</span></p>
            {items.isError && !items.data ? <ErrorState title="Couldn't load the items" description={errInfo(items.error).message} onRetry={() => { void items.refetch(); }} />
              : items.isLoading ? <ul className="sfa-auto-hlist" aria-busy="true" aria-label="Loading items">{[0, 1, 2].map((i) => <li key={i} className="sfa-auto-hitem"><Skeleton width={`${78 - i * 14}%`} /><Skeleton width={150} /></li>)}</ul>
              : itemList.length === 0 ? <p className="sfa-auto-drawer__empty" data-testid="text-auto-no-items">No items recorded yet. They appear after the first check of the source.</p>
              : <>
                <ul className="sfa-auto-hlist" aria-label="Items, newest first" data-testid="list-auto-items">{itemList.map((item) => <ItemRow key={item.id} item={item} go={go} />)}</ul>
                {itemList.length >= 100 && <p className="sfa-auto-muted">Showing the latest 100 items.</p>}
              </>}
          </>}
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

/* ---------- Automation card ---------- */

/** What went wrong last time and what to do about it, or null when nothing did. */
function problemOf(automation: Automation): { title: string; todo: string } | null {
  if (automation.status === 'error') return { title: 'Stopped after repeated errors', todo: 'Fix the source address with Edit, or press Resume to try again.' };
  if (!automation.lastError) return null;
  if (automation.consecutiveFailures > 0) {
    return {
      title: `The source couldn't be read (${automation.consecutiveFailures} failed ${automation.consecutiveFailures === 1 ? 'check' : 'checks'} in a row)`,
      todo: automation.status === 'paused'
        ? 'Fix the source address with Edit, then press Resume to try again.'
        : 'It keeps trying, a little later each time, and stops after 5 failed checks in a row. If the address is wrong, fix it with Edit.',
    };
  }
  return { title: "Some items couldn't be posted", todo: 'Each item is tried up to 3 times. Open History to see which ones, then fix the cause, for example by reconnecting an account.' };
}

function lastOutcome(automation: Automation): { text: string; tone: string } | null {
  switch (automation.lastStatus) {
    case 'success': return { text: 'New posts created', tone: 'ok' };
    case 'no_new': return { text: 'Nothing new', tone: 'quiet' };
    case 'partial': return { text: 'Some items failed', tone: 'warn' };
    case 'failed': return { text: automation.consecutiveFailures > 0 ? "Couldn't read the source" : "Items couldn't be posted", tone: 'bad' };
    default: return null;
  }
}

function nextRunText(automation: Automation, now: number): string {
  if (automation.status === 'paused') return 'Paused';
  if (automation.status === 'error') return 'Stopped after repeated errors';
  const next = toDate(automation.nextRunAt);
  if (!next) return 'Not scheduled';
  // The server looks for due automations once a minute.
  if (next.getTime() <= now + 45_000) return 'Within about a minute';
  return formatDistanceToNow(next, { addSuffix: true });
}

function AutomationCard({ automation, canManage, now, onEdit, onHistory }: { automation: Automation; canManage: boolean; now: number; onEdit: (opener: HTMLElement) => void; onHistory: (opener: HTMLElement) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const go = useGo();
  const { id, status } = automation;
  const statusMeta = STATUS_META[status] ?? { label: status, tone: 'draft' };
  const kindMeta = KIND_META[automation.kind] ?? KIND_META.rss;
  const firstRun = useRef(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getListAutomationsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetAutomationQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: getListAutomationRunsQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: getListAutomationItemsQueryKey(id) });
  };
  /** Shows the server's answer straight away; the refetch that follows confirms it. */
  const store = (saved: Automation) => {
    queryClient.setQueryData<AutomationList>(getListAutomationsQueryKey(), (old) => (old ? { ...old, automations: old.automations.map((item) => (item.id === saved.id ? saved : item)) } : old));
  };
  const failed = (title: string) => (error: unknown) => { refresh(); toast({ title, description: explain(error, 'Please try again.'), variant: 'destructive' }); };

  const pause = usePauseAutomation({ mutation: { onSuccess: (saved) => { store(saved); refresh(); toast({ title: 'Automation paused', description: 'It stops checking the source until you resume it.' }); }, onError: failed("Couldn't pause the automation") } });
  const resume = useResumeAutomation({ mutation: { onSuccess: (saved) => { store(saved); refresh(); toast({ title: 'Automation resumed', description: 'It checks the source again within about a minute.' }); }, onError: failed("Couldn't resume the automation") } });
  const run = useRunAutomationNow({
    mutation: {
      onSuccess: ({ run: result, automation: saved }) => {
        store(saved);
        refresh();
        // New posts change the lists and counts elsewhere in the app.
        void queryClient.invalidateQueries({ queryKey: [getListPostsQueryKey()[0]] });
        const found = plural(result.itemsFound, 'item');
        if (result.status === 'success') toast({ title: `${plural(result.postsCreated, 'post')} created`, description: `The source has ${found}; ${result.itemsNew} ${result.itemsNew === 1 ? 'was' : 'were'} new.` });
        else if (result.status === 'no_new') toast({ title: 'Nothing new to post', description: firstRun.current ? `This first check recorded the ${found} already in the source. New ones are posted from now on.` : `The source has ${found} and none are new.` });
        else if (result.status === 'partial') toast({ title: "Some items couldn't be posted", description: `${plural(result.postsCreated, 'post')} created. ${result.error ?? 'See History for the reason.'}`, variant: 'destructive' });
        else toast({ title: 'The check failed', description: result.error ?? 'See History for the reason.', variant: 'destructive' });
      },
      onError: (error) => {
        refresh();
        const { status: code, message } = errInfo(error);
        if (code === 429) toast({ title: 'Too many checks in a short time', description: message ?? 'Try again in a few minutes.', variant: 'destructive' });
        else toast({ title: "Couldn't check the source", description: explain(error, 'Please try again.'), variant: 'destructive' });
      },
    },
  });
  const remove = useDeleteAutomation({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListAutomationsQueryKey() });
        queryClient.removeQueries({ queryKey: getListAutomationRunsQueryKey(id) });
        queryClient.removeQueries({ queryKey: getListAutomationItemsQueryKey(id) });
        toast({ title: 'Automation deleted', description: 'Posts it already created are kept.' });
      },
      onError: failed("Couldn't delete the automation"),
    },
  });
  const toggling = pause.isPending || resume.isPending;
  const busy = toggling || run.isPending || remove.isPending;
  const stopped = status !== 'active';

  const onDelete = async () => {
    if (await confirm({ title: `Delete “${automation.name}”?`, description: 'It stops checking the source and its history is removed. Posts it already created are kept.', confirmLabel: 'Delete', destructive: true })) remove.mutate({ id });
  };

  const sourceHref = safeHref(automation.sourceUrl);
  const shownAccounts = automation.accounts.slice(0, 3);
  const moreAccounts = automation.accounts.slice(3);
  const needReconnect = automation.accounts.filter((account) => account.status !== 'active');
  const goneAccounts = Math.max(0, automation.config.connectedAccountIds.length - automation.accounts.length);
  const outcome = lastOutcome(automation);
  const problem = problemOf(automation);

  return <li className={`sfa-card sfa-auto-card is-${status}`} data-testid={`automation-card-${id}`}>
    <div className="sfa-auto-card__head">
      <KindMark kind={automation.kind} />
      <div className="sfa-auto-card__title">
        <h3 data-testid={`text-auto-name-${id}`}>{automation.name}</h3>
        <p className="sfa-auto-source">
          <span className="sfa-auto-kind">{kindMeta.label}</span>
          {sourceHref
            ? <a href={sourceHref} target="_blank" rel="noopener noreferrer" title={automation.sourceUrl}><span>{automation.sourceUrl}</span><ExternalLink size={12} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
            : <span className="sfa-auto-source__text" title={automation.sourceUrl}>{automation.sourceUrl}</span>}
        </p>
      </div>
      <span className={`sfa-pill sfa-pill--${statusMeta.tone}`} data-testid={`status-auto-${id}`}>{statusMeta.label}</span>
    </div>

    <dl className="sfa-auto-meta">
      <div className="sfa-auto-meta__wide">
        <dt>Posts to</dt>
        <dd>
          {automation.accounts.length === 0
            ? <span className="sfa-auto-warn">No accounts left{canManage ? '. Use Edit to choose where to post.' : '.'}</span>
            : <span className="sfa-auto-accts">
              {shownAccounts.map((account) => <span key={account.id} className={`sfa-auto-acct ${account.status !== 'active' ? 'is-warn' : ''}`} title={account.status !== 'active' ? `${account.name} needs reconnecting` : account.name}>
                {isPlatform(account.platform) ? <PlatformBadge platform={account.platform} size={14} /> : <span className="sfa-auto-acct__dot" aria-hidden="true" />}
                <span>{account.name}</span>
              </span>)}
              {moreAccounts.length > 0 && <span className="sfa-count sfa-num" title={moreAccounts.map((account) => account.name).join(', ')} aria-label={`and ${moreAccounts.length} more: ${moreAccounts.map((account) => account.name).join(', ')}`}>+{moreAccounts.length}</span>}
            </span>}
          {needReconnect.length > 0 && <span className="sfa-auto-warn">{needReconnect.map((account) => account.name).join(', ')} {needReconnect.length === 1 ? 'needs' : 'need'} reconnecting on <a className="sfa-auto-inlinelink" href="/workspace" onClick={go('/workspace')}>Connected Accounts</a>.</span>}
          {goneAccounts > 0 && <span className="sfa-auto-warn">{plural(goneAccounts, 'account')} it used {goneAccounts === 1 ? 'was' : 'were'} disconnected.</span>}
        </dd>
      </div>
      <div><dt>Posting</dt><dd>{MODE_WORDS[automation.config.mode] ?? automation.config.mode}</dd></div>
      <div>
        <dt>Last run</dt>
        <dd data-testid={`text-auto-last-run-${id}`}>
          {automation.lastRunAt ? <time dateTime={automation.lastRunAt} title={exact(automation.lastRunAt)}>{ago(automation.lastRunAt)}</time> : <span className="sfa-auto-dim">Not checked yet</span>}
          {automation.lastRunAt && outcome && <span className={`sfa-auto-outcome is-${outcome.tone}`}>{outcome.text}</span>}
        </dd>
      </div>
      <div><dt>Next run</dt><dd data-testid={`text-auto-next-run-${id}`} title={(status === 'active' && exact(automation.nextRunAt)) || undefined}>{nextRunText(automation, now)}</dd></div>
      <div><dt>Posts created</dt><dd className="sfa-num" data-testid={`text-auto-posts-${id}`}>{automation.postsCreatedTotal.toLocaleString()}</dd></div>
    </dl>

    {problem && <div className="sfa-auto-problem" role="status" data-testid={`text-auto-error-${id}`}>
      <TriangleAlert size={16} aria-hidden="true" />
      <div>
        <strong>{problem.title}</strong>
        {automation.lastError && <p>{automation.lastError}</p>}
        <p className="sfa-auto-problem__todo">{canManage ? problem.todo : 'Someone who can manage automations needs to look at this.'}</p>
      </div>
    </div>}

    <div className="sfa-auto-card__actions">
      {canManage && <>
        <Button size="sm" variant={status === 'error' ? 'primary' : 'secondary'} icon={stopped ? <Play size={13} /> : <Pause size={13} />} loading={toggling} disabled={busy}
          onClick={() => (stopped ? resume : pause).mutate({ id })} data-testid={`button-auto-pause-${id}`}>{stopped ? 'Resume' : 'Pause'}</Button>
        <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} loading={run.isPending} disabled={busy} title="Check the source now"
          onClick={() => { firstRun.current = automation.lastRunAt === null; run.mutate({ id }); }} data-testid={`button-auto-run-${id}`}>{run.isPending ? 'Checking…' : 'Run now'}</Button>
        <Button size="sm" variant="ghost" icon={<Pencil size={13} />} disabled={busy} onClick={(event) => onEdit(event.currentTarget)} data-testid={`button-auto-edit-${id}`}>Edit</Button>
      </>}
      <Button size="sm" variant="ghost" icon={<History size={13} />} onClick={(event) => onHistory(event.currentTarget)} data-testid={`button-auto-history-${id}`}>History</Button>
      {canManage && <Button size="sm" variant="ghost" className="sfa-auto-card__delete" icon={<Trash2 size={13} />} loading={remove.isPending} disabled={busy} onClick={() => { void onDelete(); }} data-testid={`button-auto-delete-${id}`}>Delete</Button>}
    </div>
  </li>;
}

function CardsSkeleton() {
  return <ul className="sfa-auto-list" aria-busy="true" aria-label="Loading automations">
    {[0, 1, 2].map((i) => <li key={i} className="sfa-card sfa-auto-card">
      <div className="sfa-auto-card__head">
        <Skeleton width={36} height={36} radius={10} />
        <div className="sfa-auto-card__title"><Skeleton width={`${46 - i * 8}%`} height={16} /><Skeleton width="62%" /></div>
        <Skeleton width={72} height={22} radius={999} />
      </div>
      <div className="sfa-auto-meta">{[0, 1, 2, 3].map((j) => <div key={j}><Skeleton width={64} height={10} /><Skeleton width="78%" /></div>)}</div>
    </li>)}
  </ul>;
}

/* ---------- Automations tab ---------- */

function AutomationsPanel({ hidden, automations, limit, pollMinutes, loading, failed, failure, refreshFailed, onRetry, canManage, canImport, onCreate, onImport, onEdit, onHistory }: {
  hidden: boolean; automations: Automation[]; limit: number | null; pollMinutes: PollMinutes | null; loading: boolean; failed: boolean; failure: string | undefined; refreshFailed: boolean; onRetry: () => void;
  canManage: boolean; canImport: boolean; onCreate: (kind: AutomationKind, opener: HTMLElement) => void; onImport: () => void;
  onEdit: (automation: Automation, opener: HTMLElement) => void; onHistory: (automation: Automation, opener: HTMLElement) => void;
}) {
  const now = useNow();
  const wordpressCadence = cadenceOf('wordpress', pollMinutes);
  const rssCadence = cadenceOf('rss', pollMinutes);
  // Automations that stopped come first; the rest keep the order they were created in.
  const ordered = useMemo(() => [...automations].sort((a, b) => Number(b.status === 'error') - Number(a.status === 'error')), [automations]);
  const count = (status: AutomationStatus) => automations.filter((item) => item.status === status).length;
  const stats: Array<{ key: string; label: string; value: number; Icon: LucideIcon; tone: string }> = [
    { key: 'active', label: 'Active', value: count('active'), Icon: CirclePlay, tone: 'success' },
    { key: 'paused', label: 'Paused', value: count('paused'), Icon: CirclePause, tone: 'neutral' },
    { key: 'attention', label: 'Needs attention', value: count('error'), Icon: TriangleAlert, tone: 'error' },
    { key: 'posts', label: 'Posts created', value: automations.reduce((sum, item) => sum + (Number.isFinite(item.postsCreatedTotal) ? item.postsCreatedTotal : 0), 0), Icon: Send, tone: 'info' },
  ];
  const atLimit = limit !== null && automations.length >= limit;
  const canStart = canManage || canImport;

  return <div role="tabpanel" id="sfa-auto-panel-automations" aria-labelledby="sfa-auto-tab-automations" className="sfa-auto-panel" hidden={hidden}>
    {!canManage && <p className="sfa-auto-note" role="note" data-testid="text-auto-readonly"><Info size={15} aria-hidden="true" /> <span>Your role can see automations and their history, but can't create or change them. An editor, admin or owner can.</span></p>}

    {!failed && <section className="sfa-auto-stats" aria-label="Summary">
      {stats.map(({ key, label, value, Icon, tone }) => <div key={key} className="sfa-card sfa-auto-stat" data-testid={`stat-auto-${key}`}>
        <span className={`sfa-auto-stat__icon is-${tone}`} aria-hidden="true"><Icon size={16} /></span>
        <span className="sfa-auto-stat__copy"><span>{label}</span>{loading ? <Skeleton width={36} height={22} /> : <strong className="sfa-num">{value.toLocaleString()}</strong>}</span>
      </div>)}
    </section>}

    {refreshFailed && <p className="sfa-auto-note sfa-auto-note--warn" role="status"><TriangleAlert size={15} aria-hidden="true" /> <span>Couldn't refresh just now, so this may be out of date. <button type="button" className="sfa-linkbtn" onClick={onRetry}>Try again</button></span></p>}

    {failed ? <div className="sfa-card"><ErrorState title="Couldn't load your automations" description={failure} onRetry={onRetry} /></div>
      : loading ? <CardsSkeleton />
      : automations.length === 0 ? <div className="sfa-card sfa-auto-empty" data-testid="empty-automations">
        <EmptyState icon={<Workflow size={22} />} title="No automations yet"
          description={canStart ? 'There are three ways to create posts without writing each one in the composer.' : 'Nothing has been set up in this workspace yet. An editor, admin or owner can create automations.'}
          action={canStart ? <div className="sfa-auto-options">
            <div className="sfa-auto-option">
              <KindMark kind="wordpress" />
              <strong>WordPress auto-share</strong>
              <p>Posts every new article from your WordPress site.{wordpressCadence ? ` Checked ${wordpressCadence}.` : ''}</p>
              <Button variant="secondary" size="sm" icon={<Plus size={14} />} disabled={!canManage} title={canManage ? undefined : "Your role can't create automations"} onClick={(event) => onCreate('wordpress', event.currentTarget)} data-testid="button-empty-wordpress">Add your site</Button>
            </div>
            <div className="sfa-auto-option">
              <KindMark kind="rss" />
              <strong>RSS feed</strong>
              <p>Posts every new item from any RSS or Atom feed.{rssCadence ? ` Checked ${rssCadence}.` : ''}</p>
              <Button variant="secondary" size="sm" icon={<Plus size={14} />} disabled={!canManage} title={canManage ? undefined : "Your role can't create automations"} onClick={(event) => onCreate('rss', event.currentTarget)} data-testid="button-empty-rss">Add a feed</Button>
            </div>
            <div className="sfa-auto-option">
              <span className="sfa-auto-mark sfa-auto-mark--csv" style={{ height: 36, width: 36 }} aria-hidden="true"><FileSpreadsheet size={18} /></span>
              <strong>CSV bulk import</strong>
              <p>Creates up to {MAX_CSV_ROWS} posts in one go from a spreadsheet you upload.</p>
              <Button variant="secondary" size="sm" icon={<UploadCloud size={14} />} disabled={!canImport} title={canImport ? undefined : "Your role can't import posts"} onClick={onImport} data-testid="button-empty-csv">Import a file</Button>
            </div>
          </div> : undefined} />
      </div>
      : <>
        <ul className="sfa-auto-list" aria-label="Automations" data-testid="list-automations">
          {ordered.map((automation) => <AutomationCard key={automation.id} automation={automation} canManage={canManage} now={now}
            onEdit={(opener) => onEdit(automation, opener)} onHistory={(opener) => onHistory(automation, opener)} />)}
        </ul>
        {limit !== null && <p className="sfa-auto-muted sfa-num" data-testid="text-auto-limit">{atLimit
          ? `This workspace has all ${limit} automations it can hold. Delete one to add another.`
          : `${automations.length} of ${limit} automations used.`}</p>}
      </>}
  </div>;
}

/* ---------- CSV bulk import ---------- */

const FALLBACK_ZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
];

function browserZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Every IANA zone the browser knows, or a short list on older engines. Always includes UTC and `current`. */
function timeZones(current: string): string[] {
  let zones: string[] = FALLBACK_ZONES;
  try {
    if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone');
  } catch { /* keep the fallback list */ }
  const withUtc = zones.includes('UTC') ? zones : ['UTC', ...zones];
  return current && !withUtc.includes(current) ? [current, ...withUtc] : withUtc;
}

function downloadTemplate() {
  // The header row only: example rows would be something to delete before every import.
  const href = URL.createObjectURL(new Blob([CSV_HEADER], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = href;
  link.download = 'socialflow-import-template.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function RowErrors({ id, errors }: { id?: string; errors: BulkImportRowError[] }) {
  return <ul id={id} className="sfa-auto-rowerrors" aria-label="Rows that weren't imported">
    {errors.map((error, index) => <li key={`${error.row}-${index}`}><span className="sfa-num">Row {error.row}</span><span>{error.message}</span></li>)}
  </ul>;
}

function RecentImports() {
  const list = useListBulkImports({ query: { queryKey: getListBulkImportsQueryKey(), retry: retryTransient } });
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const imports: BulkImportRecord[] = list.data?.imports ?? [];
  const toggle = (id: string) => setOpen((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  return <section className="sfa-card sfa-auto-recent" aria-labelledby="sfa-auto-recent-title" data-testid="section-csv-recent">
    <div className="sfa-card__head"><h2 id="sfa-auto-recent-title"><History size={16} /> Recent imports</h2></div>
    {list.isError && !list.data ? <ErrorState title="Couldn't load recent imports" description={errInfo(list.error).message} onRetry={() => { void list.refetch(); }} />
      : list.isLoading ? <ul className="sfa-auto-imports" aria-busy="true" aria-label="Loading recent imports">{[0, 1].map((i) => <li key={i}><div className="sfa-auto-import"><span className="sfa-auto-import__main"><Skeleton width={`${50 - i * 12}%`} /><Skeleton width={180} /></span><Skeleton width={84} height={22} radius={999} /></div></li>)}</ul>
      : imports.length === 0 ? <p className="sfa-auto-muted sfa-auto-recent__empty" data-testid="text-csv-no-imports">No imports yet. Each import is listed here with what it created and any rows that failed.</p>
      : <ul className="sfa-auto-imports" aria-label="Recent imports, newest first">
        {imports.map((record) => {
          const status = IMPORT_STATUS[record.status] ?? { label: record.status, tone: 'draft' };
          const errors = Array.isArray(record.errors) ? record.errors : [];
          const expanded = open.has(record.id);
          const panelId = `sfa-auto-import-errors-${record.id}`;
          return <li key={record.id} data-testid={`row-csv-import-${record.id}`}>
            <div className="sfa-auto-import">
              <span className="sfa-auto-import__main">
                <strong title={record.fileName}>{record.fileName}</strong>
                <span><time dateTime={record.createdAt} title={exact(record.createdAt)}>{ago(record.createdAt)}</time> · {IMPORT_MODE_WORDS[record.mode] ?? record.mode} · {plural(record.totalRows, 'row')}</span>
              </span>
              <span className="sfa-auto-import__counts sfa-num">{record.createdCount.toLocaleString()} created · {record.failedCount.toLocaleString()} failed</span>
              <span className={`sfa-pill sfa-pill--${status.tone}`}>{status.label}</span>
              {errors.length > 0 && <Button size="sm" variant="ghost" icon={expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />} aria-expanded={expanded} aria-controls={panelId}
                onClick={() => toggle(record.id)} data-testid={`button-csv-import-errors-${record.id}`}>Row errors</Button>}
            </div>
            {expanded && <RowErrors id={panelId} errors={errors} />}
          </li>;
        })}
      </ul>}
  </section>;
}

type CsvFile = { id: number; name: string; size: number; text: string; garbled: boolean };
type PreviewState = { data: BulkImportPreview | null; key: string | null; mode: BulkImportMode; timezone: string; loading: boolean; error: string | null };
type ImportOutcome = { result: BulkImportResult; mode: BulkImportMode; fileName: string };

const NO_PREVIEW: PreviewState = { data: null, key: null, mode: 'schedule', timezone: 'UTC', loading: false, error: null };

function ImportPanel({ hidden, canImport, canSeeImports, accounts, accountsLoading, accountsFailed, onRetryAccounts, approvalRequired }: {
  hidden: boolean; canImport: boolean; canSeeImports: boolean; accounts: ConnectedAccount[]; accountsLoading: boolean; accountsFailed: boolean; onRetryAccounts: () => void; approvalRequired: boolean;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const go = useGo();
  const uid = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const outcomeRef = useRef<HTMLElement>(null);
  const dragDepth = useRef(0);
  const fileTicket = useRef(0);
  const previewTicket = useRef(0);
  const previewedFile = useRef<number | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<CsvFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [mode, setMode] = useState<BulkImportMode>('schedule');
  const [timezone, setTimezone] = useState(browserZone);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [preview, setPreview] = useState<PreviewState>(NO_PREVIEW);
  const [retry, setRetry] = useState(0);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const previewer = usePreviewBulkImport();
  const runPreview = useRef(previewer.mutateAsync);
  runPreview.current = previewer.mutateAsync;
  const retried = useRef(0);
  const importer = useCreateBulkImport();
  const importing = importer.isPending;

  const zones = useMemo(() => timeZones(timezone), [timezone]);
  const byId = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  // Only accounts that still exist are sent: the server refuses a default account it doesn't know.
  const defaultIds = useMemo(() => accountIds.filter((id) => byId.has(id)), [accountIds, byId]);
  const fileId = file?.id ?? null;
  const requestKey = file ? `${file.id}|${mode}|${timezone}|${[...defaultIds].sort().join(',')}` : null;
  const request = useRef<BulkImportInput | null>(null);
  request.current = file ? { csv: file.text, fileName: file.name, timezone, defaultAccountIds: defaultIds, mode } : null;

  // Preview: straight away for a new file, shortly after the last change when an option changes.
  useEffect(() => {
    const ticket = ++previewTicket.current;
    if (requestKey === null || fileId === null || !canImport) { previewedFile.current = null; setPreview(NO_PREVIEW); return; }
    const isNewFile = previewedFile.current !== fileId;
    const immediate = isNewFile || retried.current !== retry;
    previewedFile.current = fileId;
    retried.current = retry;
    setPreview((current) => (isNewFile ? { ...NO_PREVIEW, loading: true } : { ...current, loading: true, error: null }));
    const handle = window.setTimeout(() => {
      const input = request.current;
      if (!input) return;
      runPreview.current({ data: input }).then(
        (data) => { if (alive.current && previewTicket.current === ticket) setPreview({ data, key: requestKey, mode: input.mode, timezone: input.timezone ?? 'UTC', loading: false, error: null }); },
        (error: unknown) => {
          if (!alive.current || previewTicket.current !== ticket) return;
          const { status } = errInfo(error);
          setPreview({ ...NO_PREVIEW, error: explain(error, status === 413 ? 'The file is too large to check. A CSV can be up to 1 MB.' : "The file couldn't be checked. Try again.") });
        },
      );
    }, immediate ? 0 : 500);
    return () => window.clearTimeout(handle);
  }, [requestKey, fileId, canImport, retry]);

  useEffect(() => { if (outcome) outcomeRef.current?.focus(); }, [outcome]);

  const takeFile = (picked: File | undefined) => {
    if (!picked || importing) return;
    setFileError(null);
    const name = picked.name || 'This file';
    if (!/\.csv$/i.test(name) && picked.type !== 'text/csv') {
      setFileError(`“${name}” isn't a CSV file. In your spreadsheet, choose Save as or Download, pick CSV (comma separated), and choose that file here.`);
      return;
    }
    if (picked.size > MAX_CSV_BYTES) {
      setFileError(`“${name}” is ${formatSize(picked.size)}. A CSV can be up to 1 MB, so split it into smaller files.`);
      return;
    }
    if (picked.size === 0) { setFileError(`“${name}” is empty.`); return; }
    const ticket = ++fileTicket.current;
    const reader = new FileReader();
    setReading(true);
    reader.onload = () => {
      if (!alive.current || fileTicket.current !== ticket) return;
      setReading(false);
      const text = typeof reader.result === 'string' ? reader.result : '';
      if (text.trim() === '') { setFileError(`“${name}” has nothing in it.`); return; }
      setOutcome(null);
      setImportError(null);
      setExpanded(new Set());
      setOnlyProblems(false);
      // U+FFFD appears when the bytes weren't UTF-8 (for example a spreadsheet saved in an older encoding).
      setFile({ id: ticket, name, size: picked.size, text, garbled: text.includes('�') });
    };
    reader.onerror = () => {
      if (!alive.current || fileTicket.current !== ticket) return;
      setReading(false);
      setFileError(`“${name}” couldn't be read. Choose it again.`);
    };
    reader.readAsText(picked);
  };
  const clearFile = () => { fileTicket.current += 1; setReading(false); setFile(null); setFileError(null); setImportError(null); };

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const onDragEnter = (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); dragDepth.current += 1; setDragOver(true); };
  const onDragOver = (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; };
  const onDragLeave = (event: DragEvent) => { if (!hasFiles(event)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragOver(false); };
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    takeFile(event.dataTransfer.files[0]);
  };

  const data = preview.data;
  const fresh = data !== null && !preview.loading && preview.key === requestKey;
  const filtering = onlyProblems && data !== null && data.errorCount > 0;
  const rows = data ? (filtering ? data.rows.filter((row) => row.errors.length > 0) : data.rows) : [];
  const whenFormat = useMemo(() => {
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: preview.timezone }); }
    catch { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  }, [preview.timezone]);
  const whenText = (scheduledAt: string | null): string => {
    if (preview.mode === 'queue') return 'Next free queue time';
    if (preview.mode === 'draft') return 'Saved as a draft';
    const date = toDate(scheduledAt);
    return date ? whenFormat.format(date) : '—';
  };
  const toggleRow = (row: number) => setExpanded((current) => { const next = new Set(current); if (next.has(row)) next.delete(row); else next.add(row); return next; });

  const runImport = async () => {
    const input = request.current;
    if (!input || !data || !fresh || data.validCount === 0 || importing) return;
    const posts = plural(data.validCount, 'post');
    if (data.errorCount > 0 && !(await confirm({ title: `Import ${posts}?`, description: `${plural(data.errorCount, 'row')} with problems will be skipped.`, confirmLabel: `Import ${posts}` }))) return;
    setImportError(null);
    importer.mutate({ data: input }, {
      onSuccess: (result) => {
        void queryClient.invalidateQueries({ queryKey: getListBulkImportsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: [getListPostsQueryKey()[0]] });
        // Queued posts take slots, so every queue view is out of date too.
        if (input.mode === 'queue') void queryClient.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith('/api/queues') });
        setOutcome({ result, mode: input.mode, fileName: input.fileName ?? 'the file' });
        // Posts were created: drop the file so the same rows can't be imported twice by accident.
        if (result.created > 0) { fileTicket.current += 1; setFile(null); }
      },
      onError: (error) => {
        void queryClient.invalidateQueries({ queryKey: getListBulkImportsQueryKey() });
        const { status } = errInfo(error);
        setImportError(explain(error, status === 413 ? 'The file is too large to import. A CSV can be up to 1 MB.' : "The import couldn't be completed. Nothing more was created. Try again."));
      },
    });
  };

  const importLabel = fresh && data ? `Import ${plural(data.validCount, 'post')}` : 'Import posts';
  const importStatus = importing ? 'Importing… Rows with pictures take a little longer.'
    : preview.loading ? 'Checking the file…'
    : !fresh || !data ? ''
    : data.validCount === 0 ? 'No rows can be imported. Fix the problems in the file and choose it again.'
    : data.errorCount > 0 ? `${plural(data.errorCount, 'row')} with problems will be skipped.`
    : 'Every row is ready.';

  const outcomeTitle = outcome === null ? '' : outcome.result.created === 0 ? 'Nothing was imported'
    : outcome.result.failed > 0 ? `${plural(outcome.result.created, 'post')} imported, ${plural(outcome.result.failed, 'row')} failed`
    : `${plural(outcome.result.created, 'post')} imported`;
  const outcomeWords = outcome === null || outcome.result.created === 0 ? '' : outcome.mode === 'schedule' ? 'They are scheduled at the times in the file.'
    : outcome.mode === 'queue' ? "They took the next free times in their accounts' queues." : 'They were saved as drafts. Nothing is sent until you schedule them.';

  return <div role="tabpanel" id="sfa-auto-panel-import" aria-labelledby="sfa-auto-tab-import" className="sfa-auto-panel" hidden={hidden}>
    {!canImport && <p className="sfa-auto-note" role="note" data-testid="text-csv-readonly"><Info size={15} aria-hidden="true" /> <span>Your role can't import posts. An editor, admin or owner can.</span></p>}

    <div aria-live="polite">
      {outcome && <section ref={outcomeRef} tabIndex={-1} className={`sfa-auto-result is-${outcome.result.status}`} aria-labelledby={`${uid}-result`} data-testid="csv-result">
        <div className="sfa-auto-result__head">
          {outcome.result.status === 'completed' ? <CircleCheck size={18} aria-hidden="true" /> : <TriangleAlert size={18} aria-hidden="true" />}
          <h2 id={`${uid}-result`}>{outcomeTitle}</h2>
          <IconButton label="Dismiss" onClick={() => setOutcome(null)} data-testid="button-csv-result-dismiss"><X size={15} /></IconButton>
        </div>
        <p className="sfa-auto-result__counts sfa-num">
          <span><strong data-testid="csv-result-created">{outcome.result.created.toLocaleString()}</strong> created</span>
          <span><strong data-testid="csv-result-failed">{outcome.result.failed.toLocaleString()}</strong> failed</span>
          <span><strong>{outcome.result.totalRows.toLocaleString()}</strong> {outcome.result.totalRows === 1 ? 'row' : 'rows'} in {outcome.fileName}</span>
        </p>
        {outcomeWords && <p className="sfa-auto-result__words">{outcomeWords}</p>}
        {outcome.result.errors.length > 0 && <RowErrors errors={outcome.result.errors} />}
        {outcome.result.created > 0 && <div className="sfa-auto-result__actions">
          {outcome.mode === 'draft' && <a className="sfa-btn sfa-btn--primary sfa-btn--sm" href="/drafts" onClick={go('/drafts')} data-testid="button-csv-open-drafts">Open Drafts</a>}
          <a className={`sfa-btn sfa-btn--${outcome.mode === 'draft' ? 'secondary' : 'primary'} sfa-btn--sm`} href="/posts" onClick={go('/posts')} data-testid="button-csv-open-posts">Open Manage Posts</a>
          <a className="sfa-btn sfa-btn--secondary sfa-btn--sm" href="/calendar" onClick={go('/calendar')} data-testid="button-csv-open-calendar">Open Calendar</a>
        </div>}
      </section>}
    </div>

    {canImport && <>
      <section className="sfa-card sfa-auto-step" aria-labelledby={`${uid}-step1`}>
        <div className="sfa-auto-step__head">
          <span className="sfa-auto-step__num" aria-hidden="true">1</span>
          <div className="sfa-auto-step__title"><h2 id={`${uid}-step1`}>Choose a file</h2><p>A CSV file with a header row, up to {MAX_CSV_ROWS} posts and 1 MB.</p></div>
          <Button variant="secondary" size="sm" icon={<Download size={14} />} onClick={downloadTemplate} data-testid="button-csv-template">Download template</Button>
        </div>
        <div className="sfa-auto-step__body sfa-auto-filegrid">
          <div className="sfa-auto-filecol">
            <div className={`sfa-auto-drop ${dragOver ? 'is-over' : ''} ${file ? 'has-file' : ''}`} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} data-testid="csv-dropzone">
              <span className="sfa-auto-drop__icon" aria-hidden="true">{dragOver ? <UploadCloud size={22} /> : <FileSpreadsheet size={22} />}</span>
              <div className="sfa-auto-drop__text">
                {file
                  ? <><strong title={file.name} data-testid="text-csv-file-name">{file.name}</strong><span>{formatSize(file.size)} · nothing is created until you press Import</span></>
                  : <><strong>{dragOver ? 'Drop the file to read it' : reading ? 'Reading the file…' : 'Drag and drop a .csv file here'}</strong><span>or browse for one. Every row is checked before anything is created.</span></>}
              </div>
              <div className="sfa-auto-drop__actions">
                <Button variant={file ? 'secondary' : 'primary'} size="sm" loading={reading} disabled={importing} onClick={() => fileInputRef.current?.click()} data-testid="button-csv-browse">{file ? 'Choose another file' : 'Browse files'}</Button>
                {file && <Button variant="ghost" size="sm" icon={<X size={13} />} disabled={importing} onClick={clearFile} data-testid="button-csv-remove">Remove</Button>}
              </div>
              <input ref={fileInputRef} type="file" accept=".csv,text/csv" hidden aria-label="Choose a CSV file" data-testid="input-csv-file"
                onChange={(event) => { takeFile(event.target.files?.[0]); event.target.value = ''; }} />
            </div>
            {fileError && <div className="sfa-alert" role="alert" data-testid="status-csv-file-error"><CircleAlert size={15} aria-hidden="true" /> <span>{fileError}</span></div>}
            {file?.garbled && <p className="sfa-auto-note sfa-auto-note--warn" role="note"><TriangleAlert size={15} aria-hidden="true" /> <span>Some characters in this file aren't UTF-8 text, so accents or emoji may be wrong. Save it as “CSV UTF-8” and choose it again.</span></p>}
          </div>
          <div className="sfa-auto-columns" aria-labelledby={`${uid}-columns`}>
            <h3 id={`${uid}-columns`}>Columns</h3>
            <ul>
              {CSV_COLUMNS.map((column) => <li key={column.name}>
                <code>{column.name}</code>
                <em className={column.need === 'Optional' ? undefined : 'is-required'}>{column.need}</em>
                <span>{column.text}</span>
              </li>)}
            </ul>
            <p className="sfa-auto-muted">Column names can be in any order. Put a value in quotes when it contains a comma or a line break. YouTube accounts can't be used, because YouTube posts need a video.</p>
          </div>
        </div>
      </section>

      <section className="sfa-card sfa-auto-step" aria-labelledby={`${uid}-step2`}>
        <div className="sfa-auto-step__head">
          <span className="sfa-auto-step__num" aria-hidden="true">2</span>
          <div className="sfa-auto-step__title"><h2 id={`${uid}-step2`}>Options</h2><p>They apply to the whole file. The preview is checked again when you change one.</p></div>
        </div>
        <div className="sfa-auto-step__body">
          <fieldset className="sfa-auto-fieldset">
            <legend className="sfa-label">What to do with the posts</legend>
            <RadioCards name={`${uid}-mode`} value={mode} options={IMPORT_MODES} onChange={(next) => setMode(next)} disabled={importing} testidPrefix="radio-csv-mode" />
            {approvalRequired && mode !== 'draft' && <ApprovalNote posts="Imported posts" testid="text-csv-approval" />}
          </fieldset>
          <fieldset className="sfa-auto-fieldset">
            <legend className="sfa-label">Default accounts {defaultIds.length > 0 && <span className="sfa-count sfa-num">{defaultIds.length}</span>}</legend>
            <p className="sfa-auto-muted">Used for rows that leave the accounts column empty.</p>
            <AccountPicker name="csv-account" accounts={accounts} loading={accountsLoading} failed={accountsFailed} onRetry={onRetryAccounts} selected={defaultIds} onChange={setAccountIds} disabled={importing} />
          </fieldset>
          <div className="sfa-field sfa-auto-tz">
            <label htmlFor={`${uid}-tz`}>Time zone</label>
            <select id={`${uid}-tz`} className="sfa-select" value={timezone} disabled={importing} aria-describedby={`${uid}-tz-help`} onChange={(event) => setTimezone(event.target.value)} data-testid="select-csv-timezone">
              {zones.map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>)}
            </select>
            <span id={`${uid}-tz-help`} className="sfa-field__hint">Used to read scheduled_at values written as YYYY-MM-DD HH:mm. ISO dates with Z or an offset are taken as written.</span>
          </div>
        </div>
      </section>

      <section className="sfa-card sfa-auto-step" aria-labelledby={`${uid}-step3`}>
        <div className="sfa-auto-step__head">
          <span className="sfa-auto-step__num" aria-hidden="true">3</span>
          <div className="sfa-auto-step__title"><h2 id={`${uid}-step3`}>Preview</h2><p>{file ? 'Every row as the server read it. Nothing has been created yet.' : 'Every row is checked here before anything is created.'}</p></div>
        </div>
        <div className="sfa-auto-step__body">
          {!file ? <p className="sfa-auto-muted" data-testid="text-csv-no-file">Choose a file in step 1 to see its rows.</p>
            : preview.error ? <div className="sfa-alert sfa-auto-alertrow" role="alert" data-testid="status-csv-preview-error">
              <CircleAlert size={15} aria-hidden="true" /> <span>{preview.error}</span>
              <Button size="sm" variant="secondary" onClick={() => setRetry((value) => value + 1)} data-testid="button-csv-preview-retry">Try again</Button>
            </div>
            : !data ? <div className="sfa-auto-previewskel" aria-busy="true"><span className="sr-only">Checking the file</span><Skeleton width={260} height={24} radius={999} /><Skeleton height={44} radius={8} /><Skeleton height={44} radius={8} /><Skeleton height={44} radius={8} /></div>
            : <div className="sfa-auto-preview" data-testid="csv-preview">
              <div className="sfa-auto-previewbar">
                <ul className="sfa-auto-counts" aria-label="Preview summary">
                  <li className="is-ok"><strong className="sfa-num" data-testid="csv-count-ready">{data.validCount.toLocaleString()}</strong> ready</li>
                  <li className={data.errorCount > 0 ? 'is-bad' : undefined}><strong className="sfa-num" data-testid="csv-count-problems">{data.errorCount.toLocaleString()}</strong> with problems</li>
                  <li><strong className="sfa-num" data-testid="csv-count-total">{data.totalRows.toLocaleString()}</strong> total</li>
                </ul>
                <div className="sfa-auto-filter">
                  <span id={`${uid}-filter`} onClick={() => { if (data.errorCount > 0) setOnlyProblems((value) => !value); }}>Only show rows with problems</span>
                  <button type="button" role="switch" aria-checked={filtering} aria-labelledby={`${uid}-filter`} className="sfa-auto-switch" disabled={data.errorCount === 0}
                    onClick={() => setOnlyProblems((value) => !value)} data-testid="toggle-csv-problems"><span /></button>
                </div>
              </div>
              {data.warnings.length > 0 && <ul className="sfa-auto-filewarnings" aria-label="About the file">{data.warnings.map((warning, index) => <li key={index}><TriangleAlert size={13} aria-hidden="true" /> <span>{warning}</span></li>)}</ul>}
              <div className={`sfa-auto-tablewrap ${fresh ? '' : 'is-stale'}`} tabIndex={0} role="region" aria-label="Rows in the file" aria-busy={!fresh}>
                <table className="sfa-auto-table">
                  <caption className="sr-only">Each row of the file and whether it can be imported</caption>
                  {/* Five columns so the status is in view on a laptop; a row's link, picture and problems sit with its text. */}
                  <thead><tr>
                    <th scope="col" className="sfa-auto-col-row">Row</th><th scope="col">Content</th><th scope="col" className="sfa-auto-col-when">When</th><th scope="col" className="sfa-auto-col-accounts">Accounts</th><th scope="col" className="sfa-auto-col-status">Status</th>
                  </tr></thead>
                  <tbody>
                    {rows.map((row) => {
                      const bad = row.errors.length > 0;
                      const open = expanded.has(row.row);
                      const long = row.content.length > 110 || row.content.includes('\n');
                      const link = safeHref(row.link);
                      const image = safeHref(row.imageUrl);
                      return <tr key={row.row} className={bad ? 'is-bad' : undefined} data-testid={`csv-row-${row.row}`}>
                        <td className="sfa-num">{row.row}</td>
                        <td className="sfa-auto-cell-content">
                          {row.content ? <p className={`sfa-auto-content ${open ? 'is-open' : ''}`} title={long && !open ? row.content : undefined}>{row.content}</p> : <span className="sfa-auto-dim">Empty</span>}
                          {long && <button type="button" className="sfa-linkbtn" aria-expanded={open} onClick={() => toggleRow(row.row)}>{open ? 'Show less' : 'Show all'}</button>}
                          {(row.link || row.imageUrl || row.firstComment || row.tags.length > 0) && <span className="sfa-auto-rowtags">
                            {row.link && (link
                              ? <a className="sfa-auto-chip sfa-auto-chip--link" href={link} target="_blank" rel="noopener noreferrer" title={link}><Link2 size={11} aria-hidden="true" /><span>{hostOf(link)}</span><span className="sr-only"> (link, opens in a new tab)</span></a>
                              : <span className="sfa-auto-chip" title={row.link}><Link2 size={11} aria-hidden="true" /><span>{row.link}</span></span>)}
                            {row.imageUrl && (image
                              ? <a className="sfa-auto-chip sfa-auto-chip--link" href={image} target="_blank" rel="noopener noreferrer" title={image}><ImageIcon size={11} aria-hidden="true" /><span>Picture</span><span className="sr-only"> (opens in a new tab)</span></a>
                              : <span className="sfa-auto-chip" title={row.imageUrl}><ImageIcon size={11} aria-hidden="true" /><span>{row.imageUrl}</span></span>)}
                            {row.firstComment && <span className="sfa-auto-chip" title={row.firstComment}><MessageSquare size={11} aria-hidden="true" /><span>First comment</span></span>}
                            {row.tags.map((tag) => <span key={tag} className="sfa-auto-chip"><span>{tag}</span></span>)}
                          </span>}
                          {bad && <ul className="sfa-auto-problems" aria-label="Problems">{row.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>}
                          {row.warnings.length > 0 && <ul className="sfa-auto-warnings" aria-label="Notes">{row.warnings.map((message, index) => <li key={index}>{message}</li>)}</ul>}
                        </td>
                        <td className="sfa-auto-nowrap sfa-num">{whenText(row.scheduledAt)}</td>
                        <td>
                          {row.accountIds.length === 0 ? <span className="sfa-auto-dim">—</span> : <span className="sfa-auto-accts">
                            {row.accountIds.map((id, index) => {
                              const account = byId.get(id);
                              return <span key={id} className="sfa-auto-acct">{account ? <PlatformBadge platform={account.platform} size={14} /> : <span className="sfa-auto-acct__dot" aria-hidden="true" />}<span>{account?.displayName ?? row.accountNames[index] ?? 'Account'}</span></span>;
                            })}
                          </span>}
                        </td>
                        <td className="sfa-auto-cell-status">
                          {bad
                            ? <span className="sfa-auto-bad"><CircleAlert size={14} aria-hidden="true" /> {row.errors.length === 1 ? 'Problem' : `${row.errors.length} problems`}</span>
                            : <span className="sfa-auto-ready"><CircleCheck size={14} aria-hidden="true" /> Ready</span>}
                        </td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            </div>}

          {file && <div className="sfa-auto-importbar">
            <p className="sfa-auto-muted" role="status" data-testid="text-csv-import-status">{importStatus}</p>
            <Button variant="primary" icon={<UploadCloud size={15} />} loading={importing} disabled={!fresh || !data || data.validCount === 0} onClick={() => { void runImport(); }} data-testid="button-csv-import">{importing ? 'Importing…' : importLabel}</Button>
          </div>}
          {importError && <div className="sfa-alert" role="alert" data-testid="status-csv-import-error"><CircleAlert size={15} aria-hidden="true" /> <span>{importError}</span></div>}
        </div>
      </section>
    </>}

    {canSeeImports && <RecentImports />}
  </div>;
}

/* ---------- Page ---------- */

type PageTab = 'automations' | 'import';

const PAGE_TABS: Array<{ id: PageTab; label: string; Icon: LucideIcon }> = [
  { id: 'automations', label: 'Automations', Icon: Workflow },
  { id: 'import', label: 'Bulk import (CSV)', Icon: FileSpreadsheet },
];

/** The chosen tab lives in the address (?tab=import), so a reload or a shared link opens the same tab. */
function usePageTab(): [PageTab, (next: PageTab) => void] {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const raw = search || (typeof window !== 'undefined' ? window.location.search : '');
  const tab: PageTab = new URLSearchParams(raw.startsWith('?') ? raw : `?${raw}`).get('tab') === 'import' ? 'import' : 'automations';
  const select = useCallback((next: PageTab) => { navigate(next === 'import' ? `${location}?tab=import` : location, { replace: true }); }, [location, navigate]);
  return [tab, select];
}

function NewMenu({ buttonRef, canManage, canImport, atLimit, limit, onCreate, onImport }: {
  buttonRef: RefObject<HTMLButtonElement | null>; canManage: boolean; canImport: boolean; atLimit: boolean; limit: number | null; onCreate: (kind: AutomationKind) => void; onImport: () => void;
}) {
  // A dialog takes the focus when it opens; the closing menu must not pull it back to the button.
  const openingDialog = useRef(false);
  const choose = (kind: AutomationKind) => { openingDialog.current = true; onCreate(kind); };
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild>
      <button ref={buttonRef} type="button" className="sfa-btn sfa-btn--primary sfa-btn--md" data-testid="button-new-automation"><Plus size={16} aria-hidden="true" /> New automation <ChevronDown size={14} aria-hidden="true" /></button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="sfa-auto-menu w-80 rounded-xl p-1.5" onCloseAutoFocus={(event) => { if (openingDialog.current) { openingDialog.current = false; event.preventDefault(); } }}>
      <DropdownMenuItem className="sfa-auto-menuitem rounded-md" disabled={!canManage || atLimit} onSelect={() => choose('wordpress')} data-testid="menu-new-wordpress">
        <KindMark kind="wordpress" size={30} />
        <span className="sfa-auto-menuitem__text"><strong>WordPress auto-share</strong><small>New articles from your WordPress site</small></span>
      </DropdownMenuItem>
      <DropdownMenuItem className="sfa-auto-menuitem rounded-md" disabled={!canManage || atLimit} onSelect={() => choose('rss')} data-testid="menu-new-rss">
        <KindMark kind="rss" size={30} />
        <span className="sfa-auto-menuitem__text"><strong>RSS feed</strong><small>New items from any RSS or Atom feed</small></span>
      </DropdownMenuItem>
      <DropdownMenuItem className="sfa-auto-menuitem rounded-md" disabled={!canImport} onSelect={onImport} data-testid="menu-new-csv">
        <span className="sfa-auto-mark sfa-auto-mark--csv" style={{ height: 30, width: 30 }} aria-hidden="true"><FileSpreadsheet size={16} /></span>
        <span className="sfa-auto-menuitem__text"><strong>CSV bulk import</strong><small>Many posts at once from a spreadsheet</small></span>
      </DropdownMenuItem>
      {canManage && atLimit && limit !== null && <p className="sfa-menu-note">This workspace has all {limit} automations it can hold. Delete one to add another.</p>}
      {!canManage && <p className="sfa-menu-note">Your role can't create automations.</p>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function AutomationsPage() {
  const me = useAuthMe({ query: { queryKey: getAuthMeQueryKey(), retry: false } });
  const perms = me.data?.permissions ?? [];
  const canManage = perms.includes('automations:manage');
  const canImport = perms.includes('posts:write');
  const canSeeImports = canImport || perms.includes('posts:read');

  const [tab, selectTab] = usePageTab();
  // The import tab is only built once it has been opened, then kept so a chosen file survives switching tabs.
  const [importSeen, setImportSeen] = useState(tab === 'import');
  if (tab === 'import' && !importSeen) setImportSeen(true);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const list = useListAutomations({ query: { queryKey: getListAutomationsQueryKey(), refetchInterval: 30_000, retry: retryTransient } });
  const accountsQuery = useListConnectedAccounts({ query: { queryKey: getListConnectedAccountsQueryKey() } });
  // Only to explain what "requires approval" means here; when it can't be read the note is simply not shown.
  const approval = useGetApprovalSettings({ query: { queryKey: getGetApprovalSettingsQueryKey(), retry: false } });
  const approvalRequired = approval.data?.required === true;
  const automations = list.data?.automations ?? [];
  const limit = list.data?.limit ?? null;
  const pollMinutes = list.data?.pollMinutes ?? null;
  const atLimit = limit !== null && automations.length >= limit;
  const accounts = accountsQuery.data?.accounts ?? [];
  const accountsFailed = accountsQuery.isError && !accountsQuery.data;

  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const historyFor = historyId === null ? null : automations.find((automation) => automation.id === historyId) ?? null;
  const newButtonRef = useRef<HTMLButtonElement>(null);
  // Dialogs opened without a Radix trigger don't know where the focus came from, so the page remembers it.
  const opener = useRef<HTMLElement | null>(null);
  const restoreFocus = useCallback((event: Event) => {
    const element = opener.current;
    opener.current = null;
    if (element && element.isConnected) { event.preventDefault(); element.focus(); }
  }, []);

  const openCreate = (kind: AutomationKind, from: HTMLElement | null) => { opener.current = from; selectTab('automations'); setDialog({ mode: 'create', kind }); };
  const openEdit = (automation: Automation, from: HTMLElement) => { opener.current = from; setDialog({ mode: 'edit', automation }); };
  const openHistory = (automation: Automation, from: HTMLElement) => { opener.current = from; setHistoryId(automation.id); };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'Home' ? -index : event.key === 'End' ? PAGE_TABS.length - 1 - index : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + PAGE_TABS.length) % PAGE_TABS.length;
    selectTab(PAGE_TABS[next]!.id);
    tabRefs.current[next]?.focus();
  };

  return <div className="sfa-page sfa-auto" data-testid="page-automations">
    <PageHeader title="Automations" description="Create posts without writing each one: share new articles from a WordPress site or an RSS feed as they appear, or import a batch of posts from a CSV file."
      actions={canManage || canImport
        ? <NewMenu buttonRef={newButtonRef} canManage={canManage} canImport={canImport} atLimit={atLimit} limit={limit} onCreate={(kind) => openCreate(kind, newButtonRef.current)} onImport={() => selectTab('import')} />
        : undefined} />

    <div className="sfa-seg sfa-auto-tabs" role="tablist" aria-label="Automations sections">
      {PAGE_TABS.map(({ id, label, Icon }, index) => <button key={id} type="button" role="tab" id={`sfa-auto-tab-${id}`} aria-selected={tab === id} aria-controls={id === 'import' && !importSeen ? undefined : `sfa-auto-panel-${id}`}
        tabIndex={tab === id ? 0 : -1} ref={(el) => { tabRefs.current[index] = el; }} className={tab === id ? 'is-on' : ''} onClick={() => selectTab(id)} onKeyDown={(event) => onTabKey(event, index)} data-testid={`tab-${id}`}>
        <Icon size={15} aria-hidden="true" /> {label}
        {id === 'automations' && list.data && automations.length > 0 && <span className="sfa-count sfa-num">{automations.length}</span>}
      </button>)}
    </div>

    <AutomationsPanel hidden={tab !== 'automations'} automations={automations} limit={limit} pollMinutes={pollMinutes} loading={list.isLoading} failed={list.isError && !list.data} failure={errInfo(list.error).message}
      refreshFailed={list.isError && Boolean(list.data)} onRetry={() => { void list.refetch(); }} canManage={canManage} canImport={canImport}
      onCreate={openCreate} onImport={() => selectTab('import')} onEdit={openEdit} onHistory={openHistory} />

    {importSeen && <ImportPanel hidden={tab !== 'import'} canImport={canImport} canSeeImports={canSeeImports} accounts={accounts} accountsLoading={accountsQuery.isLoading} accountsFailed={accountsFailed}
      onRetryAccounts={() => { void accountsQuery.refetch(); }} approvalRequired={approvalRequired} />}

    {dialog && <AutomationDialog key={dialog.mode === 'edit' ? dialog.automation.id : `new-${dialog.kind}`} target={dialog} accounts={accounts} accountsLoading={accountsQuery.isLoading} accountsFailed={accountsFailed}
      onRetryAccounts={() => { void accountsQuery.refetch(); }} pollMinutes={pollMinutes} approvalRequired={approvalRequired} onClose={() => setDialog(null)} onCloseAutoFocus={restoreFocus} />}
    {historyFor && <HistoryDrawer key={historyFor.id} automation={historyFor} onClose={() => setHistoryId(null)} onCloseAutoFocus={restoreFocus} />}
  </div>;
}

export default AutomationsPage;
