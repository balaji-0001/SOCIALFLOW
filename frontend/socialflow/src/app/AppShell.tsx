import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import {
  BarChart3, Bell, CalendarDays, ChevronDown, CircleHelp, FilePen, House, Images, LayoutDashboard, ListChecks, ListOrdered,
  LogOut, Network, PanelLeftClose, PanelLeftOpen, Plus, Repeat, Send, Settings, ShieldCheck, Sparkles, Users, Workflow,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { getAuthMeQueryKey, getListPostsQueryKey, useAuthLogout, useAuthMe, useListPosts, useListWorkspaces, useSwitchWorkspace } from '@workspace/api-client-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ComposerProvider, useComposer } from './composer';
import { ConfirmProvider } from './confirm';
import { GlobalSearch } from './search';
import { ThemeToggle } from './theme-toggle';
import { Button, Skeleton } from './ui';
import './app.css';
import './shell.css';

export type NavKey =
  | 'dashboard' | 'posts' | 'calendar' | 'drafts' | 'queue' | 'recurring' | 'automations' | 'accounts' | 'settings'
  | 'library' | 'analytics' | 'inbox' | 'approvals' | 'ai' | 'team';

const PAGE_TITLES: Record<NavKey, string> = {
  dashboard: 'Dashboard', calendar: 'Calendar', posts: 'Manage Posts', drafts: 'Drafts', queue: 'Queue', recurring: 'Recurring posts', automations: 'Automations', accounts: 'Connected Accounts', settings: 'Settings',
  library: 'Content Library', analytics: 'Analytics', inbox: 'Inbox', approvals: 'Approvals', ai: 'AI Studio', team: 'Team',
};

type NavItem = { key: NavKey; href: string; label: string; Icon: typeof Send; soon?: boolean; count?: 'scheduled' | 'drafts'; testid?: string };
type NavGroup = { label: string | null; items: NavItem[] };

/** Everything in the product, in the order it appears. Items marked `soon` open a page that says plainly what isn't built yet. */
const NAV: NavGroup[] = [
  { label: null, items: [
    { key: 'dashboard', href: '/dashboard', label: 'Dashboard', Icon: LayoutDashboard },
    { key: 'calendar', href: '/calendar', label: 'Calendar', Icon: CalendarDays },
  ] },
  { label: 'Publish', items: [
    { key: 'posts', href: '/posts', label: 'Manage Posts', Icon: ListChecks, count: 'scheduled' },
    { key: 'drafts', href: '/drafts', label: 'Drafts', Icon: FilePen, count: 'drafts' },
    { key: 'queue', href: '/queue', label: 'Queue', Icon: ListOrdered },
    { key: 'recurring', href: '/recurring', label: 'Recurring', Icon: Repeat },
    { key: 'automations', href: '/automations', label: 'Automations', Icon: Workflow },
    { key: 'library', href: '/library', label: 'Content Library', Icon: Images },
  ] },
  { label: 'Grow', items: [
    { key: 'analytics', href: '/analytics', label: 'Analytics', Icon: BarChart3 },
    { key: 'approvals', href: '/approvals', label: 'Approvals', Icon: ShieldCheck },
    { key: 'ai', href: '/ai', label: 'AI Studio', Icon: Sparkles },
  ] },
  { label: 'Workspace', items: [
    { key: 'accounts', href: '/workspace', label: 'Connected Accounts', Icon: Network },
    { key: 'team', href: '/team', label: 'Team', Icon: Users },
    { key: 'settings', href: '/settings', label: 'Settings', Icon: Settings },
  ] },
];

const COLLAPSE_KEY = 'socialflow:sidebar-collapsed';
const readCollapsed = () => { try { return window.localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };

function useNavigate() {
  const [, navigate] = useLocation();
  return (href: string) => (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(href);
  };
}

function Logo({ collapsed }: { collapsed?: boolean }) {
  return <span className="sfa-side__brand"><span className="sf-logo-mark"><Send size={14} strokeWidth={2.5} /></span>{!collapsed && <span>socialflow</span>}</span>;
}

/** Wraps a nav control in a tooltip only when the sidebar is collapsed and the label is hidden. */
function WithTip({ label, collapsed, children }: { label: string; collapsed: boolean; children: ReactNode }) {
  if (!collapsed) return <>{children}</>;
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent side="right" className="sfa-tip">{label}</TooltipContent></Tooltip>;
}

function Sidebar({ active, collapsed, onToggle, workspaceLabel, identity, email, onSignOut, signingOut }: {
  active: NavKey; collapsed: boolean; onToggle: () => void; workspaceLabel: string; identity: string; email: string; onSignOut: () => void; signingOut: boolean;
}) {
  const composer = useComposer();
  const go = useNavigate();
  const queryClient = useQueryClient();
  const me = useAuthMe({ query: { queryKey: getAuthMeQueryKey(), retry: false } });
  const canWrite = me.data?.permissions.includes('posts:write') ?? true;
  const workspaces = useListWorkspaces();
  const switchWorkspace = useSwitchWorkspace({ mutation: { onSuccess: () => { queryClient.clear(); window.location.assign('/dashboard'); } } });
  const { data } = useListPosts(undefined, { query: { queryKey: getListPostsQueryKey() } });
  const counts = {
    scheduled: (data?.posts ?? []).filter((post) => post.status === 'scheduled').length,
    drafts: (data?.posts ?? []).filter((post) => post.status === 'draft').length,
  };

  return <nav className={`sfa-side ${collapsed ? 'is-collapsed' : ''}`} aria-label="Main">
    <div className="sfa-side__head">
      <a href="/dashboard" className="sfa-side__logo" onClick={go('/dashboard')} aria-label="SocialFlow dashboard"><Logo collapsed={collapsed} /></a>
      <button type="button" className="sfa-side__toggle" onClick={onToggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed} data-testid="button-toggle-sidebar">
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>
    </div>

    {!collapsed && <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="sfa-ws" aria-label="Workspace" data-testid="button-workspace">
          <span className="sfa-ws__mark" aria-hidden>{workspaceLabel.slice(0, 1).toUpperCase()}</span>
          <span className="sfa-ws__text"><strong>{workspaceLabel}</strong><small>Workspace</small></span>
          <ChevronDown size={14} className="sfa-muted" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60 rounded-xl p-1.5">
        <DropdownMenuLabel className="sfa-menu-label">Workspaces</DropdownMenuLabel>
        {(workspaces.data?.workspaces ?? []).map((ws) => <DropdownMenuItem key={ws.id} disabled={ws.current || switchWorkspace.isPending} onSelect={() => { if (!ws.current) switchWorkspace.mutate({ workspaceId: ws.id }); }} className="gap-2 rounded-md" data-testid={`workspace-${ws.id}`}><span className="sfa-ws__mark sfa-ws__mark--sm" aria-hidden>{ws.name.slice(0, 1).toUpperCase()}</span><span className="truncate">{ws.name}</span><span className="sfa-menu-tag">{ws.current ? 'Current' : ws.role}</span></DropdownMenuItem>)}
        {workspaces.isError && <p className="sfa-menu-note">Couldn’t load your workspaces.</p>}
        <DropdownMenuSeparator />
        <p className="sfa-menu-note">You can belong to several workspaces. Invitations you accept appear here.</p>
      </DropdownMenuContent>
    </DropdownMenu>}

    <WithTip label="Create post" collapsed={collapsed}>
      <Button variant="primary" className="sfa-side__create" icon={<Plus size={16} />} onClick={() => composer.open()} disabled={!canWrite} title={canWrite ? undefined : 'Your role can\u2019t create posts'} aria-label="Create post" data-testid="button-create-post">{!collapsed && 'Create Post'}</Button>
    </WithTip>

    <div className="sfa-side__scroll">
      {NAV.map((group, index) => <div key={group.label ?? index} className="sfa-side__group">
        {group.label && (collapsed ? <div className="sfa-side__rule" aria-hidden /> : <div className="sfa-side__label">{group.label}</div>)}
        {group.items.map((item) => {
          const count = item.count ? counts[item.count] : 0;
          return <WithTip key={item.key} label={`${item.label}${item.soon ? ' (soon)' : ''}`} collapsed={collapsed}>
            <a href={item.href} className={`sfa-nav__item ${active === item.key ? 'is-active' : ''}`} aria-current={active === item.key ? 'page' : undefined} aria-label={collapsed ? item.label : undefined} onClick={go(item.href)} data-testid={item.testid ?? `nav-${item.key}`}>
              <item.Icon size={17} strokeWidth={1.9} />
              {!collapsed && <span>{item.label}</span>}
              {!collapsed && count > 0 && <em className="sfa-num">{count}</em>}
              {!collapsed && item.soon && <i className="sfa-soon">Soon</i>}
            </a>
          </WithTip>;
        })}
      </div>)}
    </div>

    <div className="sfa-side__foot">
      <WithTip label="Help" collapsed={collapsed}>
        <a href="/settings?tab=help" className="sfa-nav__item" aria-label={collapsed ? 'Help' : undefined} onClick={go('/settings?tab=help')} data-testid="nav-help"><CircleHelp size={17} strokeWidth={1.9} />{!collapsed && <span>Help</span>}</a>
      </WithTip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="sfa-me" aria-label="Your profile" data-testid="button-side-profile">
            <span className="sfa-usermenu__avatar" aria-hidden>{identity.slice(0, 2).toUpperCase()}</span>
            {!collapsed && <span className="sfa-me__text"><strong>{identity}</strong><small>{email}</small></span>}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="w-56 rounded-xl p-1.5">
          <div className="sfa-menu-head"><strong>{identity}</strong><span>{email}</span></div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={(event) => { event.preventDefault(); onSignOut(); }} disabled={signingOut} className="gap-2 rounded-md text-[hsl(var(--error))] focus:text-[hsl(var(--error))]"><LogOut size={15} /> {signingOut ? 'Signing out…' : 'Sign out'}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </nav>;
}

const BOTTOM_KEYS: Array<{ key: NavKey; href: string; label: string; Icon: typeof Send }> = [
  { key: 'dashboard', href: '/dashboard', label: 'Home', Icon: LayoutDashboard },
  { key: 'calendar', href: '/calendar', label: 'Calendar', Icon: CalendarDays },
];

function BottomNav({ active }: { active: NavKey }) {
  const composer = useComposer();
  const go = useNavigate();
  const [more, setMore] = useState(false);
  const link = (key: NavKey, href: string, label: string, Icon: typeof Send) => (
    <a key={key} href={href} className={active === key ? 'is-active' : ''} aria-current={active === key ? 'page' : undefined} onClick={go(href)}><Icon size={20} strokeWidth={1.9} />{label}</a>
  );
  const moreActive = !['dashboard', 'calendar', 'posts', 'drafts'].includes(active);
  return <>
    <nav className="sfa-bottomnav" aria-label="Main">
      {BOTTOM_KEYS.map(({ key, href, label, Icon }) => link(key, href, label, Icon))}
      <button className="sfa-bottomnav__create" onClick={() => composer.open()} aria-label="Create post" data-testid="button-mobile-create"><span><Plus size={20} /></span></button>
      {link('posts', '/posts', 'Posts', ListChecks)}
      <button type="button" className={moreActive || more ? 'is-active' : ''} onClick={() => setMore((open) => !open)} aria-expanded={more} aria-controls="sfa-more-sheet" data-testid="button-mobile-more"><Settings size={20} strokeWidth={1.9} />More</button>
    </nav>
    {more && <>
      <button className="sfa-sheet__scrim" aria-label="Close menu" onClick={() => setMore(false)} />
      <div className="sfa-sheet" id="sfa-more-sheet" role="dialog" aria-label="More">
        {NAV.flatMap((group) => group.items).filter((item) => !['dashboard', 'calendar', 'posts'].includes(item.key)).map((item) =>
          <a key={item.key} href={item.href} className={active === item.key ? 'is-active' : ''} onClick={(event) => { setMore(false); go(item.href)(event); }}><item.Icon size={18} strokeWidth={1.9} />{item.label}{item.soon && <i className="sfa-soon">Soon</i>}</a>)}
      </div>
    </>}
  </>;
}

function ShellSkeleton() {
  return <div className="sfa-app" aria-busy="true" aria-label="Loading">
    <div className="sfa-side">
      <Skeleton width={120} height={22} />
      <Skeleton height={40} radius={10} />
      {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={30} radius={8} />)}
    </div>
    <div className="sfa-main"><div className="sfa-top" /><div className="sfa-page"><Skeleton width={220} height={30} /><div style={{ height: 24 }} /><Skeleton height={320} radius={12} /></div></div>
  </div>;
}

function Shell({ active, children }: { active: NavKey; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [location, navigate] = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const me = useAuthMe({ query: { queryKey: getAuthMeQueryKey(), retry: false } });
  const logout = useAuthLogout({
    mutation: { onSuccess: () => { queryClient.clear(); navigate('/'); } },
  });

  useEffect(() => {
    if (me.isError) navigate(`/signin?next=${encodeURIComponent(location)}`);
  }, [me.isError, navigate, location]);

  useEffect(() => { document.title = `${PAGE_TITLES[active]} · SocialFlow`; }, [active]);
  const toggle = () => setCollapsed((value) => {
    try { window.localStorage.setItem(COLLAPSE_KEY, value ? '0' : '1'); } catch { /* the choice just isn't remembered */ }
    return !value;
  });

  if (me.isLoading) return <ShellSkeleton />;
  if (!me.data) return null;
  const identity = me.data.user.displayName ?? me.data.user.email;
  const workspaceLabel = me.data.user.displayName ? `${me.data.user.displayName.split(' ')[0]}’s workspace` : 'My workspace';

  return <div className={`sfa-app ${collapsed ? 'is-collapsed' : ''}`}>
    <Sidebar active={active} collapsed={collapsed} onToggle={toggle} workspaceLabel={workspaceLabel} identity={identity} email={me.data.user.email} onSignOut={() => logout.mutate(undefined)} signingOut={logout.isPending} />
    <div className="sfa-main">
      <header className="sfa-top">
        <a href="/dashboard" className="sfa-top__logo" onClick={(event) => { event.preventDefault(); navigate('/dashboard'); }} aria-label="SocialFlow dashboard"><Logo /></a>
        <div className="sfa-top__title"><span>{workspaceLabel} / </span><h1>{PAGE_TITLES[active]}</h1></div>
        <GlobalSearch />
        <ThemeToggle />
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="sfa-iconbtn sfa-top__bell" aria-label="Notifications" aria-disabled="true" data-testid="button-notifications"><Bell size={17} /></button>
          </TooltipTrigger>
          <TooltipContent className="sfa-tip">Notifications aren’t available yet. Publishing results show on Manage Posts.</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="sfa-usermenu" aria-label="Account menu" data-testid="button-user-menu">
              <span className="sfa-usermenu__avatar">{identity.slice(0, 2).toUpperCase()}</span>
              <span className="sfa-usermenu__name">{identity}</span>
              <ChevronDown size={14} className="sfa-muted" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60 rounded-xl p-1.5">
            <div className="sfa-menu-head"><strong>{me.data.user.displayName ?? 'Signed in'}</strong><span>{me.data.user.email}</span></div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate('/workspace')} className="gap-2 rounded-md"><Network size={15} /> Connected accounts</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate('/settings')} className="gap-2 rounded-md"><Settings size={15} /> Settings</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate('/')} className="gap-2 rounded-md"><House size={15} /> Back to site</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={(event) => { event.preventDefault(); logout.mutate(undefined); }} disabled={logout.isPending} className="gap-2 rounded-md text-[hsl(var(--error))] focus:text-[hsl(var(--error))]" data-testid="button-sign-out">
              <LogOut size={15} /> {logout.isPending ? 'Signing out…' : 'Sign out'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {children}
    </div>
    <BottomNav active={active} />
  </div>;
}

export function AppShell({ active, children }: { active: NavKey; children: ReactNode }) {
  return <ConfirmProvider><ComposerProvider><Shell active={active}>{children}</Shell></ComposerProvider></ConfirmProvider>;
}
