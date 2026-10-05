import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Info, Link2, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import { getGetLinkPreviewQueryKey, useGetLinkPreview, type Platform, type PostLink } from '@workspace/api-client-react';
import { findUrls } from './composer-utils';
import './link-preview.css';

/* Composer link preview: detects the first link in the text, fetches its preview once, and keeps the (editable) card. */

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return url; }
}

/** Identifies a page ignoring utm_* tracking, so adding tracking to a link isn't treated as a different link. */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) if (key.toLowerCase().startsWith('utm_')) parsed.searchParams.delete(key);
    parsed.hash = '';
    return parsed.toString();
  } catch { return url; }
}

export function normalizeLink(link: PostLink | null | undefined): PostLink | null {
  if (!link) return null;
  return { url: link.url, title: link.title ?? null, description: link.description ?? null, imageUrl: link.imageUrl ?? null };
}

const DEBOUNCE_MS = 700;

export function useLinkPreview({ text, initialLink, disabled }: { text: string; initialLink: PostLink | null; disabled: boolean }) {
  const firstUrl = useMemo(() => findUrls(text)[0]?.value ?? null, [text]);
  const [link, setLink] = useState<PostLink | null>(() => normalizeLink(initialLink));
  const [debouncedUrl, setDebouncedUrl] = useState<string | null>(firstUrl);
  // Editing a post that had its card removed must not bring it back on its own.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set(!initialLink && firstUrl ? [pageKey(firstUrl)] : []));
  const pasted = useRef(false);

  useEffect(() => {
    if (firstUrl === debouncedUrl) return;
    const wait = pasted.current || firstUrl === null ? 0 : DEBOUNCE_MS;
    pasted.current = false;
    const handle = window.setTimeout(() => setDebouncedUrl(firstUrl), wait);
    return () => window.clearTimeout(handle);
  }, [firstUrl, debouncedUrl]);

  // Tracking added to the link in the text carries over to the card straight away.
  useEffect(() => {
    if (link && firstUrl && firstUrl !== link.url && pageKey(firstUrl) === pageKey(link.url)) setLink({ ...link, url: firstUrl });
  }, [firstUrl, link]);

  // A different link (or none) in the text replaces the card once typing settles.
  useEffect(() => {
    if (!link) return;
    if (debouncedUrl === null || pageKey(debouncedUrl) !== pageKey(link.url)) setLink(null);
  }, [debouncedUrl, link]);

  const wanted = !disabled && debouncedUrl !== null && !dismissed.has(pageKey(debouncedUrl)) && !link;
  const query = useGetLinkPreview({ url: debouncedUrl ?? '' }, {
    query: { queryKey: getGetLinkPreviewQueryKey({ url: debouncedUrl ?? '' }), enabled: wanted, staleTime: 10 * 60_000, retry: false, refetchOnWindowFocus: false },
  });

  useEffect(() => {
    if (!wanted || !query.data || !debouncedUrl) return;
    setLink({ url: debouncedUrl, title: query.data.title, description: query.data.description, imageUrl: query.data.imageUrl });
  }, [wanted, query.data, debouncedUrl]);

  // The page's other pictures, so the user can pick one for the card. Only known for a card fetched in this session
  // (a saved or restored card keeps just the picture it was saved with).
  const imageChoices = useMemo(() => {
    if (!link || !query.data || !debouncedUrl || pageKey(debouncedUrl) !== pageKey(link.url)) return link?.imageUrl ? [link.imageUrl] : [];
    const list = query.data.imageUrls ?? [];
    return link.imageUrl && !list.includes(link.imageUrl) ? [link.imageUrl, ...list] : list;
  }, [link, query.data, debouncedUrl]);

  const errorMessage = wanted && query.isError ? ((query.error as { data?: { message?: string } | null } | null)?.data?.message ?? (query.error as Error | null)?.message ?? 'Please try again.') : null;

  const dismiss = () => {
    const target = link?.url ?? debouncedUrl;
    if (target) setDismissed((current) => new Set(current).add(pageKey(target)));
    setLink(null);
  };

  /** The card as it should be saved: only while its link is still the one in the text. */
  const payload: PostLink | null = link && firstUrl && pageKey(firstUrl) === pageKey(link.url) ? { ...link, url: firstUrl } : null;

  // A link is in the text but its card was removed, or this post was saved without one: offer to show it again,
  // so a hidden preview is never a dead end.
  const hiddenUrl = !disabled && !link && firstUrl && dismissed.has(pageKey(firstUrl)) ? firstUrl : null;

  return {
    link, payload, imageChoices,
    loading: wanted && query.isFetching,
    errorMessage,
    hiddenUrl,
    show: () => { if (firstUrl) { setDismissed((current) => { const next = new Set(current); next.delete(pageKey(firstUrl)); return next; }); setDebouncedUrl(firstUrl); } },
    retry: () => { void query.refetch(); },
    dismiss,
    patch: (change: Partial<PostLink>) => setLink((current) => (current ? { ...current, ...change } : current)),
    markPaste: () => { pasted.current = true; },
    /** Puts back a saved card (restoring a local draft). */
    restore: (saved: PostLink | null | undefined) => { const next = normalizeLink(saved); if (next) { setLink(next); setDebouncedUrl(next.url); } },
  };
}

/**
 * The link's picture, loaded through our own server first (GET /api/link-preview/image). Loading it straight from the
 * other website can be blocked by hotlink protection, a firewall, an ad blocker or privacy settings, which is why a
 * card can show no picture on one computer and a picture on another. The website's own address is the second try;
 * only when both fail is the picture treated as missing.
 */
export function useLinkImage(imageUrl: string | null | undefined): { src: string | null; onError: () => void } {
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [imageUrl]);
  if (!imageUrl) return { src: null, onError: () => {} };
  const src = attempt === 0 ? `/api/link-preview/image?url=${encodeURIComponent(imageUrl)}` : attempt === 1 ? imageUrl : null;
  return { src, onError: () => setAttempt((value) => value + 1) };
}

/** What the card looks like on Facebook: image, DOMAIN, bold title, muted description. Used in the per-network preview. */
export function LinkCardView({ link, siteName }: { link: PostLink; siteName?: string | null }) {
  const image = useLinkImage(link.imageUrl);
  const domain = (siteName || domainOf(link.url)).toUpperCase();
  return <div className="sfa-linkprev-card" data-testid="linkprev-feedcard">
    {image.src && <img className="sfa-linkprev-img" src={image.src} alt="" referrerPolicy="no-referrer" onError={image.onError} />}
    <div className="sfa-linkprev-body">
      <span className="sfa-linkprev-domain">{domain}</span>
      {link.title && <strong className="sfa-linkprev-title">{link.title}</strong>}
      {link.description && <span className="sfa-linkprev-desc">{link.description}</span>}
    </div>
  </div>;
}

/** The composer's own editable card: thumbnail beside the title, the real URL and the description, like the link
 * card in the "Link Preview" section — not how it renders on any one network (see LinkCardView for that). */
export function LinkEditorCardView({ link, choices = [], onPickImage, actions }: { link: PostLink; choices?: string[]; onPickImage?: (imageUrl: string) => void; actions?: ReactNode }) {
  const image = useLinkImage(link.imageUrl);
  const index = link.imageUrl ? choices.indexOf(link.imageUrl) : -1;
  const canPick = Boolean(onPickImage) && choices.length > 1 && index >= 0;
  const step = (by: number) => onPickImage?.(choices[(index + by + choices.length) % choices.length]!);
  return <div className="sfa-linkprev-edit" data-testid="linkprev-card">
    <div className="sfa-linkprev-edit-media">
      {image.src
        ? <img className="sfa-linkprev-edit-thumb" src={image.src} alt="" referrerPolicy="no-referrer" onError={image.onError} data-testid="linkprev-image" />
        : <span className="sfa-linkprev-edit-thumb sfa-linkprev-edit-thumb--empty" aria-hidden><Link2 size={20} /></span>}
      {canPick && <>
        <button type="button" className="sfa-linkprev-edit-arrow sfa-linkprev-edit-arrow--prev" aria-label="Previous picture" onClick={() => step(-1)} data-testid="linkprev-image-prev"><ChevronLeft size={16} aria-hidden /></button>
        <button type="button" className="sfa-linkprev-edit-arrow sfa-linkprev-edit-arrow--next" aria-label="Next picture" onClick={() => step(1)} data-testid="linkprev-image-next"><ChevronRight size={16} aria-hidden /></button>
        <span className="sfa-linkprev-edit-count" aria-live="polite" data-testid="linkprev-image-count">{index + 1} / {choices.length}</span>
      </>}
    </div>
    <div className="sfa-linkprev-edit-body">
      <div className="sfa-linkprev-edit-top">
        <strong className="sfa-linkprev-edit-title">{link.title || domainOf(link.url)}</strong>
        {actions}
      </div>
      <a className="sfa-linkprev-edit-url" href={link.url} target="_blank" rel="noreferrer noopener">{link.url}</a>
      {link.description && <span className="sfa-linkprev-edit-desc">{link.description}</span>}
    </div>
  </div>;
}

export function LinkPreviewSection({ state, readOnly, platforms, hasMedia }: { state: ReturnType<typeof useLinkPreview>; readOnly: boolean; platforms: Platform[]; hasMedia: boolean }) {
  const { link, loading, errorMessage, hiddenUrl } = state;
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!link) setEditing(false); }, [link]);
  if (!link && !loading && !errorMessage) {
    if (!hiddenUrl || readOnly) return null;
    return <div className="sfa-linkprev sfa-linkprev--hidden" data-testid="linkprev-hidden">
      <h3 className="sfa-label sfa-linkprev-heading">Link Preview</h3>
      <p className="sfa-linkprev-hint"><span>No preview card for {domainOf(hiddenUrl)}. The link stays in the text.</span>
        <button type="button" className="sfa-linkprev-btn" onClick={state.show} data-testid="linkprev-show"><Link2 size={13} aria-hidden /> Show preview</button></p>
    </div>;
  }

  if (!link && loading) {
    return <div className="sfa-linkprev" data-testid="linkprev-loading" role="status" aria-label="Loading link preview">
      <div className="sfa-linkprev-edit sfa-linkprev-skel" aria-hidden><div className="sfa-linkprev-edit-thumb" /><div className="sfa-linkprev-edit-body"><span /><span /><span /></div></div>
    </div>;
  }
  if (!link) {
    return <div className="sfa-linkprev" data-testid="linkprev-error">
      <p className="sfa-linkprev-err" role="alert"><AlertTriangle size={14} aria-hidden /> <span>Couldn’t load a preview for this link: {errorMessage} Your post can still be published.</span></p>
      <div className="sfa-linkprev-actions">
        <button type="button" className="sfa-linkprev-btn" onClick={state.retry} data-testid="linkprev-retry"><RefreshCw size={13} aria-hidden /> Retry</button>
        <button type="button" className="sfa-linkprev-btn" onClick={state.dismiss} data-testid="linkprev-dismiss"><X size={13} aria-hidden /> Dismiss</button>
      </div>
    </div>;
  }

  const domain = domainOf(link.url);
  const notes = linkNotes(platforms, hasMedia, domain);
  const actions = readOnly ? null : <span className="sfa-linkprev-actions">
    <button type="button" className="sfa-linkprev-icon" aria-label={editing ? 'Finish editing link preview' : 'Edit link title and description'} aria-pressed={editing} onClick={() => setEditing((on) => !on)} data-testid="linkprev-edit">{editing ? <Check size={16} aria-hidden /> : <Pencil size={16} aria-hidden />}</button>
    <button type="button" className="sfa-linkprev-icon" aria-label="Remove link preview" onClick={state.dismiss} data-testid="linkprev-remove"><Trash2 size={16} aria-hidden /></button>
  </span>;
  return <div className="sfa-linkprev" aria-label="Link preview">
    <h3 className="sfa-label sfa-linkprev-heading">Link Preview</h3>
    <LinkEditorCardView link={link} choices={readOnly ? [] : state.imageChoices} onPickImage={readOnly ? undefined : (imageUrl) => state.patch({ imageUrl })} actions={actions} />
    {editing && !readOnly && <div className="sfa-linkprev-form">
      <label>Title<input type="text" maxLength={300} value={link.title ?? ''} onChange={(event) => state.patch({ title: event.target.value })} data-testid="linkprev-title-input" /></label>
      <label>Description<textarea rows={3} maxLength={1000} value={link.description ?? ''} onChange={(event) => state.patch({ description: event.target.value })} data-testid="linkprev-description-input" /></label>
    </div>}
    <ul className="sfa-linkprev-notes" data-testid="linkprev-notes">
      {notes.map((note) => <li key={note}><Info size={12} aria-hidden /> {note}</li>)}
    </ul>
  </div>;
}

/** Honest per-network notes about what the card does when published. */
export function linkNotes(platforms: Platform[], hasMedia: boolean, domain: string): string[] {
  const notes: string[] = [];
  const linkNet = platforms.filter((platform) => platform === 'facebook' || platform === 'linkedin');
  if (linkNet.length > 0) {
    notes.push(`Published as a link post. Clicking the image opens ${domain}.`);
    if (hasMedia) notes.push('A post with images or video can’t show a link card. The link stays in the text.');
    notes.push('Facebook builds its card from the website’s own tags; your edited title and description apply to this preview and to LinkedIn.');
  }
  if (platforms.includes('instagram')) notes.push('Instagram captions can’t hold a clickable link.');
  if (platforms.includes('youtube')) notes.push('YouTube can’t attach a link card to a video.');
  if (platforms.includes('twitter')) notes.push('X builds its own card from the website’s tags, as long as the link is in the text. X also charges more for a post that contains a link.');
  return notes;
}
