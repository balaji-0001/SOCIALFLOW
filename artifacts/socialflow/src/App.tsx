import { useState } from 'react';
import { ArrowRight, ArrowUpRight, BarChart3, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, Inbox, Menu, PenLine, Play, Plus, Send, Sparkles, Users, X, Zap } from 'lucide-react';
import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  return <RoutedErrorBoundary><Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;