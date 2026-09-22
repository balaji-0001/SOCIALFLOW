import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, ArrowUpRight, BarChart3, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, Inbox, Menu, PenLine, Play, Plus, RefreshCw, Send, ShieldCheck, Sparkles, Users, X, Zap } from 'lucide-react';
import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { type ConnectedAccount, type Platform, getGetPendingConnectionQueryKey, getListConnectedAccountsQueryKey, useCancelPendingConnection, useCompletePendingConnection, useDisconnectAccount, useGetPendingConnection, useListConnectedAccounts, useListConnectionProviders, useVerifyConnectedAccount } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();

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
          <a className="sf-nav__item sf-nav__item--workspace" href="/workspace" data-testid="link-workspace">Workspace</a>
        </nav>
        <div className="sf-header__actions">
          <button className="sf-login" onClick={() => onOpen('demo')} data-testid="button-login">Sign in</button>
          <button className="sf-button sf-button--primary sf-button--small" onClick={() => onOpen('trial')} data-testid="button-header-trial">Start free</button>
        </div>
        <button className="sf-menu-toggle" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Toggle menu" data-testid="button-mobile-menu">
          {mobileOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
      {mobileOpen && <div className="sf-mobile-nav">
        {menuItems.map((item) => <div key={item.label}><button onClick={() => setOpenMenu(openMenu === item.label ? null : item.label)} data-testid={`button-mobile-${item.label.toLowerCase()}`}>{item.label}<ChevronDown size={13} /></button>{openMenu === item.label && <div className="sf-mobile-nav__links">{item.links.map(([title]) => <a key={title} href="#product" onClick={closeMenu}>{title}</a>)}</div>}</div>)}
         <a href="#pricing" onClick={closeMenu} data-testid="link-mobile-pricing">Pricing</a>
         <a href="/workspace" onClick={closeMenu} data-testid="link-mobile-workspace">Workspace</a>
        <button onClick={() => { closeMenu(); onOpen('trial'); }} data-testid="button-mobile-trial">Start free</button>
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
  window.location.assign(`/api/connections/${platform}/start${query}`);
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

function AccountRow({ account, busy, onVerify, onDisconnect }: { account: ConnectedAccount; busy: boolean; onVerify: () => void; onDisconnect: () => void }) {
  const healthy = account.status === 'active';
  return <li className={`sf-connected ${healthy ? '' : 'is-unhealthy'}`} data-testid={`row-account-${account.id}`}>
    {account.avatarUrl ? <img className="sf-connected__avatar" src={account.avatarUrl} alt="" /> : <span className="sf-connected__avatar">{account.displayName.slice(0, 1)}</span>}
    <div className="sf-connected__copy">
      <strong>{account.displayName}</strong>
      <span className={`sf-connected__status sf-connected__status--${account.status}`}>{healthy ? <Check size={11} /> : <AlertTriangle size={11} />} {statusCopy[account.status]}</span>
      {!healthy && account.statusDetail && <span className="sf-connected__detail">{account.statusDetail}</span>}
    </div>
    <div className="sf-connected__actions">
      {healthy
        ? <button onClick={onVerify} disabled={busy} title="Check the token with the provider" data-testid={`button-verify-${account.id}`}><RefreshCw size={13} /> Check</button>
        : <button className="is-primary" onClick={() => startConnection(account.platform, account.id)} data-testid={`button-reconnect-${account.id}`}><RefreshCw size={13} /> Reconnect</button>}
      <button onClick={onDisconnect} disabled={busy} data-testid={`button-disconnect-${account.id}`}><X size={13} /> Disconnect</button>
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

  return <div className="sf-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="sf-modal sf-picker" role="dialog" aria-modal="true" aria-labelledby="picker-title">
      <button className="sf-modal__close" onClick={close} aria-label="Close dialog" data-testid="button-close-picker"><X size={18} /></button>
      <span className="sf-kicker">Choose accounts</span>
      <h2 id="picker-title">Which {data ? accountNouns[data.platform] : 'accounts'} should Socialflow manage?</h2>
      {isLoading && <p>Loading the accounts you shared…</p>}
      {error && <p className="sf-picker__error">This selection expired. Start the connection again.</p>}
      {data && <>
        <p>These came back from {name}. Pick the ones you want in this workspace — you can add or remove them later.</p>
        <ul className="sf-picker__list">
          {data.candidates.map((candidate) => {
            const disabled = !candidate.selectable;
            return <li key={candidate.externalAccountId}>
              <label className={disabled ? 'is-disabled' : ''} data-testid={`option-candidate-${candidate.externalAccountId}`}>
                <input type="checkbox" disabled={disabled} checked={choices.includes(candidate.externalAccountId)} onChange={() => toggle(candidate.externalAccountId)} />
                {candidate.avatarUrl ? <img src={candidate.avatarUrl} alt="" /> : <span className="sf-connected__avatar">{candidate.displayName.slice(0, 1)}</span>}
                <span className="sf-picker__copy"><strong>{candidate.displayName}</strong>
                  {candidate.alreadyConnected && <small>Already connected — selecting it refreshes its token.</small>}
                  {candidate.warnings.map((warning) => <small className="is-warning" key={warning}>{warning}</small>)}
                </span>
              </label>
            </li>;
          })}
        </ul>
        {complete.error && <p className="sf-picker__error">{complete.error.data?.message ?? 'Could not connect those accounts.'}</p>}
        <button className="sf-button sf-button--primary" disabled={choices.length === 0 || complete.isPending} data-testid="button-confirm-accounts"
          onClick={() => complete.mutate({ pendingId, data: { externalAccountIds: choices } }, { onSuccess: (result) => onDone(result.accounts.length, data.platform) })}>
          {complete.isPending ? 'Connecting…' : `Connect ${choices.length} ${choices.length === 1 ? 'account' : 'accounts'}`} <ArrowRight size={15} />
        </button>
      </>}
    </div>
  </div>;
}

function Workspace() {
  const queryClient = useQueryClient();
  const { notice, setNotice, pendingId, clearPending } = useConnectionResult();
  const { data: providerData } = useListConnectionProviders();
  const { data: accountData, isLoading } = useListConnectedAccounts();
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListConnectedAccountsQueryKey() });
  const disconnect = useDisconnectAccount({ mutation: { onSuccess: refresh } });
  const verify = useVerifyConnectedAccount({ mutation: { onSuccess: refresh, onError: (error) => setNotice({ tone: 'error', text: error.data?.message ?? 'The check failed.' }) } });
  const accounts = accountData?.accounts ?? [];
  const providers = new Map((providerData?.providers ?? []).map((provider) => [provider.platform, provider]));
  const connectedCount = accounts.length;
  const busy = disconnect.isPending || verify.isPending;

  return <div className="sf-workspace">
    <header className="sf-workspace__header">
      <div className="sf-container sf-workspace__header-inner">
        <Logo />
        <div className="sf-workspace__header-actions">
          <span className="sf-workspace__avatar">NS</span>
          <a className="sf-workspace__back" href="/">Back to site <ArrowUpRight size={14} /></a>
        </div>
      </div>
    </header>
    <main className="sf-workspace__main">
      <div className="sf-container">
        {notice
          ? <div className={`sf-workspace__notice sf-workspace__notice--${notice.tone}`} role="status" data-testid="status-connection"><span className="sf-workspace__notice-dot" /> {notice.text}<button onClick={() => setNotice(null)} aria-label="Dismiss"><X size={14} /></button></div>
          : <div className="sf-workspace__notice"><span className="sf-workspace__notice-dot" /> Accounts connect through each platform's official OAuth. Socialflow never sees your passwords.</div>}
        <div className="sf-workspace__intro">
          <div>
            <span className="sf-kicker">Workspace setup</span>
            <h1 className="sf-display">Bring your channels<br /><em>into the flow.</em></h1>
            <p>Connect the places your audience already checks in. Once they are together, planning gets clearer and publishing gets lighter.</p>
          </div>
          <div className="sf-workspace__summary">
            <span className="sf-workspace__summary-label">Connected accounts</span>
            <strong>{connectedCount}</strong>
            <span className="sf-workspace__summary-note">{connectedCount === 0 ? 'Start with your most important channel.' : 'Your workspace is taking shape.'}</span>
          </div>
        </div>
        <section className="sf-accounts" aria-labelledby="accounts-title">
          <div className="sf-accounts__head">
            <div><span className="sf-kicker">Your channels</span><h2 id="accounts-title">Connect your social accounts.</h2></div>
            <span className="sf-accounts__secure"><ShieldCheck size={13} /> Tokens encrypted, private to your workspace</span>
          </div>
          <div className="sf-account-grid">
            {channelOptions.map((channel) => {
              const provider = channel.key === 'x' ? undefined : providers.get(channel.key);
              const own = accounts.filter((account) => account.platform === channel.key);
              const ready = Boolean(provider?.configured);
              let label = 'Not available yet';
              if (provider?.implemented && !ready) label = 'Setup required';
              if (ready) label = own.length > 0 ? 'Add another' : 'Connect account';
              if (isLoading && ready) label = 'Checking…';
              return <article className={`sf-account-card ${own.length > 0 ? 'is-connected' : ''}`} key={channel.key} data-testid={`card-account-${channel.key}`}>
                <div className="sf-account-card__top">
                  <div className={`sf-account-mark sf-account-mark--${channel.tone}`}>{channel.mark}</div>
                  <div className="sf-account-card__copy">
                    <div className="sf-account-card__title"><h3>{channel.name}</h3>{own.length > 0 && <span className="sf-account-status"><Check size={12} /> {own.length} connected</span>}</div>
                    <p>{channel.description}</p>
                    {provider?.implemented && !ready && <p className="sf-account-card__setup">Server setup needed: {provider.missingConfiguration.join(', ')}. See docs/oauth-setup.md.</p>}
                    {provider && !provider.implemented && <p className="sf-account-card__setup">Coming next — the connection architecture is ready for this platform.</p>}
                  </div>
                </div>
                {own.length > 0 && <ul className="sf-connected-list">
                  {own.map((account) => <AccountRow key={account.id} account={account} busy={busy}
                    onVerify={() => verify.mutate({ accountId: account.id })}
                    onDisconnect={() => { if (window.confirm(`Disconnect ${account.displayName}? Its stored tokens will be deleted.`)) disconnect.mutate({ accountId: account.id }); }} />)}
                </ul>}
                <button className={`sf-account-card__button ${own.length > 0 ? 'is-connected' : ''}`} disabled={!ready || isLoading} onClick={() => startConnection(channel.key as Platform)} data-testid={`button-account-${channel.key}`}>
                  {own.length > 0 && ready ? <Plus size={14} /> : null} {label} {own.length === 0 && ready ? <ArrowRight size={14} /> : null}
                </button>
              </article>;
            })}
          </div>
        </section>
        <section className="sf-workspace__next">
          <div><span className="sf-kicker">Next up</span><h2>Once your channels are in, your calendar is ready.</h2><p>See every post, approval, and conversation in one connected view.</p></div>
          <a className="sf-button sf-button--primary" href="/#product">Explore the workspace <ArrowRight size={15} /></a>
        </section>
      </div>
    </main>
    {pendingId && <AccountPicker pendingId={pendingId} onClose={clearPending}
      onDone={(count, platform) => { clearPending(); refresh(); setNotice({ tone: 'success', text: `${count} ${platformNames[platform]} ${count === 1 ? 'account' : 'accounts'} connected.` }); }} />}
  </div>;
}

function Footer() {
  return <footer className="sf-footer"><div className="sf-container"><div className="sf-footer__top"><div className="sf-footer__brand"><Logo /><p>Social media management for people who care about the work — and the rhythm it takes to make it.</p></div><div className="sf-footer__links"><div><h4>Explore</h4><a href="#product">Product</a><a href="#channels">Channels</a><a href="#pricing">Pricing</a></div><div><h4>Learn</h4><a href="#faq">FAQ</a><a href="#top">Customer stories</a><a href="#top">Notes</a></div><div><h4>Connect</h4><a href="mailto:hello@socialflow.example">Contact</a><a href="#top">Instagram</a><a href="#top">LinkedIn</a></div></div></div><div className="sf-footer__bottom"><span>© 2025 Socialflow, Inc.</span><span>Made for better Mondays.</span></div></div></footer>;
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
  return <RoutedErrorBoundary><Switch><Route path="/" component={Home} /><Route path="/workspace" component={Workspace} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;