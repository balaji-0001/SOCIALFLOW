import { useMemo, useState, type ReactNode } from 'react';
import { format } from 'date-fns';
import { AlertTriangle, CircleCheck, Globe, Hash, ImagePlus, Info, MessageCircle, Play, Repeat2, Send, Share2, Smile, ThumbsUp, TrendingUp, Bookmark, Heart, Sparkles } from 'lucide-react';
import type { ButtonHTMLAttributes, ChangeEvent } from 'react';
import type { ConnectedAccount, Platform, PostLink } from '@workspace/api-client-react';
import { LinkCardView, useLinkImage } from './link-preview-card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AccountAvatar, PLATFORM_META, PlatformBadge } from './platforms';
import { addUtm, tokenizeForPreview, type UtmParams } from './composer-utils';
import { mediaProblemForPlatform, type RuleMedia } from './media-rules';
import { postLength } from './twitter-text';
import { Button } from './ui';

/* ------------------------------------------------------------------ */
/* Toolbar tools                                                       */
/* ------------------------------------------------------------------ */

const EMOJI_GROUPS: Array<{ label: string; emojis: string[] }> = [
  { label: 'Smileys', emojis: ['😀', '😄', '😁', '😂', '🥲', '😊', '😍', '🤩', '😎', '🤔', '😅', '🙌', '🥳', '😢', '😮', '🙃'] },
  { label: 'Gestures', emojis: ['👍', '👏', '🙏', '💪', '👀', '🤝', '✌️', '👋', '🫶', '🔥', '💯', '✅', '❤️', '💙', '✨', '🎉'] },
  { label: 'Work & news', emojis: ['📢', '📣', '📰', '📈', '📊', '💡', '🚀', '🎯', '🔔', '📌', '🗓️', '⏰', '🔗', '📷', '🎥', '🌍'] },
  { label: 'Symbols', emojis: ['➡️', '⬆️', '⭐', '⚡', '❗', '❓', '➕', '🔴', '🟢', '🔵', '☑️', '🏆', '🆕', '🔜', '💬', '📍'] },
];

function ToolButton({ label, children, ...rest }: { label: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className="sfa-tool" aria-label={label} title={label} {...rest}>{children}</button>;
}

export function EmojiPicker({ onPick, disabled }: { onPick: (emoji: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><ToolButton label="Add emoji" disabled={disabled} data-testid="tool-emoji"><Smile size={17} /></ToolButton></PopoverTrigger>
    <PopoverContent className="sfa-popcard sfa-emoji" align="start" data-testid="popover-emoji">
      {EMOJI_GROUPS.map((group) => <section key={group.label} aria-label={group.label}>
        <h4>{group.label}</h4>
        <div className="sfa-emoji__grid">
          {group.emojis.map((emoji) => <button key={emoji} type="button" onClick={() => { onPick(emoji); setOpen(false); }} aria-label={`Insert ${emoji}`}>{emoji}</button>)}
        </div>
      </section>)}
    </PopoverContent>
  </Popover>;
}

export function HashtagPicker({ recent, onInsert, disabled }: { recent: string[]; onInsert: (tag: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const submit = () => { if (custom.trim()) { onInsert(custom.trim()); setCustom(''); setOpen(false); } };
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><ToolButton label="Add hashtag" disabled={disabled} data-testid="tool-hashtag"><Hash size={17} /></ToolButton></PopoverTrigger>
    <PopoverContent className="sfa-popcard" align="start" data-testid="popover-hashtag">
      <label className="sfa-popcard__field">Hashtag
        <span className="sfa-popcard__row">
          <input className="sfa-input" value={custom} placeholder="e.g. productlaunch" onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} data-testid="input-hashtag" />
          <Button size="sm" variant="primary" disabled={!custom.trim()} onClick={submit} data-testid="button-add-hashtag">Add</Button>
        </span>
      </label>
      <h4>From your recent posts</h4>
      {recent.length === 0
        ? <p className="sfa-muted">Hashtags you use in posts will show up here for one-click reuse.</p>
        : <div className="sfa-chips">{recent.map((tag) => <button key={tag} type="button" className="sfa-tagchip" onClick={() => { onInsert(tag); setOpen(false); }} data-testid={`recent-hashtag-${tag}`}>#{tag}</button>)}</div>}
    </PopoverContent>
  </Popover>;
}

export function UtmPopover({ links, onApply, disabled }: { links: string[]; onApply: (params: UtmParams) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [params, setParams] = useState<UtmParams>({ source: 'socialflow', medium: 'social', campaign: '', term: '', content: '' });
  const set = (key: keyof UtmParams) => (event: ChangeEvent<HTMLInputElement>) => setParams((p) => ({ ...p, [key]: event.target.value }));
  const example = links[0] ? addUtm(links[0], params) : '';
  const canApply = links.length > 0 && params.source.trim() !== '' && params.medium.trim() !== '' && params.campaign.trim() !== '';
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><ToolButton label={links.length ? 'Add UTM tracking to links' : 'Add UTM tracking (add a link first)'} disabled={disabled || links.length === 0} data-testid="tool-utm"><span className="sfa-tool__text">UTM</span></ToolButton></PopoverTrigger>
    <PopoverContent className="sfa-popcard sfa-utm" align="start" data-testid="popover-utm">
      <p className="sfa-muted">Adds tracking parameters to {links.length === 1 ? 'the link' : `all ${links.length} links`} in your post so you can see where traffic came from.</p>
      <label className="sfa-popcard__field">Source<input className="sfa-input" value={params.source} onChange={set('source')} data-testid="utm-source" /></label>
      <label className="sfa-popcard__field">Medium<input className="sfa-input" value={params.medium} onChange={set('medium')} data-testid="utm-medium" /></label>
      <label className="sfa-popcard__field">Campaign<input className="sfa-input" value={params.campaign} placeholder="spring-launch" onChange={set('campaign')} data-testid="utm-campaign" /></label>
      <div className="sfa-popcard__two">
        <label className="sfa-popcard__field">Term <span className="sfa-muted">(optional)</span><input className="sfa-input" value={params.term ?? ''} onChange={set('term')} /></label>
        <label className="sfa-popcard__field">Content <span className="sfa-muted">(optional)</span><input className="sfa-input" value={params.content ?? ''} onChange={set('content')} /></label>
      </div>
      {example && <p className="sfa-utm__example" aria-live="polite"><span className="sfa-muted">Result</span>{example}</p>}
      <Button variant="primary" disabled={!canApply} onClick={() => { onApply(params); setOpen(false); }} data-testid="button-apply-utm">Apply to {links.length === 1 ? 'link' : 'all links'}</Button>
    </PopoverContent>
  </Popover>;
}

/** Opens the file picker of the media uploader below the editor. */
export function MediaTool({ onClick, disabled, count }: { onClick: () => void; disabled?: boolean; count: number }) {
  return <ToolButton label={count > 0 ? `Add more images or video (${count} attached)` : 'Add images or video'} disabled={disabled} onClick={onClick} data-testid="tool-media"><ImagePlus size={17} /></ToolButton>;
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export function AccountSelector({ accounts, selected, locked, loading, onToggle, onSetAll }: {
  accounts: ConnectedAccount[]; selected: Set<string>; locked: boolean; loading: boolean;
  onToggle: (id: string) => void; onSetAll: (ids: string[]) => void;
}) {
  const usable = accounts.filter((account) => account.status === 'active');
  const allOn = usable.length > 0 && usable.every((account) => selected.has(account.id));
  if (loading) return <div className="sfa-accountpick" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} className="sfa-skel" style={{ width: 150, height: 42, borderRadius: 999 }} />)}</div>;
  if (accounts.length === 0) return <p className="sfa-empty-note">No accounts connected yet. <a href="/workspace">Connect an account</a> to start scheduling.</p>;
  return <>
    {!locked && usable.length > 1 && <div className="sfa-selectbar">
      <button type="button" className="sfa-linkbtn" onClick={() => onSetAll(allOn ? [] : usable.map((a) => a.id))} data-testid="button-select-all">{allOn ? 'Clear selection' : 'Select all'}</button>
    </div>}
    <ul className="sfa-accountpick">
      {accounts.map((account) => {
        const healthy = account.status === 'active';
        const on = selected.has(account.id);
        const meta = PLATFORM_META[account.platform];
        return <li key={account.id}>
          <button type="button" className={`sfa-acctchip ${on ? 'is-on' : ''}`} disabled={locked || (!healthy && !on)} aria-pressed={on}
            onClick={() => onToggle(account.id)} title={healthy ? `${account.displayName} · ${meta.name}` : 'Reconnect this account before posting to it'} data-testid={`chip-account-${account.id}`}>
            <AccountAvatar account={account} size={32} />
            <span className="sfa-acctchip__name">{account.displayName}</span>
            {!healthy && <span className="sfa-acctchip__warn">Reconnect</span>}
            {on && <CircleCheck size={15} className="sfa-acctchip__check" aria-hidden />}
          </button>
        </li>;
      })}
    </ul>
  </>;
}

/* ------------------------------------------------------------------ */
/* Detected links, hashtags, media panel                               */
/* ------------------------------------------------------------------ */

/** Hashtags found in the text. Links get the Link Preview card below the editor instead. */
export function DetectedItems({ hashtags }: { links?: string[]; hashtags: string[] }) {
  if (hashtags.length === 0) return null;
  return <div className="sfa-detected" data-testid="detected-items">
    <div className="sfa-detected__row">
      <span className="sfa-detected__label"><Hash size={13} /> {hashtags.length} {hashtags.length === 1 ? 'hashtag' : 'hashtags'}</span>
      {hashtags.map((tag) => <span key={tag} className="sfa-tagchip" data-testid="detected-hashtag">#{tag}</span>)}
    </div>
  </div>;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type Check = { level: 'ok' | 'info' | 'warn' | 'error'; text: string };
export type PlatformCheck = { platform: Platform; used: number; limit: number; checks: Check[] };

const INSTAGRAM_HASHTAG_LIMIT = 30;

function describeMedia(media: RuleMedia[]): string {
  const videos = media.filter((item) => item.kind === 'video').length;
  const images = media.length - videos;
  const parts = [images > 0 ? `${images} ${images === 1 ? 'image' : 'images'}` : null, videos > 0 ? `${videos} ${videos === 1 ? 'video' : 'videos'}` : null].filter(Boolean);
  return `${parts.join(' and ')} will be posted with the text.`;
}

export type TextByPlatform = string | ((platform: Platform) => string);
const resolveText = (text: TextByPlatform, platform: Platform) => (typeof text === 'string' ? text : text(platform));

export function computePlatformChecks(accounts: ConnectedAccount[], text: TextByPlatform, hashtagCount: number, media: RuleMedia[] = [], hasLinkImage = false): PlatformCheck[] {
  const platforms = [...new Set(accounts.map((account) => account.platform))];
  return platforms.map((platform) => {
    const meta = PLATFORM_META[platform];
    const content = resolveText(text, platform);
    const used = postLength(platform, content);
    const checks: Check[] = [];
    if (used > meta.charLimit) checks.push({ level: 'error', text: `${(used - meta.charLimit).toLocaleString()} characters over the ${meta.charLimit.toLocaleString()} limit.` });
    else if (used > meta.charLimit * 0.9) checks.push({ level: 'warn', text: `Close to the ${meta.charLimit.toLocaleString()} character limit.` });
    else if (used > 0) checks.push({ level: 'ok', text: 'Length is within the limit.' });
    if (platform === 'twitter' && used !== content.length) checks.push({ level: 'info', text: 'X counts every link as 23 characters and an emoji as 2, so its count differs from the number of characters typed.' });
    if (platform === 'youtube' && /[<>]/.test(content)) checks.push({ level: 'error', text: 'YouTube doesn’t allow < or > in a title or description.' });
    if (platform === 'youtube' && content.trim()) checks.push({ level: 'info', text: 'The first line becomes the video title (up to 100 characters); the whole text is the description. Videos upload as private until you make them public in YouTube Studio.' });
    const mediaProblem = mediaProblemForPlatform(platform, media, { hasLinkImage });
    if (mediaProblem) checks.push({ level: 'error', text: mediaProblem });
    else if (media.length > 0) checks.push({ level: 'ok', text: describeMedia(media) });
    else if (platform === 'instagram' && hasLinkImage) checks.push({ level: 'info', text: 'Instagram will use the link’s preview picture as the post’s photo (Instagram captions can’t hold a clickable link).' });
    if (platform === 'instagram' && hashtagCount > INSTAGRAM_HASHTAG_LIMIT) checks.push({ level: 'warn', text: `Instagram allows up to ${INSTAGRAM_HASHTAG_LIMIT} hashtags.` });
    const unhealthy = accounts.filter((account) => account.platform === platform && account.status !== 'active');
    for (const account of unhealthy) checks.push({ level: 'error', text: `${account.displayName} needs to be reconnected.` });
    return { platform, used, limit: meta.charLimit, checks };
  });
}

const CHECK_ICON = { ok: CircleCheck, info: Info, warn: AlertTriangle, error: AlertTriangle } as const;

export function ChecksPanel({ results }: { results: PlatformCheck[] }) {
  if (results.length === 0) return <p className="sfa-muted" data-testid="checks-empty">Choose an account to see what each network allows.</p>;
  return <ul className="sfa-checks" data-testid="checks">
    {results.map((result) => {
      const meta = PLATFORM_META[result.platform];
      const ratio = Math.min(result.used / result.limit, 1);
      const worst = result.checks.some((c) => c.level === 'error') ? 'error' : result.checks.some((c) => c.level === 'warn') ? 'warn' : 'ok';
      return <li key={result.platform} className={`sfa-check sfa-check--${worst}`} data-testid={`check-${result.platform}`}>
        <div className="sfa-check__head">
          <PlatformBadge platform={result.platform} size={16} />
          <strong>{meta.name}</strong>
          <span className="sfa-num sfa-muted">{result.used.toLocaleString()} / {result.limit.toLocaleString()}</span>
        </div>
        <div className="sfa-meter sfa-meter--wide" role="img" aria-label={`${Math.round(ratio * 100)}% of the ${meta.name} character limit used`}><span style={{ width: `${ratio * 100}%` }} /></div>
        {result.checks.map((check, index) => {
          const Icon = CHECK_ICON[check.level];
          return <p key={index} className={`sfa-check__msg sfa-check__msg--${check.level}`}><Icon size={13} aria-hidden /> {check.text}</p>;
        })}
      </li>;
    })}
  </ul>;
}

/* ------------------------------------------------------------------ */
/* Live previews (original designs, driven by the real text + account)  */
/* ------------------------------------------------------------------ */

function PreviewText({ text, placeholder }: { text: string; placeholder: string }) {
  if (!text.trim()) return <p className="sfa-pv__text is-placeholder">{placeholder}</p>;
  return <p className="sfa-pv__text">{tokenizeForPreview(text).map((token, index) =>
    token.type === 'text' ? <span key={index}>{token.value}</span> : <span key={index} className={token.type === 'url' ? 'sfa-pv__link' : 'sfa-pv__tag'}>{token.value}</span>)}</p>;
}

export type PreviewMediaItem = { kind: 'image' | 'video'; src: string; poster: string | null; count: number };

/** The first attached file, as this network would frame it. */
function PreviewMedia({ media }: { media: PreviewMediaItem }) {
  return <div className="sfa-pv__media sfa-pv__media--real" data-testid="preview-media">
    {media.kind === 'image'
      ? <img src={media.src} alt="First attached image" />
      : media.poster ? <img src={media.poster} alt="First attached video" /> : <video src={media.src} muted preload="metadata" aria-label="First attached video" />}
    {media.kind === 'video' && <span className="sfa-pv__play" aria-hidden><Play size={20} /></span>}
    {media.count > 1 && <span className="sfa-pv__more" data-testid="preview-media-count">+{media.count - 1}</span>}
  </div>;
}

function NeedsMediaBox({ platform, media }: { platform: 'instagram' | 'youtube'; media: PreviewMediaItem | null }) {
  if (media) return <PreviewMedia media={media} />;
  return <div className="sfa-pv__media" data-testid={`preview-needs-media-${platform}`}>
    {platform === 'youtube' ? <Play size={26} /> : <ImagePlus size={26} />}
    <span>{platform === 'youtube' ? 'A video is required' : 'An image or video is required'}</span>
    <small>Add it in the uploader below the editor</small>
  </div>;
}

function FacebookPreview({ account, text, when, media, link }: { account: ConnectedAccount; text: string; when: string; media: PreviewMediaItem | null; link?: PostLink | null }) {
  return <article className="sfa-pv sfa-pv--facebook" data-testid="preview-facebook">
    <header><AccountAvatar account={account} size={40} /><div><strong>{account.displayName}</strong><span>{when} · <Globe size={11} aria-label="Public" /></span></div></header>
    <PreviewText text={text} placeholder="Your post will appear here." />
    {media && <PreviewMedia media={media} />}
    {!media && link && <LinkCardView link={link} />}
    <footer><span><ThumbsUp size={15} /> Like</span><span><MessageCircle size={15} /> Comment</span><span><Share2 size={15} /> Share</span></footer>
  </article>;
}

function LinkedInPreview({ account, text, when, media, link }: { account: ConnectedAccount; text: string; when: string; media: PreviewMediaItem | null; link?: PostLink | null }) {
  return <article className="sfa-pv sfa-pv--linkedin" data-testid="preview-linkedin">
    <header><AccountAvatar account={account} size={44} /><div><strong>{account.displayName}</strong><span>{when} · <Globe size={11} aria-label="Public" /></span></div></header>
    <PreviewText text={text} placeholder="Your post will appear here." />
    {media && <PreviewMedia media={media} />}
    {!media && link && <LinkCardView link={link} />}
    <footer><span><ThumbsUp size={15} /> Like</span><span><MessageCircle size={15} /> Comment</span><span><Repeat2 size={15} /> Repost</span><span><Send size={15} /> Send</span></footer>
  </article>;
}

function InstagramPreview({ account, text, media, link }: { account: ConnectedAccount; text: string; media: PreviewMediaItem | null; link?: PostLink | null }) {
  // No clickable link on Instagram: with nothing attached, the link's preview picture is what gets posted.
  const linkImage = useLinkImage(!media ? link?.imageUrl : null);
  const linkPhoto = linkImage.src;
  return <article className="sfa-pv sfa-pv--instagram" data-testid="preview-instagram">
    <header><AccountAvatar account={account} size={32} /><strong>{account.username ?? account.displayName}</strong></header>
    {linkPhoto
      ? <div className="sfa-pv__media sfa-pv__media--real" data-testid="preview-link-photo"><img src={linkPhoto} alt="The link’s preview picture, posted as the photo" referrerPolicy="no-referrer" onError={linkImage.onError} /></div>
      : <NeedsMediaBox platform="instagram" media={media} />}
    <div className="sfa-pv__actions"><Heart size={20} /><MessageCircle size={20} /><Send size={20} /><Bookmark size={20} className="sfa-pv__push" /></div>
    <div className="sfa-pv__caption"><strong>{account.username ?? account.displayName}</strong> <PreviewText text={text} placeholder="Your caption will appear here." /></div>
  </article>;
}

function TwitterPreview({ account, text, when, media, link }: { account: ConnectedAccount; text: string; when: string; media: PreviewMediaItem | null; link?: PostLink | null }) {
  return <article className="sfa-pv sfa-pv--twitter" data-testid="preview-twitter">
    <header><AccountAvatar account={account} size={40} /><div><strong>{account.displayName}</strong><span>{account.username ? `@${account.username} · ` : ''}{when}</span></div></header>
    <PreviewText text={text} placeholder="Your post will appear here." />
    {media && <PreviewMedia media={media} />}
    {/* X builds the card from the page the link points to; this shows the composer's version of it. */}
    {!media && link && <LinkCardView link={link} />}
    <footer><span><MessageCircle size={15} /> Reply</span><span><Repeat2 size={15} /> Repost</span><span><Heart size={15} /> Like</span><span><Bookmark size={15} /> Bookmark</span></footer>
  </article>;
}

function YouTubePreview({ account, text, media }: { account: ConnectedAccount; text: string; media: PreviewMediaItem | null }) {
  return <article className="sfa-pv sfa-pv--youtube" data-testid="preview-youtube">
    <NeedsMediaBox platform="youtube" media={media} />
    <header><AccountAvatar account={account} size={36} /><div><strong>{text.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 100) || 'Video title'}</strong><span>{account.displayName}</span></div></header>
    <PreviewText text={text} placeholder="Your video description will appear here." />
  </article>;
}

export function PreviewPanel({ accounts, content: text, when, media = null, link = null }: { accounts: ConnectedAccount[]; content: TextByPlatform; when: Date | null; media?: PreviewMediaItem | null; link?: PostLink | null }) {
  const platforms = useMemo(() => [...new Set(accounts.map((account) => account.platform))], [accounts]);
  const [chosen, setChosen] = useState<Platform | null>(null);
  const active = chosen && platforms.includes(chosen) ? chosen : platforms[0];
  const content = active ? resolveText(text, active) : '';
  if (!active) {
    return <div className="sfa-pv-empty" data-testid="preview-empty"><Sparkles size={20} aria-hidden /><strong>Live preview</strong><p>Choose an account to see how your post will look on each network.</p></div>;
  }
  const account = accounts.find((a) => a.platform === active)!;
  const sameNetwork = accounts.filter((a) => a.platform === active).length;
  const whenLabel = when ? format(when, 'MMM d · h:mm a') : 'Just now';
  return <div className="sfa-pvpanel">
    <div className="sfa-pvtabs" role="tablist" aria-label="Preview network">
      {platforms.map((platform) => <button key={platform} role="tab" type="button" aria-selected={platform === active} className={platform === active ? 'is-on' : ''} onClick={() => setChosen(platform)} data-testid={`preview-tab-${platform}`}>
        <PlatformBadge platform={platform} size={14} /> {PLATFORM_META[platform].name}
      </button>)}
    </div>
    <div role="tabpanel" aria-label={`${PLATFORM_META[active].name} preview`}>
      {active === 'facebook' && <FacebookPreview account={account} text={content} when={whenLabel} media={media} link={link} />}
      {active === 'linkedin' && <LinkedInPreview account={account} text={content} when={whenLabel} media={media} link={link} />}
      {active === 'instagram' && <InstagramPreview account={account} text={content} media={media} link={link} />}
      {active === 'youtube' && <YouTubePreview account={account} text={content} media={media} />}
      {active === 'twitter' && <TwitterPreview account={account} text={content} when={whenLabel} media={media} link={link} />}
    </div>
    <p className="sfa-muted sfa-pvpanel__note"><TrendingUp size={12} aria-hidden /> Approximate. Each network may render your post slightly differently.{sameNetwork > 1 ? ` Showing ${account.displayName}; the same text goes to ${sameNetwork} ${PLATFORM_META[active].name} accounts.` : ''}</p>
  </div>;
}

