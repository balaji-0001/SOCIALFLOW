import { lazy, Suspense, useEffect, useState, type FormEvent, useLayoutEffect } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, ArrowUpRight, BarChart3, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Eye, EyeOff, Inbox, Info, Lock, MailCheck, Menu, PenLine, Play, Plus, RefreshCw, Send, ShieldCheck, Sparkles, Users, X, Zap } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { formatDistanceToNow } from 'date-fns';
import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { type ConnectedAccount, type Platform, getAuthMeQueryKey, getGetPendingConnectionQueryKey, getListConnectedAccountsQueryKey, getListConnectionProvidersQueryKey, useAuthLogin, useAuthLogout, useAuthMe, useAuthSignup, useCancelPendingConnection, useCompletePendingConnection, useDisconnectAccount, useGetPendingConnection, useListConnectedAccounts, useListConnectionProviders, useVerifyConnectedAccount } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { applyTheme } from '@/lib/theme';
import { ThemeToggle } from '@/app/theme-toggle';
import NotFound from '@/pages/not-found';
import { useConfirm } from '@/app/confirm';
import { AccountAvatar, PLATFORM_META } from '@/app/platforms';
import { Button, Skeleton } from '@/app/ui';
import { useToast } from '@/hooks/use-toast';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();

// The signed-in app is split out so visitors to the marketing page don't download it.
const AppShell = lazy(() => import('@/app/AppShell').then((m) => ({ default: m.AppShell })));
const CalendarPage = lazy(() => import('@/app/calendar').then((m) => ({ default: m.CalendarPage })));
const DashboardPage = lazy(() => import('@/app/posts-pages').then((m) => ({ default: m.DashboardPage })));
const PostsPage = lazy(() => import('@/app/posts-pages').then((m) => ({ default: m.PostsPage })));
const DraftsPage = lazy(() => import('@/app/posts-pages').then((m) => ({ default: m.DraftsPage })));
const QueuePage = lazy(() => import('@/app/queue-page').then((m) => ({ default: m.QueuePage })));
const RecurringPage = lazy(() => import('@/app/recurring-page').then((m) => ({ default: m.RecurringPage })));
const AutomationsPage = lazy(() => import('@/app/automations-page').then((m) => ({ default: m.AutomationsPage })));
const SettingsPage = lazy(() => import('@/app/settings-page').then((m) => ({ default: m.SettingsPage })));
const PrivacyPage = lazy(() => import('@/app/legal-pages').then((m) => ({ default: m.PrivacyPage })));
const TermsPage = lazy(() => import('@/app/legal-pages').then((m) => ({ default: m.TermsPage })));
const DataDeletionPage = lazy(() => import('@/app/legal-pages').then((m) => ({ default: m.DataDeletionPage })));
const AnalyticsPage = lazy(() => import('@/app/analytics-page').then((m) => ({ default: m.AnalyticsPage })));
const TeamPage = lazy(() => import('@/app/team-page').then((m) => ({ default: m.TeamPage })));
const AcceptInvitePage = lazy(() => import('@/app/accept-invite').then((m) => ({ default: m.AcceptInvitePage })));
const LibraryPage = lazy(() => import('@/app/library-page').then((m) => ({ default: m.LibraryPage })));
const ApprovalsPage = lazy(() => import('@/app/approvals-page').then((m) => ({ default: m.ApprovalsPage })));
const AiStudioPage = lazy(() => import('@/app/ai-page').then((m) => ({ default: m.AiStudioPage })));

type ModalMode = 'trial' | 'demo';

const menuItems = [
  { label: 'Product', links: [['Publishing', 'Plan once. Show up everywhere.'], ['Analytics', 'Know what earns attention.'], ['Team workspace', 'Move from idea to live post.']] },
  { label: 'Solutions', links: [['For creators', 'Keep your voice in the room.'], ['For agencies', 'Make every client look brilliant.'], ['For teams', 'One rhythm, zero scramble.']] },
  { label: 'Resources', links: [['Playbooks', 'Useful ideas for your next post.'], ['Customer stories', 'See the system in motion.'], ['Socialflow notes', 'Small lessons, shared often.']] },
];

function Logo() {
  return <a href="#top" className="sf-logo" data-testid="link-logo"><span className="sf-logo-mark"><Send size={14} strokeWidth={2.5} /></span><span>socialflow</span></a>;
}

function Header({ onOpen }: { onOpen: (mode: ModalMode) => void }) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeMenu = () => { setOpenMenu(null); setMobileOpen(false); };
  return (
    <header className="sf-header" data-testid="site-header">
      <div className="sf-container sf-header__inner">
        <Logo />
        <nav className="sf-nav" aria-label="Main navigation">
          {menuItems.map((item) => (
            <div className="sf-nav__wrap" key={item.label}>
              <button className={`sf-nav__item ${openMenu === item.label ? 'is-open' : ''}`} onClick={() => setOpenMenu(openMenu === item.label ? null : item.label)} data-testid={`button-nav-${item.label.toLowerCase()}`}>
                {item.label}<ChevronDown size={13} />
              </button>
              <div className={`sf-dropdown ${openMenu === item.label ? 'is-open' : ''}`}>
                {item.links.map(([title, desc]) => <a href="#product" key={title} onClick={closeMenu} data-testid={`link-dropdown-${title.toLowerCase().replaceAll(' ', '-')}`}><strong>{title}</strong><span>{desc}</span></a>)}
              </div>
            </div>
          ))}
          <a className="sf-nav__item" href="#pricing" data-testid="link-pricing">Pricing</a>
          <a className="sf-nav__item sf-nav__item--workspace" href="/dashboard" data-testid="link-workspace">Workspace</a>
        </nav>
        <div className="sf-header__actions">
          <ThemeToggle />
          <a className="sf-login" href="/signin" data-testid="button-login">Sign in</a>
          <a className="sf-button sf-button--primary sf-button--small" href="/signin?mode=signup" data-testid="button-header-trial">Start free</a>
        </div>
        <button className="sf-menu-toggle" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Toggle menu" data-testid="button-mobile-menu">
          {mobileOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
      {mobileOpen && <div className="sf-mobile-nav">
        <div className="sf-mobile-nav__theme"><span>Appearance</span><ThemeToggle /></div>
        {menuItems.map((item) => <div key={item.label}><button onClick={() => setOpenMenu(openMenu === item.label ? null : item.label)} data-testid={`button-mobile-${item.label.toLowerCase()}`}>{item.label}<ChevronDown size={13} /></button>{openMenu === item.label && <div className="sf-mobile-nav__links">{item.links.map(([title]) => <a key={title} href="#product" onClick={closeMenu}>{title}</a>)}</div>}</div>)}
         <a href="#pricing" onClick={closeMenu} data-testid="link-mobile-pricing">Pricing</a>
         <a href="/dashboard" onClick={closeMenu} data-testid="link-mobile-workspace">Workspace</a>
        <a href="/signin?mode=signup" onClick={closeMenu} data-testid="button-mobile-trial">Start free</a>
      </div>}
    </header>
  );
}

function DashboardMockup({ onOpen }: { onOpen: (mode: ModalMode) => void }) {
  const posts = [
    ['Plan a spring launch', 'sf-post--blue'], ['Behind the scenes', 'sf-post--coral'], ['Community question', 'sf-post--sky'], ['Team spotlight', 'sf-post--blue'], ['A note from us', 'sf-post--coral'], ['New collection', 'sf-post--sky'], ['Friday feeling', 'sf-post--blue'], ['Weekly recap', 'sf-post--coral'],
  ];
  return <div className="sf-hero__visual">
    <div className="sf-hero__orbit" aria-hidden="true" />
    <div className="sf-hero__sticker">more signal<br />less scramble</div>
    <div className="sf-dashboard" data-testid="dashboard-mockup">
      <div className="sf-dashboard__bar"><div className="sf-dashboard__dots"><i /><i /><i /></div><span>workspace / northstar studio</span><span>● 12 teammates</span></div>
      <div className="sf-dashboard__body">
        <aside className="sf-dashboard__side">
          <div className="sf-dashboard__side-label">workspace</div>
          <div className="sf-dashboard__side-item is-active"><CalendarDays /> Calendar</div>
          <div className="sf-dashboard__side-item"><PenLine /> Compose</div>
          <div className="sf-dashboard__side-item"><Inbox /> Inbox</div>
          <div className="sf-dashboard__side-item"><BarChart3 /> Insights</div>
          <div className="sf-dashboard__side-label">manage</div>
          <div className="sf-dashboard__side-item"><Users /> Team</div>
          <div className="sf-dashboard__side-item"><Sparkles /> Library</div>
        </aside>
        <main className="sf-dashboard__main">
          <div className="sf-dash-head"><div><h3>Content calendar</h3><span>Week of May 13–19, 2025</span></div><button className="sf-button sf-button--primary sf-button--small" onClick={() => onOpen('trial')} data-testid="button-dashboard-compose"><Plus size={12} /> Create post</button></div>
          <div className="sf-dash-tabs"><span className="is-active">Calendar</span><span>List</span><span>Best times</span></div>
          <div className="sf-calendar">
            <div className="sf-calendar__days">{['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((day) => <span key={day}>{day}</span>)}</div>
            <div className="sf-calendar__grid">{Array.from({ length: 14 }, (_, index) => <div className="sf-calendar__cell" key={index}><b>{index + 13}</b>{posts.slice(index % 4, index % 4 + (index % 3 === 0 ? 2 : 1)).map(([text, color], postIndex) => <div className={`sf-post ${color}`} key={`${text}-${postIndex}`}>{text}</div>)}</div>)}</div>
          </div>
        </main>
      </div>
    </div>
    <div className="sf-floating-note"><CircleCheck size={20} /><span>Next up: launch thread<br /><small>Ready for review</small></span></div>
  </div>;
}

function Hero({ onOpen }: { onOpen: (mode: ModalMode) => void }) {
  return <section className="sf-hero" id="top">
    <div className="sf-container sf-hero__grid">
      <div>
        <span className="sf-eyebrow">A calmer way to stay visible</span>
        <h1 className="sf-display">Make your social <em>flow.</em></h1>
        <p className="sf-hero__copy">Socialflow brings planning, publishing, and performance into one clear rhythm — so your best ideas reach people while they still feel fresh.</p>
        <div className="sf-hero__actions"><button className="sf-button sf-button--primary" onClick={() => onOpen('trial')} data-testid="button-hero-trial">Start free for 14 days <ArrowRight size={16} /></button><button className="sf-button sf-button--ghost" onClick={() => onOpen('demo')} data-testid="button-hero-demo">See it in action <Play size={14} /></button></div>
        <div className="sf-hero__fine"><span>No card needed</span><i /><span>Set up in 10 minutes</span><i /><span>Cancel anytime</span></div>
      </div>
      <DashboardMockup onOpen={onOpen} />
    </div>
  </section>;
}

function ProofStrip() {
  return <section className="sf-proof" aria-label="Customer proof"><div className="sf-container sf-proof__inner"><span className="sf-proof__label">The operating system for<br />teams who show up</span><div className="sf-proof__brands"><span className="sf-proof__brand">northstar</span><span className="sf-proof__brand">KIN + CO</span><span className="sf-proof__brand">verve</span><span className="sf-proof__brand">FIELDNOTE</span></div></div></section>;
}

function ProductStory() {
  return <section className="sf-section sf-story" id="product"><div className="sf-container">
    <div className="sf-story__top"><div><span className="sf-kicker">One connected workspace</span><h2 className="sf-display">The busywork ends.<br /><span>The momentum stays.</span></h2></div><p className="sf-story__intro">From the first spark to the monthly report, Socialflow gives every person a clear next move.</p></div>
    <div className="sf-feature-grid">
      <article className="sf-feature-card sf-feature-card--large"><div className="sf-feature-icon"><CalendarDays size={18} /></div><h3>Plan the story, not just the posts.</h3><p>See every channel in one living calendar. Drag ideas into place, spot quiet weeks, and keep launches moving without another spreadsheet.</p><div className="sf-mini-chart" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <i key={i} />)}</div></article>
      <article className="sf-feature-card sf-feature-card--side"><div><div className="sf-feature-icon"><Users size={18} /></div><h3>Make room for better collaboration.</h3><p>Invite your team, collect feedback in context, and keep approvals moving from “maybe” to “make it live.”</p></div><a href="#faq" className="sf-eyebrow" data-testid="link-collaboration">Explore collaboration <ArrowRight size={13} /></a></article>
    </div>
  </div></section>;
}

const platformData = [
  ['X', 'X / Threads', 'Short-form ideas, sharper conversations.'],
  ['◎', 'Instagram', 'Make the grid feel considered.'],
  ['in', 'LinkedIn', 'Turn expertise into a point of view.'],
  ['▶', 'YouTube', 'Give your bigger stories a runway.'],
];

function Platforms() {
  return <section className="sf-section sf-platforms" id="channels"><div className="sf-container"><div className="sf-platforms__head"><div><span className="sf-kicker">Everywhere your people are</span><h2 className="sf-display">One idea.<br />Many good places.</h2></div><p>Publish the right version to every channel, without losing the thread that made the idea worth sharing.</p></div><div className="sf-platform-grid">{platformData.map(([mark, title, desc]) => <article className="sf-platform" key={title} data-testid={`card-platform-${title.toLowerCase().replaceAll(' ', '-')}`}><div className="sf-platform__top"><span className="sf-platform__logo">{mark}</span><ArrowUpRight size={15} /></div><h3>{title}</h3><p>{desc}</p></article>)}</div></div></section>;
}

function Results() {
  return <section className="sf-metric-band"><div className="sf-container sf-metric-band__inner"><div><span className="sf-kicker">A little more signal</span><h2 className="sf-display">Good systems<br />make room for<br />good work.</h2><div className="sf-stat-row"><div className="sf-stat"><strong>6.4 hrs</strong><span>saved per week</span></div><div className="sf-stat"><strong>2.8×</strong><span>more content shipped</span></div></div></div><div className="sf-metric-band__quote">“We stopped asking ‘did that go out?’ and started asking ‘what should we try next?’ That shift changed the way our whole team works.”<small>— Maya Chen, Brand lead at Verve</small></div></div></section>;
}

function Pricing({ onOpen }: { onOpen: (mode: ModalMode) => void }) {
  return <section className="sf-section sf-pricing" id="pricing"><div className="sf-container sf-pricing__inner"><div className="sf-pricing__copy"><span className="sf-kicker">Small teams, serious rhythm</span><h2 className="sf-display">Start with the plan that moves with you.</h2><p>Everything you need to find your cadence now, with space to grow into it later. No feature maze. No surprise math.</p><div className="sf-pricing__note"><Zap size={15} /> Includes every core workflow</div></div><div className="sf-pricing-card"><div className="sf-pricing-card__top"><div><h3>Flow team</h3><div className="sf-price"><strong>$24</strong><span>/ seat / month</span></div><div className="sf-pricing-card__sub">For teams ready to make consistency a habit.</div></div><span className="sf-pricing-card__tag">Most loved</span></div><div className="sf-pricing-card__list">{['Unlimited channels', 'Approval workflows', 'Smart calendar', 'Performance reports', 'Content library', 'Live team inbox'].map((item) => <span key={item}><Check size={14} />{item}</span>)}</div><button className="sf-button sf-button--primary" style={{ width: '100%' }} onClick={() => onOpen('trial')} data-testid="button-pricing-trial">Try Flow team free <ArrowRight size={15} /></button></div></div></section>;
}

function Testimonials() {
  const [slide, setSlide] = useState(0);
  const testimonials = [
    { quote: 'Socialflow gave our ideas somewhere to land. We publish more, but it finally feels like less work.', name: 'Maya Chen', role: 'Brand lead, Verve', initials: 'MC' },
    { quote: 'Our client calls changed completely. We bring the work, the why, and the next move into the same room.', name: 'Jon Bell', role: 'Creative director, KIN + CO', initials: 'JB' },
  ];
  const current = testimonials[slide];
  return <section className="sf-section sf-testimonials"><div className="sf-container"><div className="sf-testimonials__head"><div><span className="sf-kicker">Good company, good work</span><h2 className="sf-display">Built for the people behind the posts.</h2></div><div className="sf-testimonials__arrows"><button className="sf-round-button" onClick={() => setSlide((slide + testimonials.length - 1) % testimonials.length)} aria-label="Previous testimonial" data-testid="button-testimonial-previous"><ChevronLeft size={17} /></button><button className="sf-round-button" onClick={() => setSlide((slide + 1) % testimonials.length)} aria-label="Next testimonial" data-testid="button-testimonial-next"><ChevronRight size={17} /></button></div></div><div className="sf-testimonial-grid"><article className="sf-testimonial sf-testimonial--featured" data-testid="testimonial-featured"><div className="sf-stars">★★★★★</div><blockquote>“{current.quote}”</blockquote><div className="sf-testimonial__person"><span className="sf-avatar">{current.initials}</span><div><strong>{current.name}</strong><span>{current.role}</span></div></div></article><article className="sf-testimonial"><div className="sf-stars">★★★★★</div><blockquote>“The first tool that makes our content calendar feel like a creative space — not a traffic report.”</blockquote><div className="sf-testimonial__person"><span className="sf-avatar">AR</span><div><strong>Alex Rivera</strong><span>Founder, Northstar Studio</span></div></div></article></div></div></section>;
}

function FAQ() {
  const [open, setOpen] = useState<number | null>(0);
  const questions = [
    ['Can I try Socialflow before choosing a plan?', 'Absolutely. Every workspace starts with a 14-day trial of the full Flow team experience. No credit card, no awkward sales call.'],
    ['Which channels can I manage?', 'Socialflow currently supports Instagram, LinkedIn, X, Threads, and YouTube. We add new channels based on what teams actually need next.'],
    ['Is Socialflow just for marketing teams?', 'Not at all. Creators, agencies, founders, and in-house teams all use the same flexible workspace — with permissions that keep the room comfortable.'],
    ['What happens to my content after the trial?', 'Your workspace stays yours. Upgrade when you are ready, or export your calendar and content library whenever you like.'],
  ];
  return <section className="sf-section sf-faq" id="faq"><div className="sf-container sf-faq__grid"><div className="sf-faq__copy"><span className="sf-kicker">A few clear answers</span><h2 className="sf-display">Questions, meet answers.</h2><p>Still curious? We are real people who like talking about the work. Send us a note and we will get back to you.</p><a className="sf-eyebrow" href="mailto:hello@socialflow.example" data-testid="link-contact">Talk to our team <ArrowRight size={13} /></a></div><div className="sf-faq__list">{questions.map(([question, answer], index) => <div className="sf-faq__item" key={question}><button className={`sf-faq__question ${open === index ? 'is-open' : ''}`} onClick={() => setOpen(open === index ? null : index)} aria-expanded={open === index} data-testid={`button-faq-${index}`}><span>{question}</span><Plus size={18} /></button><div className={`sf-faq__answer ${open === index ? 'is-open' : ''}`}><span>{answer}</span></div></div>)}</div></div></section>;
}

function CTA({ onOpen }: { onOpen: (mode: ModalMode) => void }) {
  return <section className="sf-cta"><div className="sf-container sf-cta__inner"><div><span className="sf-kicker">Your next good week starts here</span><h2 className="sf-display">Make room for momentum.</h2></div><div className="sf-cta__action"><p className="sf-cta__copy">A clear plan, a better rhythm, and more of your best work in the world.</p><button className="sf-button sf-button--coral" onClick={() => onOpen('trial')} data-testid="button-final-trial">Start your free trial <ArrowRight size={15} /></button></div></div></section>;
}

type ChannelKey = Platform | 'x';

const channelOptions: Array<{ key: ChannelKey; mark: string; name: string; description: string; tone: string }> = [
  { key: 'facebook', mark: 'f', name: 'Facebook Pages', description: 'Publish to the Pages you manage and keep every community in step.', tone: 'blue' },
  { key: 'instagram', mark: '◎', name: 'Instagram', description: 'Plan your grid, reels, and stories in one visual rhythm.', tone: 'coral' },
  { key: 'linkedin', mark: 'in', name: 'LinkedIn', description: 'Turn your team expertise into a consistent point of view.', tone: 'blue' },
  { key: 'youtube', mark: '▶', name: 'YouTube', description: 'Give bigger stories a clear runway and publishing cadence.', tone: 'red' },
  { key: 'x', mark: 'X', name: 'X', description: 'Keep short-form ideas moving from draft to conversation.', tone: 'ink' },
];

const connectionErrorCopy: Record<string, string> = {
  not_configured: "This platform isn't set up on the server yet. Its app credentials need to be added to Replit Secrets.",
  access_denied: 'The connection was cancelled. Nothing was connected.',
  invalid_state: 'That connection request expired or came from a different browser. Please try again.',
  invalid_callback: 'The provider sent back an incomplete response. Please try again.',
  token_exchange_failed: 'The provider rejected the sign-in. The app credentials or redirect URL may be misconfigured.',
  missing_scopes: 'Some required permissions were not granted. Reconnect and allow every requested permission.',
  no_accounts: 'No eligible accounts were shared. Make sure you manage at least one and select it in the provider dialog.',
  account_not_granted: "The account you're reconnecting wasn't included in the permissions you just granted.",
  insufficient_permissions: "The app doesn't have the permissions it needs. Reconnect and grant them.",
  token_expired: 'The access token expired. Reconnect the account.',
  token_revoked: 'Access was revoked on the provider side. Reconnect the account.',
  rate_limited: 'The provider is rate limiting requests. Try again in a few minutes.',
  provider_error: 'The provider returned an unexpected error. Please try again.',
};

const statusCopy: Record<ConnectedAccount['status'], string> = {
  active: 'Connected',
  expired: 'Token expired',
  revoked: 'Access revoked',
  missing_permissions: 'Missing permissions',
  error: 'Check failed',
};

const platformNames: Record<Platform, string> = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', youtube: 'YouTube' };
const accountNouns: Record<Platform, string> = { facebook: 'Facebook Pages', instagram: 'Instagram accounts', linkedin: 'LinkedIn profiles and pages', youtube: 'YouTube channels' };

type Notice = { tone: 'success' | 'error'; text: string };

function startConnection(platform: Platform, reconnectId?: string) {
  const query = reconnectId ? `?reconnect=${encodeURIComponent(reconnectId)}` : '';
  const url = `/api/connections/${platform}/start${query}`;

  // Facebook, Google, and other OAuth providers send "X-Frame-Options: DENY".
  // When running inside an iframe (like Replit's webview panel), navigating the frame
  // causes the browser to block the page with "www.facebook.com refused to connect".
  // Opening in a new browser tab ensures the consent dialog opens as a top-level document.
  if (typeof window !== 'undefined' && window.self !== window.top) {
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) {
      window.location.assign(url);
    }
  } else {
    window.location.assign(url);
  }
}

// Reads the result the OAuth callback left in the URL, then removes it.
function useConnectionResult(): { notice: Notice | null; pendingId: string | null; clearPending: () => void; setNotice: (n: Notice | null) => void } {
  const [initial] = useState(() => new URLSearchParams(window.location.search));
  const [pendingId, setPendingId] = useState<string | null>(initial.get('pending'));
  const [notice, setNotice] = useState<Notice | null>(() => {
    const platform = initial.get('platform') ?? initial.get('connected');
    const name = platform && platform in platformNames ? platformNames[platform as Platform] : 'The account';
    const error = initial.get('connection_error');
    if (error) {
      const missing = initial.get('missing');
      return { tone: 'error', text: `${name}: ${connectionErrorCopy[error] ?? connectionErrorCopy.provider_error}${missing ? ` Missing: ${missing.split(',').join(', ')}.` : ''}` };
    }
    if (initial.get('connected')) return { tone: 'success', text: `${name} ${initial.get('reconnected') ? 'reconnected' : 'connected'} successfully.` };
    return null;
  });
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
  }, []);
  return { notice, pendingId, clearPending: () => setPendingId(null), setNotice };
}

const statusTone: Record<ConnectedAccount['status'], 'success' | 'warning' | 'error'> = { active: 'success', expired: 'warning', revoked: 'error', missing_permissions: 'warning', error: 'error' };

/** Shows "Connecting…" after an OAuth start until the page leaves, regains focus, or a short timeout passes. */
function useConnecting<T>() {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (value === null) return;
    const reset = () => setValue(null);
    const timer = window.setTimeout(reset, 8000);
    window.addEventListener('focus', reset);
    window.addEventListener('pageshow', reset);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', reset); window.removeEventListener('pageshow', reset); };
  }, [value]);
  return [value, setValue] as const;
}

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  facebook_page: 'Facebook Page', instagram_business: 'Business account', instagram_creator: 'Creator account',
  linkedin_member: 'Personal profile', linkedin_organization: 'Organization page', youtube_channel: 'YouTube channel',
};

function AccountRow({ account, busy, checking, onVerify, onDisconnect }: { account: ConnectedAccount; busy: boolean; checking: boolean; onVerify: () => void; onDisconnect: () => void }) {
  const healthy = account.status === 'active';
  const [connecting, setConnecting] = useConnecting<true>();
  return <li className={`sfa-conn ${healthy ? '' : 'is-warn'}`} data-testid={`row-account-${account.id}`}>
    <AccountAvatar account={account} size={36} />
    <div className="sfa-conn__copy">
      <strong title={account.displayName}>{account.displayName}</strong>
      <span className={`sfa-pill sfa-pill--${statusTone[account.status]}`}>{statusCopy[account.status]}</span>
      <span className="sfa-conn__meta" data-testid={`meta-account-${account.id}`}>{ACCOUNT_TYPE_LABEL[account.accountType] ?? 'Account'} · {account.lastVerifiedAt ? `Checked ${formatDistanceToNow(new Date(account.lastVerifiedAt), { addSuffix: true })}` : 'Not checked yet'}</span>
      {!healthy && account.statusDetail && <span className="sfa-conn__detail">{account.statusDetail}</span>}
    </div>
    <div className="sfa-conn__actions">
      {healthy
        ? <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} loading={checking} onClick={onVerify} disabled={busy} title="Check the token with the provider" data-testid={`button-verify-${account.id}`}>Check</Button>
        : <Button size="sm" variant="primary" icon={<RefreshCw size={13} />} loading={connecting !== null} onClick={() => { setConnecting(true); startConnection(account.platform, account.id); }} data-testid={`button-reconnect-${account.id}`}>{connecting ? 'Connecting…' : 'Reconnect'}</Button>}
      <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={onDisconnect} disabled={busy} data-testid={`button-disconnect-${account.id}`}>Disconnect</Button>
    </div>
  </li>;
}

function AccountPicker({ pendingId, onDone, onClose }: { pendingId: string; onDone: (count: number, platform: Platform) => void; onClose: () => void }) {
  const { data, isLoading, error } = useGetPendingConnection(pendingId, { query: { queryKey: getGetPendingConnectionQueryKey(pendingId), retry: false } });
  const [selected, setSelected] = useState<string[] | null>(null);
  const complete = useCompletePendingConnection();
  const cancel = useCancelPendingConnection();
  const choices = selected ?? data?.candidates.filter((c) => c.selectable && !c.alreadyConnected).map((c) => c.externalAccountId) ?? [];
  const toggle = (id: string) => setSelected(choices.includes(id) ? choices.filter((x) => x !== id) : [...choices, id]);
  const close = () => { cancel.mutate({ pendingId }); onClose(); };
  const name = data ? platformNames[data.platform] : '';

  return <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="sfa-overlay" />
      <DialogPrimitive.Content className="sfa-dialog sfa-picker" aria-describedby={undefined} data-testid="dialog-picker"
        onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}>
        <DialogPrimitive.Close asChild><button className="sfa-iconbtn sfa-dialog__close" aria-label="Close dialog" data-testid="button-close-picker"><X size={18} /></button></DialogPrimitive.Close>
        {data && <span className="sfa-mark sfa-mark--lg" style={{ background: PLATFORM_META[data.platform].color }} aria-hidden="true">{(() => { const Icon = PLATFORM_META[data.platform].Icon; return <Icon size={22} />; })()}</span>}
        <span className="sfa-eyebrow">Choose accounts</span>
        <DialogPrimitive.Title className="sfa-dialog__title">Which {data ? accountNouns[data.platform] : 'accounts'} should Socialflow manage?</DialogPrimitive.Title>
        {isLoading && <>
          <p className="sfa-dialog__desc">Loading the accounts you shared…</p>
          <ul className="sfa-picker__list" aria-busy="true">{[0, 1, 2].map((i) => <li key={i} className="sfa-picker__skel"><Skeleton width={18} height={18} radius={5} /><Skeleton width={36} height={36} radius={999} /><Skeleton width="55%" /></li>)}</ul>
        </>}
        {error && <div className="sfa-alert" role="alert"><CircleAlert size={15} /> <span>This selection expired. Start the connection again.</span></div>}
        {data && <>
          <p className="sfa-dialog__desc">These came back from {name}. Pick the ones you want in this workspace — you can add or remove them later.</p>
          <ul className="sfa-picker__list">
            {data.candidates.map((candidate) => {
              const disabled = !candidate.selectable;
              const on = choices.includes(candidate.externalAccountId);
              return <li key={candidate.externalAccountId}>
                <label className={`sfa-picker__item ${disabled ? 'is-disabled' : ''} ${on ? 'is-on' : ''}`} data-testid={`option-candidate-${candidate.externalAccountId}`}>
                  <input type="checkbox" disabled={disabled} checked={on} onChange={() => toggle(candidate.externalAccountId)} />
                  <AccountAvatar account={{ displayName: candidate.displayName, avatarUrl: candidate.avatarUrl, platform: data.platform }} size={36} />
                  <span className="sfa-picker__copy"><strong>{candidate.displayName}</strong>
                    {candidate.alreadyConnected && <small>Already connected — selecting it refreshes its token.</small>}
                    {candidate.warnings.map((warning) => <small className="is-warning" key={warning}>{warning}</small>)}
                  </span>
                </label>
              </li>;
            })}
          </ul>
          {complete.error && <div className="sfa-alert" role="alert"><CircleAlert size={15} /> <span>{complete.error.data?.message ?? 'Could not connect those accounts.'}</span></div>}
          <Button variant="primary" size="lg" className="sfa-picker__confirm" disabled={choices.length === 0} loading={complete.isPending} data-testid="button-confirm-accounts"
            onClick={() => complete.mutate({ pendingId, data: { externalAccountIds: choices } }, { onSuccess: (result) => onDone(result.accounts.length, data.platform) })}>
            {complete.isPending ? 'Connecting…' : `Connect ${choices.length} ${choices.length === 1 ? 'account' : 'accounts'}`} {!complete.isPending && <ArrowRight size={15} />}
          </Button>
        </>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

type AuthMode = 'signin' | 'signup' | 'forgot';

function AuthBrand() {
  return (
   <aside className="sfa-auth__brand" aria-label="About Socialflow">
      <span className="sfa-auth__tag">Social media management</span>
      <div>
        <h2>Plan once. <em>Show up everywhere.</em></h2>
        <p>Socialflow brings planning, publishing, and performance into one clear rhythm — so your best ideas reach people while they still feel fresh.</p>
      </div>
      <ul className="sfa-auth__points">
        <li><ShieldCheck size={16} /> Accounts connect through each platform's official OAuth. Socialflow never sees your passwords.</li>
        <li><Lock size={16} /> Tokens encrypted, private to your workspace</li>
        <li><CalendarDays size={16} /> Calendar, drafts and scheduling in one place</li>
      </ul>
    </aside>
  );
}

/** Calls one of the password-reset endpoints and returns the server's message, or throws with a readable one. */
async function postAuth(path: string, body: Record<string, string>): Promise<string> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  const data = (await response.json().catch(() => null)) as { message?: string } | null;
  if (!response.ok) throw new Error(data?.message ?? 'Something went wrong. Please try again.');
  return data?.message ?? 'Done.';
}

/** "Forgot password": asks for the email and has the server send a reset link. */
function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    try {
      await postAuth('/api/auth/forgot-password', { email });
      setSentTo(email);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };
  if (sentTo) {
    return <div className="sfa-auth__done" role="status" data-testid="status-forgot-sent">
      <MailCheck size={22} aria-hidden />
      <strong>Check your email</strong>
      <p>If an account exists for <b>{sentTo}</b>, we've sent a link to reset the password. It works once and expires in an hour. Check spam if you don't see it.</p>
      <button type="button" className="sfa-linkbtn" onClick={onBack} data-testid="button-forgot-back">Back to sign in</button>
    </div>;
  }
  return <form className="sfa-form" onSubmit={onSubmit} aria-labelledby="auth-title">
    <div className="sfa-field">
      <label htmlFor="forgot-email">Email</label>
      <input id="forgot-email" className="sfa-input" type="email" name="email" placeholder="you@yourcompany.com" required autoComplete="email" data-testid="input-forgot-email" />
    </div>
    {error && <div className="sfa-alert" role="alert" data-testid="status-forgot-error"><CircleAlert size={15} /> <span>{error}</span></div>}
    <Button type="submit" variant="primary" size="lg" loading={busy} className="sfa-auth__submit" data-testid="button-forgot-submit">
      {busy ? 'Sending…' : 'Send reset link'} {!busy && <ArrowRight size={15} />}
    </Button>
  </form>;
}

/** The page the emailed link opens: choose a new password. */
function ResetPassword() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => { document.title = 'Choose a new password · Socialflow'; }, []);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    if (password !== String(form.get('confirm') ?? '')) { setError('The two passwords don’t match.'); return; }
    setBusy(true);
    try {
      await postAuth('/api/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return <div className="sfa-auth">
    <main className="sfa-auth__panel">
      <a className="sfa-auth__back" href="/signin"><ArrowLeft size={14} /> Back to sign in</a>
      <ThemeToggle className="sfa-themetoggle--corner" />
      <div className="sfa-auth__card">
        <a href="/" className="sfa-side__logo" aria-label="Socialflow home"><span className="sf-logo-mark"><Send size={14} strokeWidth={2.5} /></span><span>socialflow</span></a>
        {done ? <div className="sfa-auth__done" role="status" data-testid="status-reset-done">
          <MailCheck size={22} aria-hidden />
          <strong>Password changed</strong>
          <p>You've been signed out everywhere. Sign in with your new password.</p>
          <a className="sf-button sf-button--primary" href="/signin" data-testid="link-reset-signin">Go to sign in</a>
        </div> : !token ? <>
          <h1 id="auth-title">This link isn't valid.</h1>
          <p>Open the link from the reset email, or <a href="/signin" className="sfa-linkbtn">request a new one</a>.</p>
        </> : <>
          <span className="sfa-eyebrow">Reset password</span>
          <h1 id="auth-title">Choose a new password.</h1>
          <p>Use 8 or more characters.</p>
          <form className="sfa-form" onSubmit={onSubmit} aria-labelledby="auth-title">
            <div className="sfa-field">
              <label htmlFor="reset-password">New password</label>
              <div className="sfa-field__wrap">
                <input id="reset-password" className="sfa-input" type={showPassword ? 'text' : 'password'} name="password" minLength={8} required autoComplete="new-password" data-testid="input-reset-password" />
                <button type="button" className="sfa-field__toggle" onClick={() => setShowPassword((shown) => !shown)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div className="sfa-field">
              <label htmlFor="reset-confirm">Confirm new password</label>
              <input id="reset-confirm" className="sfa-input" type={showPassword ? 'text' : 'password'} name="confirm" minLength={8} required autoComplete="new-password" data-testid="input-reset-confirm" />
            </div>
            {error && <div className="sfa-alert" role="alert" data-testid="status-reset-error"><CircleAlert size={15} /> <span>{error} {/expired|invalid/.test(error) && <a href="/signin" className="sfa-linkbtn">Request a new link</a>}</span></div>}
            <Button type="submit" variant="primary" size="lg" loading={busy} className="sfa-auth__submit" data-testid="button-reset-submit">
              {busy ? 'Saving…' : 'Change password'} {!busy && <ArrowRight size={15} />}
            </Button>
          </form>
        </>}
      </div>
    </main>
    <AuthBrand />
  </div>;
}

/** Reads `?next=`, the path to resume after signing in. A `/api/...` value
 * resumes a server-side OAuth start redirect (see connections.ts) and needs
 * a full navigation, not client-side routing. */
function useNextPath(): { next: string; goNext: () => void } {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const next = new URLSearchParams(window.location.search).get('next') || '/dashboard';
  const goNext = () => {
    queryClient.invalidateQueries({ queryKey: getAuthMeQueryKey() });
    if (next.startsWith('/api/')) window.location.assign(next);
    else navigate(next);
  };
  return { next, goNext };
}

function SignIn() {
  const [mode, setMode] = useState<AuthMode>(() => (new URLSearchParams(window.location.search).get('mode') === 'signup' ? 'signup' : 'signin'));
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const { goNext } = useNextPath();

  const signup = useAuthSignup({ mutation: { onSuccess: goNext, onError: (err) => setError(err.data?.message ?? 'Could not create your account.') } });
  const login = useAuthLogin({ mutation: { onSuccess: goNext, onError: (err) => setError(err.data?.message ?? 'Incorrect email or password.') } });
  const busy = signup.isPending || login.isPending;
  const isSignup = mode === 'signup';
  const isForgot = mode === 'forgot';

  useEffect(() => { document.title = `${isSignup ? 'Create your account' : isForgot ? 'Reset your password' : 'Sign in'} · Socialflow`; }, [isSignup, isForgot]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    if (isSignup) {
      const displayName = String(form.get('displayName') ?? '').trim();
      signup.mutate({ data: { email, password, ...(displayName ? { displayName } : {}) } });
    } else {
      login.mutate({ data: { email, password } });
    }
  };

  return <div className="sfa-auth">
    <main className="sfa-auth__panel">
      <a className="sfa-auth__back" href="/"><ArrowLeft size={14} /> Back to site</a>
      <ThemeToggle className="sfa-themetoggle--corner" />
      <div className="sfa-auth__card">
        <a href="/" className="sfa-side__logo" aria-label="Socialflow home"><span className="sf-logo-mark"><Send size={14} strokeWidth={2.5} /></span><span>socialflow</span></a>
        <span className="sfa-eyebrow">{isSignup ? 'Create your workspace' : isForgot ? 'Forgot your password?' : 'Welcome back'}</span>
        <h1 id="auth-title">{isSignup ? 'Set up Socialflow.' : isForgot ? 'Reset your password.' : 'Sign in to Socialflow.'}</h1>
        <p>{isSignup ? 'One account, one workspace. Connect your channels right after.' : isForgot ? 'Enter your email and we’ll send you a link to choose a new password.' : 'Sign in to manage your connected channels.'}</p>
        {isForgot ? <ForgotPasswordForm onBack={() => { setMode('signin'); setError(null); }} /> : <form className="sfa-form" onSubmit={onSubmit} aria-labelledby="auth-title">
          {isSignup && <div className="sfa-field">
            <label htmlFor="auth-name">Name <span className="sfa-muted">(optional)</span></label>
            <input id="auth-name" className="sfa-input" type="text" name="displayName" placeholder="Ada Lovelace" autoComplete="name" data-testid="input-display-name" />
          </div>}
          <div className="sfa-field">
            <label htmlFor="auth-email">Work email</label>
            <input id="auth-email" className="sfa-input" type="email" name="email" placeholder="you@yourcompany.com" required autoComplete="email" data-testid="input-auth-email" />
          </div>
          <div className="sfa-field">
            <div className="sfa-field__row">
              <label htmlFor="auth-password">Password</label>
              {!isSignup && <button type="button" className="sfa-linkbtn" onClick={() => { setMode('forgot'); setError(null); }} data-testid="button-forgot-password">Forgot password?</button>}
            </div>
            <div className="sfa-field__wrap">
              <input id="auth-password" className="sfa-input" type={showPassword ? 'text' : 'password'} name="password" minLength={8} required placeholder="At least 8 characters"
                autoComplete={isSignup ? 'new-password' : 'current-password'} aria-describedby={isSignup ? 'auth-password-hint' : undefined} data-testid="input-auth-password" />
              <button type="button" className="sfa-field__toggle" onClick={() => setShowPassword((shown) => !shown)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {isSignup && <span id="auth-password-hint" className="sfa-field__hint">Use 8 or more characters.</span>}
          </div>
          {error && <div className="sfa-alert" role="alert" data-testid="status-auth-error"><CircleAlert size={15} /> <span>{error}</span></div>}
          <Button type="submit" variant="primary" size="lg" loading={busy} className="sfa-auth__submit" data-testid="button-auth-submit">
            {busy ? 'Please wait…' : isSignup ? 'Create account' : 'Sign in'} {!busy && <ArrowRight size={15} />}
          </Button>
        </form>}
        <p className="sfa-auth__switch">
          {isSignup ? 'Already have an account? ' : isForgot ? 'Remembered it? ' : "Don't have an account? "}
          <button type="button" className="sfa-linkbtn" onClick={() => { setMode(isSignup || isForgot ? 'signin' : 'signup'); setError(null); }} data-testid="button-toggle-auth-mode">
            {isSignup || isForgot ? 'Sign in' : 'Create one'}
          </button>
        </p>
      </div>
    </main>
    <AuthBrand />
  </div>;
}

/** The connect-your-accounts page. Rendered inside AppShell, which has already confirmed the user is signed in. */
function AccountsContent() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
  const { notice, setNotice, pendingId, clearPending } = useConnectionResult();
  const [connecting, setConnecting] = useConnecting<ChannelKey>();

  const { data: providerData } = useListConnectionProviders({ query: { queryKey: getListConnectionProvidersQueryKey() } });
  const { data: accountData, isLoading } = useListConnectedAccounts({ query: { queryKey: getListConnectedAccountsQueryKey() } });
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListConnectedAccountsQueryKey() });
  const disconnect = useDisconnectAccount({ mutation: { onSuccess: () => { refresh(); toast({ title: 'Account disconnected' }); } } });
  const verify = useVerifyConnectedAccount({ mutation: { onSuccess: () => { refresh(); toast({ title: 'Connection checked' }); }, onError: (error) => setNotice({ tone: 'error', text: error.data?.message ?? 'The check failed.' }) } });
  const accounts = accountData?.accounts ?? [];
  const providers = new Map((providerData?.providers ?? []).map((provider) => [provider.platform, provider]));
  const connectedCount = accounts.length;
  const busy = disconnect.isPending || verify.isPending;
  const isEmbedded = typeof window !== 'undefined' && window.self !== window.top;

  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return <div className="sfa-page" data-testid="page-accounts">
    {isEmbedded && <div className="sfa-banner sfa-banner--info">
      <Info size={16} />
      <span>
        Preview mode: Social account logins open in a new tab because Meta forbids login inside embedded panels. You can also{' '}
        <a href={window.location.href} target="_blank" rel="noopener noreferrer">open Socialflow in a full tab <ArrowUpRight size={13} style={{ display: 'inline', verticalAlign: 'middle' }} /></a>
      </span>
    </div>}
    {notice
      ? <div className={`sfa-banner sfa-banner--${notice.tone}`} role="status" data-testid="status-connection">
          {notice.tone === 'success' ? <CircleCheck size={16} /> : <AlertTriangle size={16} />}<span>{notice.text}</span>
          <button className="sfa-iconbtn sfa-banner__close" onClick={() => setNotice(null)} aria-label="Dismiss"><X size={14} /></button>
        </div>
      : <div className="sfa-banner sfa-banner--neutral"><ShieldCheck size={16} /><span>Accounts connect through each platform's official OAuth. Socialflow never sees your passwords.</span></div>}

    <header className="sfa-pageheader">
      <div>
        <span className="sfa-eyebrow">Workspace setup</span>
        <h1>Bring your channels <em>into the flow.</em></h1>
        <p>Connect the places your audience already checks in. Once they are together, planning gets clearer and publishing gets lighter.</p>
      </div>
      <div className="sfa-summary" data-testid="stat-connected">
        <span>Connected accounts</span>
        <strong className="sfa-num">{isLoading ? '–' : connectedCount}</strong>
        <small>{connectedCount === 0 ? 'Start with your most important channel.' : 'Your workspace is taking shape.'}</small>
      </div>
    </header>

    <section aria-labelledby="accounts-title">
      <div className="sfa-sectionhead">
        <div><span className="sfa-eyebrow">Your channels</span><h2 id="accounts-title">Connect your social accounts.</h2></div>
        <span className="sfa-secure"><ShieldCheck size={14} /> Tokens encrypted, private to your workspace</span>
      </div>
      <div className="sfa-channels">
        {channelOptions.map((channel) => {
          const provider = channel.key === 'x' ? undefined : providers.get(channel.key);
          const own = accounts.filter((account) => account.platform === channel.key);
          const ready = Boolean(provider?.configured);
          let label = 'Not available yet';
          if (provider?.implemented && !ready) label = 'Setup required';
          if (ready) label = own.length > 0 ? 'Add another' : 'Connect account';
          if (isLoading && ready) label = 'Checking…';
          const meta = channel.key === 'x' ? null : PLATFORM_META[channel.key];
          const Icon = meta?.Icon;
          const isConnecting = connecting === channel.key;
          return <article className={`sfa-channel ${own.length > 0 ? 'is-connected' : ''}`} key={channel.key} data-testid={`card-account-${channel.key}`}>
            <div className="sfa-channel__top">
              <span className="sfa-mark" style={{ background: meta?.color ?? 'hsl(240 8% 22%)' }} aria-hidden="true">{Icon ? <Icon size={20} /> : channel.mark}</span>
              <div className="sfa-channel__copy">
                <div className="sfa-channel__title">
                  <h3>{channel.name}</h3>
                  {own.length > 0 && <span className="sfa-pill sfa-pill--success">{own.length} connected</span>}
                  {provider?.implemented && !ready && <span className="sfa-pill sfa-pill--warning">Setup required</span>}
                  {(channel.key === 'x' || (provider && !provider.implemented)) && <span className="sfa-pill sfa-pill--draft">Coming soon</span>}
                </div>
                <p>{channel.description}</p>
              </div>
            </div>
            {provider?.implemented && !ready && <p className="sfa-channel__setup">Server setup needed: {provider.missingConfiguration.join(', ')}. See docs/oauth-setup.md.</p>}
            {provider && !provider.implemented && <p className="sfa-channel__setup">Coming next — the connection architecture is ready for this platform.</p>}
            {own.length > 0 && <ul className="sfa-connlist">
              {own.map((account) => <AccountRow key={account.id} account={account} busy={busy}
                checking={verify.isPending && verify.variables?.accountId === account.id}
                onVerify={() => verify.mutate({ accountId: account.id })}
                onDisconnect={async () => {
                  if (await confirm({ title: `Disconnect ${account.displayName}?`, description: 'Its stored tokens will be deleted.', confirmLabel: 'Disconnect', destructive: true })) disconnect.mutate({ accountId: account.id });
                }} />)}
            </ul>}
            <Button variant={own.length > 0 ? 'secondary' : 'primary'} className="sfa-channel__cta" disabled={!ready || isLoading} loading={isConnecting || (isLoading && ready)}
              icon={own.length > 0 && ready && !isConnecting && !isLoading ? <Plus size={14} /> : undefined}
              onClick={() => { setConnecting(channel.key); startConnection(channel.key as Platform); }} data-testid={`button-account-${channel.key}`}>
              {isConnecting ? 'Connecting…' : label} {own.length === 0 && ready && !isConnecting && !isLoading ? <ArrowRight size={14} /> : null}
            </Button>
          </article>;
        })}
      </div>
    </section>

    <section className="sfa-nextcard">
      <div><span className="sfa-eyebrow">Next up</span><h2>Once your channels are in, your calendar is ready.</h2><p>See every post, approval, and conversation in one connected view.</p></div>
      <a className="sfa-btn sfa-btn--primary sfa-btn--md" href="/#product">Explore the workspace <ArrowRight size={15} /></a>
    </section>

    {pendingId && <AccountPicker pendingId={pendingId} onClose={clearPending}
      onDone={(count, platform) => { clearPending(); refresh(); setNotice({ tone: 'success', text: `${count} ${platformNames[platform]} ${count === 1 ? 'account' : 'accounts'} connected.` }); }} />}
  </div>;
}

function Workspace() {
  return <AppShell active="accounts"><AccountsContent /></AppShell>;
}

function Footer() {
  return <footer className="sf-footer"><div className="sf-container"><div className="sf-footer__top"><div className="sf-footer__brand"><Logo /><p>Social media management for people who care about the work — and the rhythm it takes to make it.</p></div><div className="sf-footer__links"><div><h4>Explore</h4><a href="#product">Product</a><a href="#channels">Channels</a><a href="#pricing">Pricing</a></div><div><h4>Learn</h4><a href="#faq">FAQ</a><a href="#top">Customer stories</a><a href="#top">Notes</a></div><div><h4>Connect</h4><a href="mailto:balajibalu09@gmail.com">Contact</a><a href="#top">Instagram</a><a href="#top">LinkedIn</a></div></div></div><div className="sf-footer__bottom"><span>© 2026 SocialFlow</span><span className="sf-footer__legal"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/data-deletion">Data deletion</a></span></div></div></footer>;
}

 function SignupModal({ mode, onClose }: { mode: ModalMode; onClose: () => void }) {
  const [submitted, setSubmitted] = useState(false);
  const isDemo = mode === 'demo';
  return <div className="sf-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="sf-modal" role="dialog" aria-modal="true" aria-labelledby="signup-title"><button className="sf-modal__close" onClick={onClose} aria-label="Close dialog" data-testid="button-close-modal"><X size={18} /></button>{submitted ? <div className="sf-success" data-testid="status-form-success"><strong>{isDemo ? 'Your walkthrough is on the way.' : 'Your workspace is ready to begin.'}</strong><br />We will send the next step to your inbox shortly.</div> : <><span className="sf-kicker">{isDemo ? 'A thoughtful walkthrough' : '14 days, full flow'}</span><h2 id="signup-title">{isDemo ? 'See Socialflow in your rhythm.' : 'Make your first week flow.'}</h2><p>{isDemo ? 'Tell us a little about your team and we will tailor a quick, useful walkthrough.' : 'Start free with every workflow included. No card, no pressure, just a better place to plan.'}</p><form className="sf-form" onSubmit={(event) => { event.preventDefault(); setSubmitted(true); }}><label>Work email<input type="email" placeholder="you@yourcompany.com" required data-testid="input-work-email" /></label><label>What best describes you?<select defaultValue={isDemo ? 'Demo request' : ''} required data-testid="select-team-type"><option value="" disabled>Select one</option><option>Demo request</option><option>Creator</option><option>Agency</option><option>In-house team</option></select></label><button className="sf-button sf-button--primary" type="submit" data-testid="button-submit-signup">{isDemo ? 'Book my walkthrough' : 'Create my workspace'} <ArrowRight size={15} /></button></form></>}</div></div>;
}

function Home() {
  const [modal, setModal] = useState<ModalMode | null>(null);
  return <div className="sf-page"><Header onOpen={setModal} /><main><Hero onOpen={setModal} /><ProofStrip /><ProductStory /><Platforms /><Results /><Pricing onOpen={setModal} /><Testimonials /><FAQ /><CTA onOpen={setModal} /></main><Footer />{modal && <SignupModal mode={modal} onClose={() => setModal(null)} />}</div>;
}

function Router() {
  return <RoutedErrorBoundary><Suspense fallback={<div className="sfa-app" aria-busy="true" />}><Switch>
    <Route path="/" component={Home} />
    <Route path="/signin" component={SignIn} />
    <Route path="/privacy" component={PrivacyPage} />
    <Route path="/terms" component={TermsPage} />
    <Route path="/data-deletion" component={DataDeletionPage} />
    <Route path="/datadeletion" component={DataDeletionPage} />
    <Route path="/reset-password" component={ResetPassword} />
    <Route path="/dashboard">{() => <AppShell active="dashboard"><DashboardPage /></AppShell>}</Route>
    <Route path="/calendar">{() => <AppShell active="calendar"><CalendarPage /></AppShell>}</Route>
    <Route path="/posts">{() => <AppShell active="posts"><PostsPage /></AppShell>}</Route>
    <Route path="/drafts">{() => <AppShell active="drafts"><DraftsPage /></AppShell>}</Route>
    <Route path="/queue">{() => <AppShell active="queue"><QueuePage /></AppShell>}</Route>
    <Route path="/recurring">{() => <AppShell active="recurring"><RecurringPage /></AppShell>}</Route>
    <Route path="/automations">{() => <AppShell active="automations"><AutomationsPage /></AppShell>}</Route>
    <Route path="/settings">{() => <AppShell active="settings"><SettingsPage /></AppShell>}</Route>
    <Route path="/library">{() => <AppShell active="library"><LibraryPage /></AppShell>}</Route>
    <Route path="/analytics">{() => <AppShell active="analytics"><AnalyticsPage /></AppShell>}</Route>
    <Route path="/approvals">{() => <AppShell active="approvals"><ApprovalsPage /></AppShell>}</Route>
    <Route path="/ai">{() => <AppShell active="ai"><AiStudioPage /></AppShell>}</Route>
    <Route path="/team">{() => <AppShell active="team"><TeamPage /></AppShell>}</Route>
    <Route path="/accept-invite" component={AcceptInvitePage} />
    <Route path="/workspace" component={Workspace} />
    <Route component={NotFound} />
  </Switch></Suspense></RoutedErrorBoundary>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  // The theme (dark Aurora by default, or light) comes from the visitor's saved choice.
  useLayoutEffect(() => { applyTheme(); }, [location]);
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;