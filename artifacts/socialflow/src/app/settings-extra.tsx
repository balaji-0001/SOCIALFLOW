import { useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { Check, CircleAlert, KeyRound, Mail } from 'lucide-react';
import { getAuthMeQueryKey, getListConnectedAccountsQueryKey, useAuthMe, useListConnectedAccounts } from '@workspace/api-client-react';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import { PlatformBadge } from './platforms';
import { formatBytes, useMediaConfig } from './media-upload';
import { Button, Skeleton } from './ui';

/* Settings sections backed by real data: profile, publishing, security and help. */

function Section({ title, description, children, testid }: { title: string; description?: string; children: ReactNode; testid?: string }) {
  return <section className="sfa-set-section" data-testid={testid}>
    <div className="sfa-set-section__head"><h2>{title}</h2>{description && <p>{description}</p>}</div>
    <div className="sfa-set-section__body">{children}</div>
  </section>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="sfa-set-kv"><dt>{label}</dt><dd>{children}</dd></div>;
}

const THEME_OPTIONS: Array<{ id: ThemeChoice; label: string }> = [{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }, { id: 'system', label: 'Match my device' }];

function AppearanceSection() {
  const { choice, set } = useTheme();
  return <Section title="Appearance" description="Applies to the whole site on this browser." testid="settings-appearance">
    <div className="sfa-set-choices" role="radiogroup" aria-label="Colour theme">
      {THEME_OPTIONS.map((option) => <button key={option.id} type="button" role="radio" aria-checked={choice === option.id} className={choice === option.id ? 'is-on' : ''} onClick={() => set(option.id)} data-testid={`theme-${option.id}`}>{option.label}</button>)}
    </div>
  </Section>;
}

export function ProfileTab() {
  const me = useAuthMe({ query: { queryKey: getAuthMeQueryKey(), retry: false } });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (me.isLoading) return <div className="sfa-set-pad"><Skeleton height={120} radius={12} /></div>;
  const user = me.data?.user;
  return <div className="sfa-set-stack" data-testid="settings-profile">
    <Section title="Profile" description="Your sign-in details.">
      <dl className="sfa-set-dl">
        <Row label="Name">{user?.displayName ?? <span className="sfa-muted">Not set</span>}</Row>
        <Row label="Email">{user?.email}</Row>
        <Row label="Time zone">{timezone} <span className="sfa-muted">(this browser; schedules use it unless a queue or repeat has its own)</span></Row>
      </dl>
    </Section>
    <AppearanceSection />
    <Section title="Workspace" description="Everything you connect and publish lives in your workspace.">
      <dl className="sfa-set-dl">
        <Row label="Members">Manage members, roles and invitations on the <a href="/team">Team</a> page.</Row>
        <Row label="Access">Accounts, posts and files are private to this workspace.</Row>
      </dl>
    </Section>
  </div>;
}

const FIRST_COMMENT_LABEL = { supported: 'Ready', needs_permission: 'Needs a permission', unsupported: 'Not supported by the network' } as const;

export function PublishingTab() {
  const [, navigate] = useLocation();
  const config = useMediaConfig();
  const { data, isLoading } = useListConnectedAccounts({ query: { queryKey: getListConnectedAccountsQueryKey() } });
  const accounts = data?.accounts ?? [];
  return <div className="sfa-set-stack" data-testid="settings-publishing">
    <Section title="Posting times" description="When posts go out.">
      <div className="sfa-set-actions">
        <Button variant="secondary" onClick={() => navigate('/queue')}>Set queue times</Button>
        <Button variant="secondary" onClick={() => navigate('/recurring')}>Recurring posts</Button>
      </div>
      <p className="sfa-muted">Scheduled posts are sent automatically at their time while the server is running. A post more than an hour late is marked failed instead of being sent late.</p>
    </Section>
    <Section title="Media limits" description="Enforced by the server on every upload.">
      <dl className="sfa-set-dl">
        <Row label="Images">up to {formatBytes(config.maxImageBytes)}</Row>
        <Row label="Video">up to {formatBytes(config.maxVideoBytes)}</Row>
        <Row label="Files per post">{config.maxFilesPerPost}</Row>
        <Row label="Formats">JPG, PNG, GIF, WebP, MP4, MOV, WebM (each network accepts a subset, shown in the composer)</Row>
      </dl>
    </Section>
    <Section title="First comments" description="Whether each connected account can post a comment under its own post.">
      {isLoading ? <Skeleton height={80} radius={12} />
        : accounts.length === 0 ? <p className="sfa-muted">Connect an account to see what it supports.</p>
        : <ul className="sfa-set-accts">{accounts.map((account) => <li key={account.id}>
          <PlatformBadge platform={account.platform} size={16} /><span>{account.displayName}</span>
          <em className={`is-${account.firstComment}`}>{FIRST_COMMENT_LABEL[account.firstComment]}</em>
        </li>)}</ul>}
      <p className="sfa-muted">Commenting needs an extra permission on Facebook, Instagram and YouTube. The server operator enables it once (see docs/publishing-features.md), then each account is reconnected. On X the first comment is a reply under the post and needs nothing extra.</p>
    </Section>
  </div>;
}

export function SecurityTab() {
  const me = useAuthMe({ query: { queryKey: getAuthMeQueryKey(), retry: false } });
  const [state, setState] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!me.data) return;
    setBusy(true);
    setState(null);
    try {
      const response = await fetch('/api/auth/forgot-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: me.data.user.email }) });
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setState({ tone: response.ok ? 'ok' : 'error', text: body?.message ?? (response.ok ? 'Sent.' : 'Something went wrong. Please try again.') });
    } catch {
      setState({ tone: 'error', text: 'Could not reach the server. Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  };
  return <div className="sfa-set-stack" data-testid="settings-security">
    <Section title="Password" description="Change your password with a link sent to your email.">
      <div className="sfa-set-actions">
        <Button variant="secondary" icon={<Mail size={14} />} loading={busy} disabled={!me.data} onClick={send} data-testid="button-send-reset">Email me a reset link</Button>
      </div>
      {state && <p className={`sfa-set-result is-${state.tone}`} role="status" data-testid="status-reset-result">{state.tone === 'ok' ? <Check size={14} aria-hidden /> : <CircleAlert size={14} aria-hidden />} {state.text}</p>}
      <p className="sfa-muted">The link works once and expires in an hour. Using it signs you out everywhere.</p>
    </Section>
    <Section title="Connected accounts" description="Sign-in tokens for your social accounts are stored encrypted and are never shown in the app.">
      <p className="sfa-muted"><KeyRound size={13} aria-hidden /> Disconnect an account any time from Connected Accounts. Disconnecting removes the stored tokens.</p>
    </Section>
  </div>;
}

const SHORTCUTS: Array<[string, string]> = [
  ['/  or  Ctrl+K', 'Search posts, accounts, tags and pages'],
  ['Ctrl+Enter', 'Schedule the post you are writing'],
  ['Ctrl+S', 'Save the post as a draft'],
  ['Esc', 'Close a dialog, menu or the search'],
];

export function HelpTab() {
  return <div className="sfa-set-stack" data-testid="settings-help">
    <Section title="Keyboard shortcuts">
      <dl className="sfa-set-dl">{SHORTCUTS.map(([keys, action]) => <Row key={keys} label={keys}>{action}</Row>)}</dl>
    </Section>
    <Section title="Not available yet" description="Planned areas that are not connected. They show no data rather than made-up numbers.">
      <ul className="sfa-set-plain">
        <li>Notifications: there is no notification centre yet; publishing results are on Manage Posts.</li>
        <li>Content Library, Analytics, Inbox, Approvals, AI Studio and Team: see their pages for what each needs.</li>
        <li>Workspace branding, notification and AI preferences will appear here when those areas exist.</li>
      </ul>
    </Section>
  </div>;
}
