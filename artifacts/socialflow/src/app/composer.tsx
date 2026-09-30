import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { addHours, format, isSameDay, setHours, setMinutes, startOfHour } from 'date-fns';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AlertTriangle, CalendarClock, Check, ExternalLink, History, Info, Library, ListPlus, Repeat, Rocket, Send, Trash2, X } from 'lucide-react';
import { AiAssistPopover } from './ai-assist';
import { LibraryPicker } from './library-picker';
import { PostApprovalPanel } from './approval-controls';
import { useQueryClient } from '@tanstack/react-query';
import {
  getAuthMeQueryKey,
  getListPostsQueryKey,
  useAuthMe,
  useCreatePost,
  useCreateRecurrence,
  useDeletePost,
  useListConnectedAccounts,
  useListPosts,
  useUpdatePost,
  getListRecurrencesQueryKey,
  type Platform,
  type Post,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { useConfirm } from './confirm';
import { confirmPublish, usePublishNow } from './publish';
import { PLATFORM_META, PlatformBadge, StatusPill } from './platforms';
import {
  AccountSelector,
  ChecksPanel,
  DetectedItems,
  EmojiPicker,
  HashtagPicker,
  MediaTool,
  PreviewPanel,
  UtmPopover,
  computePlatformChecks,
} from './composer-parts';
import {
  applyUtmToText,
  clearLocalDraft,
  extractHashtags,
  extractUrls,
  insertAt,
  insertHashtag,
  loadLocalDraft,
  saveLocalDraft,
  schedulePresets,
  type UtmParams,
} from './composer-utils';
import { CustomFieldsForm, FirstCommentField, MentionGroupsTool, NetworkTabs, RepeatSection, TagPicker, repeatToRule, textFor, type PlatformContent, type RepeatState } from './composer-extras';
import { MediaUploader, type MediaUploaderHandle } from './media-uploader';
import { useMediaConfig, useMediaItems } from './media-upload';
import { mediaProblemForPlatforms } from './media-rules';
import { Button } from './ui';
import { LinkPreviewSection, normalizeLink, useLinkPreview } from './link-preview-card';
import './composer.css';

export type ComposerRequest = { post?: Post; date?: Date };

const ComposerContext = createContext<{ open: (request?: ComposerRequest) => void }>({ open: () => {} });

export function useComposer() {
  return useContext(ComposerContext);
}

export function ComposerProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<(ComposerRequest & { key: number }) | null>(null);
  const open = useCallback((next: ComposerRequest = {}) => setRequest({ ...next, key: Date.now() }), []);
  return <ComposerContext.Provider value={{ open }}>
    {children}
    {request && <ComposerModal key={request.key} request={request} onClose={() => setRequest(null)} />}
  </ComposerContext.Provider>;
}

/** Default schedule slot: 9:00 on the chosen day, or the next full hour if that's already past. */
function defaultSlot(day?: Date): Date {
  const now = new Date();
  if (!day) return startOfHour(addHours(now, 1));
  const nineAm = setMinutes(setHours(day, 9), 0);
  if (nineAm.getTime() > now.getTime()) return nineAm;
  return isSameDay(day, now) ? startOfHour(addHours(now, 1)) : nineAm;
}

function ComposerModal({ request, onClose }: { request: ComposerRequest; onClose: () => void }) {
  const editing = request.post ?? null;
  const readOnly = editing?.status === 'published' || editing?.status === 'publishing';
  // Some accounts already have this post, so editing it could send it to them twice.
  const partlySent = editing?.targets.some((target) => target.status === 'published') ?? false;
  const locked = readOnly || partlySent;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { publishNow, publishing } = usePublishNow();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { data: accountData, isLoading: accountsLoading } = useListConnectedAccounts();
  const accounts = accountData?.accounts ?? [];
  const me = useAuthMe({ query: { queryKey: getAuthMeQueryKey(), retry: false } });
  const { data: postsData } = useListPosts(undefined, { query: { queryKey: getListPostsQueryKey() } });

  const draftKey = me.data ? `socialflow:composer-draft:${me.data.user.id}` : null;
  const initialSlot = editing?.scheduledAt ? new Date(editing.scheduledAt) : defaultSlot(request.date);
  const [content, setContent] = useState(editing?.content ?? '');
  const [platformContent, setPlatformContent] = useState<PlatformContent>(() => ({ ...(editing?.platformContent ?? {}) }));
  const [customizing, setCustomizing] = useState(() => Object.values(editing?.platformContent ?? {}).some((text) => (text ?? '').trim().length > 0));
  const [activeTab, setActiveTab] = useState<'base' | Platform>('base');
  const platformRef = useRef<HTMLTextAreaElement>(null);
  const [firstComment, setFirstComment] = useState(editing?.firstComment ?? '');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [tagIds, setTagIds] = useState<string[]>(() => (editing?.tags ?? []).map((tag) => tag.id));
  const [customValues, setCustomValues] = useState<Record<string, string>>(() => ({ ...(editing?.customValues ?? {}) }));
  const [repeat, setRepeat] = useState<RepeatState | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [selected, setSelected] = useState<Set<string>>(new Set(editing?.targets.map((target) => target.connectedAccountId) ?? []));
  const [date, setDate] = useState(format(initialSlot, 'yyyy-MM-dd'));
  const [time, setTime] = useState(format(initialSlot, 'HH:mm'));
  const [error, setError] = useState<string | null>(null);
  const [savingAs, setSavingAs] = useState<'draft' | 'schedule' | 'queue' | null>(null);
  const mediaConfig = useMediaConfig();
  const media = useMediaItems(editing?.media ?? [], mediaConfig);
  const linkPreview = useLinkPreview({ text: content, initialLink: editing?.link ?? null, disabled: locked });
  const cardLink = linkPreview.payload;
  const uploaderRef = useRef<MediaUploaderHandle>(null);
  const readyMedia = media.items.filter((item) => item.status === 'done' && item.id).map((item) => ({ kind: item.kind, mimeType: item.mime, sizeBytes: item.size }));

  // Unsent new posts autosave to this browser (never the server), and offer to come back.
  const [restoreOffer, setRestoreOffer] = useState(() => (editing ? null : loadLocalDraft(draftKey)));
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const finished = useRef(false);
  const latest = useRef({ content, ids: [...selected], platformContent, firstComment, tagIds, link: cardLink });
  latest.current = { content, ids: [...selected], platformContent, firstComment, tagIds, link: cardLink };
  const offer = restoreOffer && restoreOffer.content.trim() ? restoreOffer : null;

  useEffect(() => {
    if (editing || offer) return;
    const handle = window.setTimeout(() => {
      if (content.trim() === '') { clearLocalDraft(draftKey); setSavedAt(null); return; }
      if (saveLocalDraft(draftKey, { content, accountIds: [...selected], savedAt: Date.now(), platformContent: platformContent as Record<string, string>, firstComment, tagIds, link: cardLink })) setSavedAt(new Date());
    }, 500);
    return () => window.clearTimeout(handle);
  }, [content, selected, editing, offer, draftKey, platformContent, firstComment, tagIds, cardLink]);

  // Closing the dialog right after typing must not lose the last keystrokes.
  useEffect(() => () => {
    if (finished.current || editing || offer) return;
    if (latest.current.content.trim()) saveLocalDraft(draftKey, { content: latest.current.content, accountIds: latest.current.ids, savedAt: Date.now(), platformContent: latest.current.platformContent as Record<string, string>, firstComment: latest.current.firstComment, tagIds: latest.current.tagIds, link: latest.current.link });
  }, [editing, offer, draftKey]);

  const finish = () => { finished.current = true; clearLocalDraft(draftKey); };
  // Leaving without saving: stop transfers and delete files that never made it onto a post.
  const discardMedia = media.discard;
  useEffect(() => () => { if (!finished.current) discardMedia(); }, [discardMedia]);
  const done = (message: string) => {
    finish();
    queryClient.invalidateQueries({ queryKey: [getListPostsQueryKey()[0]] });
    toast({ title: message });
    onClose();
  };
  const fail = (err: { data?: { message?: string } | null }) => { setSavingAs(null); setError(err.data?.message ?? 'Something went wrong. Please try again.'); };
  const create = useCreatePost({ mutation: { onSuccess: (post) => done(post.status === 'scheduled' ? (savingAs === 'queue' ? `Added to the queue for ${format(new Date(post.scheduledAt!), 'EEE, MMM d · h:mm a')}` : 'Post scheduled') : 'Draft saved'), onError: fail } });
  const createRecurrence = useCreateRecurrence({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: [getListRecurrencesQueryKey()[0]] }); done('Recurring post created'); }, onError: fail } });
  const update = useUpdatePost({ mutation: { onSuccess: (post) => done(post.status === 'scheduled' ? 'Post scheduled' : 'Draft saved'), onError: fail } });
  const remove = useDeletePost({ mutation: { onSuccess: () => done('Post deleted'), onError: fail } });
  // Publish now saves first without the toast-and-close side effects of the buttons above.
  const quietCreate = useCreatePost();
  const quietUpdate = useUpdatePost();
  // A draft created by a failed Publish now is reused on the next click instead of creating another.
  const createdRef = useRef<Post | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const busy = create.isPending || update.isPending || remove.isPending || createRecurrence.isPending || publishBusy || publishing;

  const selectedAccounts = useMemo(() => accounts.filter((account) => selected.has(account.id)), [accounts, selected]);
  const links = useMemo(() => extractUrls(content), [content]);
  const hashtags = useMemo(() => extractHashtags(content), [content]);
  const selectedPlatforms = useMemo(() => [...new Set(selectedAccounts.map((account) => account.platform))], [selectedAccounts]);
  const effectiveContent = platformContent;
  const textOf = (platform: Platform) => (customizing ? textFor(content, effectiveContent, platform) : content);
  const platformChecks = useMemo(() => computePlatformChecks(selectedAccounts, textOf, hashtags.length, readyMedia, Boolean(cardLink?.imageUrl)), [selectedAccounts, content, platformContent, customizing, hashtags.length, media.items, cardLink]);
  const charLimit = selectedAccounts.length > 0 ? Math.min(...selectedAccounts.map((account) => PLATFORM_META[account.platform].charLimit)) : null;
  // The base text counts against the tightest limit of the networks still using it; customized networks check their own text.
  const overPlatforms = selectedPlatforms.filter((platform) => textOf(platform).length > PLATFORM_META[platform].charLimit);
  const overLimit = overPlatforms.length > 0;
  const emptyFor = selectedPlatforms.filter((platform) => textOf(platform).trim().length === 0);
  const activeText = activeTab === 'base' ? content : (platformContent[activeTab] ?? '');
  const activeLimit = activeTab === 'base' ? charLimit : PLATFORM_META[activeTab].charLimit;
  const activeOver = activeTab === 'base' ? (customizing ? selectedPlatforms.some((platform) => !(platformContent[platform] ?? '').trim() && content.length > PLATFORM_META[platform].charLimit) : overLimit) : activeText.length > (activeLimit ?? Infinity);
  const scheduledAt = new Date(`${date}T${time}`);
  const scheduleValid = date !== '' && time !== '' && !Number.isNaN(scheduledAt.getTime());
  const inPast = scheduleValid && scheduledAt.getTime() <= Date.now();

  // Hashtags from the user's own earlier posts, most used first.
  const recentHashtags = useMemo(() => {
    const counts = new Map<string, { tag: string; n: number }>();
    for (const post of postsData?.posts ?? []) {
      for (const tag of extractHashtags(post.content)) {
        const entry = counts.get(tag.toLowerCase());
        if (entry) entry.n += 1; else counts.set(tag.toLowerCase(), { tag, n: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 12).map((entry) => entry.tag);
  }, [postsData]);

  // Content rules are shared by "Schedule" and "Publish now"; the date rules only apply to scheduling.
  let contentBlocker: string | null = null;
  if (content.trim().length === 0 && (selected.size === 0 || emptyFor.length > 0)) contentBlocker = 'Write something to post.';
  else if (selected.size === 0) contentBlocker = 'Choose at least one account.';
  else if (emptyFor.length > 0) contentBlocker = `Write something for ${emptyFor.map((platform) => PLATFORM_META[platform].name).join(' and ')}.`;
  else if (overLimit) contentBlocker = `Too long for ${overPlatforms.map((platform) => PLATFORM_META[platform].name).join(' and ')}.`;
  else if (media.uploading) contentBlocker = 'Wait for uploads to finish.';
  else if (mediaProblemForPlatforms(selectedAccounts.map((a) => a.platform), readyMedia, { hasLinkImage: Boolean(cardLink?.imageUrl) })) contentBlocker = mediaProblemForPlatforms(selectedAccounts.map((a) => a.platform), readyMedia, { hasLinkImage: Boolean(cardLink?.imageUrl) });
  const publishBlocker = partlySent ? null : contentBlocker;
  const scheduleBlocker = contentBlocker ?? (!scheduleValid ? 'Pick a date and time.' : inPast ? 'Pick a time in the future.' : repeat?.frequency === 'weekly' && repeat.weekdays.length === 0 ? 'Pick at least one weekday to repeat on.' : null);
  const queueBlocker = contentBlocker;

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /** Edits the text and puts the caret where the insertion ended. */
  const edit = (change: (value: string, start: number, end: number) => { value: string; caret: number }) => {
    const el = activeTab === 'base' ? textareaRef.current : platformRef.current;
    const current = activeText;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = change(current, start, end);
    if (activeTab === 'base') setContent(next.value); else setPlatformContent((value) => ({ ...value, [activeTab]: next.value }));
    window.requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(next.caret, next.caret); });
  };
  // Inline, not a toast: a toast would swallow the first Escape press meant to close the dialog.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const handle = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(handle);
  }, [notice]);
  const applyUtm = (params: UtmParams) => {
    setContent((value) => applyUtmToText(value, params));
    setNotice(links.length === 1 ? 'Tracking added to your link.' : `Tracking added to ${links.length} links.`);
  };

  const sentPlatformContent = customizing ? platformContent : {};
  const extras = { platformContent: sentPlatformContent, firstComment: firstComment.trim() ? firstComment : null, tagIds, customValues };
  // null clears a saved card; the card only goes out while its link is still in the text.
  const linkBody = { link: cardLink };
  const submit = (mode: 'draft' | 'schedule' | 'queue') => {
    setError(null);
    setSavingAs(mode);
    if (mode === 'schedule' && repeat && !editing) {
      createRecurrence.mutate({ data: { ...repeatToRule(repeat, date, time, timezone), content, ...extras, connectedAccountIds: [...selected], mediaIds: media.readyIds } });
      return;
    }
    const body = { content, connectedAccountIds: [...selected], mediaIds: media.readyIds, ...extras, ...linkBody, ...(mode === 'queue' ? { queue: true } : { scheduledAt: mode === 'draft' ? null : scheduledAt.toISOString() }) };
    if (editing) update.mutate({ postId: editing.id, data: body });
    else create.mutate({ data: body });
  };

  const onDelete = async () => {
    if (!editing) return;
    if (await confirm({ title: 'Delete this post?', description: 'This removes the post and its schedule. It can’t be undone.', confirmLabel: 'Delete post', destructive: true })) {
      remove.mutate({ postId: editing.id });
    }
  };

  /** Saves any unsaved edits, then publishes. Confirms first so cancelling never leaves a stray draft. */
  const onPublishNow = async () => {
    setError(null);
    const names = partlySent ? (editing?.targets ?? []).filter((t) => t.status !== 'published').map((t) => t.accountName) : selectedAccounts.map((a) => a.displayName);
    if (!(await confirmPublish(confirm, names, editing?.status === 'failed'))) return;
    setPublishBusy(true);
    try {
      let target = editing ?? createdRef.current;
      const body = { content, connectedAccountIds: [...selected], mediaIds: media.readyIds, ...extras, ...linkBody };
      if (!target) {
        target = await quietCreate.mutateAsync({ data: { ...body, scheduledAt: null } });
        createdRef.current = target;
        queryClient.invalidateQueries({ queryKey: [getListPostsQueryKey()[0]] });
      } else if (!partlySent) {
        const changed = content !== target.content || body.mediaIds.join() !== target.media.map((m) => m.id).join() || body.connectedAccountIds.slice().sort().join() !== target.targets.map((t) => t.connectedAccountId).sort().join()
          || JSON.stringify(sentPlatformContent) !== JSON.stringify(target.platformContent) || (body.firstComment ?? null) !== (target.firstComment ?? null) || tagIds.slice().sort().join() !== target.tags.map((t) => t.id).sort().join() || JSON.stringify(customValues) !== JSON.stringify(target.customValues) || JSON.stringify(normalizeLink(cardLink)) !== JSON.stringify(normalizeLink(target.link));
        if (changed) {
          target = await quietUpdate.mutateAsync({ postId: target.id, data: body });
          if (!editing) createdRef.current = target;
          queryClient.invalidateQueries({ queryKey: [getListPostsQueryKey()[0]] });
        }
      }
      const result = await publishNow(target!, { confirmed: true });
      if (result) { finish(); onClose(); }
    } catch (err) {
      fail(err as { data?: { message?: string } | null });
    } finally {
      setPublishBusy(false);
    }
  };

  /** Ctrl/Cmd+Enter schedules, Ctrl/Cmd+S saves a draft. Ignores keys typed in the confirm dialog rendered through a portal. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || locked || busy) return;
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (event.key === 'Enter' && scheduleBlocker === null) { event.preventDefault(); submit('schedule'); }
    else if (event.key.toLowerCase() === 's' && !overLimit && !media.uploading) { event.preventDefault(); submit('draft'); }
  };

  const restore = () => {
    if (!offer) return;
    setContent(offer.content);
    setSelected(new Set(offer.accountIds));
    if (offer.platformContent) { setPlatformContent(offer.platformContent as PlatformContent); setCustomizing(Object.values(offer.platformContent).some((text) => text.trim().length > 0)); }
    if (offer.firstComment) setFirstComment(offer.firstComment);
    if (offer.tagIds) setTagIds(offer.tagIds);
    if (offer.link) linkPreview.restore(offer.link as never);
    setRestoreOffer(null);
  };
  const discardOffer = () => { clearLocalDraft(draftKey); setRestoreOffer(null); };

  const setSlot = (slot: Date) => { setDate(format(slot, 'yyyy-MM-dd')); setTime(format(slot, 'HH:mm')); };
  const firstMedia = media.items.find((item) => item.status === 'done');
  const previewMedia = firstMedia ? { kind: firstMedia.kind, src: firstMedia.src, poster: firstMedia.poster, count: media.readyIds.length } : null;
  const previewWhen = readOnly || !scheduleValid ? null : scheduledAt;
  const usage = activeLimit ? Math.min(activeText.length / activeLimit, 1) : 0;
  const statusLine = editing ? null : savedAt ? `Autosaved on this device · ${format(savedAt, 'h:mm a')}` : 'Autosaves on this device as you type';

  return <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="sfa-overlay" />
      <DialogPrimitive.Content className="sfa-composer" data-testid="dialog-composer" aria-describedby={undefined} onKeyDown={onKeyDown}
        onOpenAutoFocus={(event) => { if (!locked && textareaRef.current) { event.preventDefault(); textareaRef.current.focus(); } }}>
        <header className="sfa-composer__head">
          <div className="sfa-composer__titles">
            <DialogPrimitive.Title asChild><h2 id="composer-title">{editing?.status === 'published' ? 'Published post' : editing?.status === 'publishing' ? 'Publishing…' : editing ? 'Edit post' : 'Create post'}</h2></DialogPrimitive.Title>
            {statusLine && <span className="sfa-composer__status" role="status" data-testid="autosave-status"><Check size={12} aria-hidden /> {statusLine}</span>}
          </div>
          {editing && <StatusPill status={editing.status} />}
          <DialogPrimitive.Close asChild>
            <button className="sfa-iconbtn sfa-composer__close" aria-label="Close" data-testid="button-close-composer"><X size={18} /></button>
          </DialogPrimitive.Close>
        </header>

        <div className="sfa-composer__body">
          <div className="sfa-composer__col sfa-composer__main">
            {offer && <div className="sfa-restore" role="status" data-testid="restore-banner">
              <History size={16} aria-hidden />
              <span>You have an unsent draft from {format(new Date(offer.savedAt), "MMM d 'at' h:mm a")}.</span>
              <Button size="sm" variant="primary" onClick={restore} data-testid="button-restore-draft">Restore</Button>
              <Button size="sm" variant="ghost" onClick={discardOffer} data-testid="button-discard-draft">Discard</Button>
            </div>}

            <section>
              <div className="sfa-labelrow">
                <label className="sfa-label" htmlFor="composer-content">Content</label>
                {!locked && <NetworkTabs platforms={selectedPlatforms} active={activeTab} platformContent={platformContent} customizing={customizing} base={content}
                  onPick={setActiveTab} onToggleCustomize={(on) => { setCustomizing(on); if (!on) { setActiveTab('base'); setPlatformContent({}); } }} />}
              </div>
              {customizing && activeTab !== 'base' && <p className="sfa-muted sfa-nettabs__hint" data-testid="nettab-hint">
                {(platformContent[activeTab] ?? '').trim() ? `${PLATFORM_META[activeTab].name} gets this text instead of the shared one.` : `Leave empty to send ${PLATFORM_META[activeTab].name} the shared text, or write a version just for it.`}
              </p>}
              <div className={`sfa-editor ${activeOver ? 'is-over' : ''}`}>
                {activeTab === 'base'
                  ? <textarea id="composer-content" ref={textareaRef} className="sfa-editor__input" value={content} onChange={(event) => setContent(event.target.value)} onPaste={linkPreview.markPaste} readOnly={locked}
                    placeholder="What do you want to share?" rows={7} aria-invalid={activeOver || undefined} data-testid="input-post-content" />
                  : <textarea key={activeTab} ref={platformRef} className="sfa-editor__input" value={platformContent[activeTab] ?? ''} onChange={(event) => setPlatformContent((value) => ({ ...value, [activeTab]: event.target.value }))} readOnly={locked}
                    placeholder={`Text for ${PLATFORM_META[activeTab].name} (leave empty to use the shared text)`} rows={7} aria-invalid={activeOver || undefined} aria-label={`${PLATFORM_META[activeTab].name} text`} data-testid={`input-post-content-${activeTab}`} />}
                <div className="sfa-editor__bar">
                  <div className="sfa-tools" role="toolbar" aria-label="Formatting tools">
                    <EmojiPicker disabled={locked} onPick={(emoji) => edit((value, start, end) => insertAt(value, start, end, emoji))} />
                    <HashtagPicker disabled={locked} recent={recentHashtags} onInsert={(tag) => edit((value, start, end) => insertHashtag(value, start, end, tag))} />
                    <UtmPopover disabled={locked} links={links} onApply={applyUtm} />
                    <MentionGroupsTool disabled={locked} onInsert={(text) => edit((value, start, end) => insertAt(value, start, end, (start > 0 && !/\s$/.test(value.slice(0, start)) ? ' ' : '') + text + ' '))} />
                    <MediaTool count={media.items.length} disabled={locked} onClick={() => uploaderRef.current?.openPicker()} />
                    <button type="button" className="sfa-tool" aria-label="Insert from content library" title="Insert from content library" disabled={locked} onClick={() => setLibraryOpen(true)} data-testid="tool-library"><Library size={17} /></button>
                    {!locked && <AiAssistPopover currentText={activeText} platforms={selectedPlatforms as never} onInsert={(text) => edit((value, start, end) => insertAt(value, start, end, text))} />}
                  </div>
                  <span className={`sfa-counter ${activeOver ? 'is-over' : ''}`} data-testid="text-char-count">
                    {activeLimit !== null && <span className="sfa-meter" aria-hidden="true"><span style={{ width: `${usage * 100}%` }} /></span>}
                    {activeText.length}{activeLimit !== null ? ` / ${activeLimit.toLocaleString()}` : ''}
                  </span>
                </div>
              </div>
              <DetectedItems links={links} hashtags={hashtags} />
              <LinkPreviewSection state={linkPreview} readOnly={locked} platforms={selectedPlatforms} hasMedia={media.readyIds.length > 0} />
              {notice && <p className="sfa-inline-ok" role="status" data-testid="composer-notice"><Check size={13} aria-hidden /> {notice}</p>}
            </section>

            <MediaUploader ref={uploaderRef} controller={media} config={mediaConfig} disabled={locked} />
            <LibraryPicker open={libraryOpen} onClose={() => setLibraryOpen(false)} kinds={['caption', 'template', 'snippet', 'media']} onPick={(item, rendered) => {
              if (item.kind === 'media') {
                if (!item.media) { toast({ title: 'That file is no longer available', variant: 'destructive' }); return; }
                const result = media.attachExisting(item.media);
                if (result === 'limit') toast({ title: `A post can have up to ${mediaConfig.maxFilesPerPost} files`, description: 'Remove one to add this.', variant: 'destructive' });
                else if (result === 'duplicate') toast({ title: 'Already attached to this post' });
                else toast({ title: 'Added from the library' });
                return;
              }
              const text = rendered ?? item.body ?? ''; if (text) edit((value, start, end) => insertAt(value, start, end, text)); }} />

            <section aria-labelledby="composer-organise">
              <h3 className="sfa-label" id="composer-organise">Tags &amp; fields</h3>
              <TagPicker selected={tagIds} onChange={setTagIds} disabled={locked} />
              <CustomFieldsForm values={customValues} onChange={setCustomValues} disabled={locked} />
            </section>
          </div>

          <aside className="sfa-composer__col sfa-composer__preview" aria-label="Preview and checks">
            <h3 className="sfa-label">Preview</h3>
            <PreviewPanel accounts={selectedAccounts} content={textOf} when={previewWhen} media={previewMedia} link={cardLink} />
            <h3 className="sfa-label sfa-label--spaced">Network checks</h3>
            <ChecksPanel results={platformChecks} />
            <details className="sfa-notes"><summary><Info size={14} aria-hidden /> How each network handles media</summary><p className="sfa-muted">Scheduled posts are sent automatically at their time while Socialflow is running. Facebook Pages and LinkedIn take text posts. Images and video are uploaded to Facebook Pages, Instagram (JPG, MP4 or MOV; Instagram must be able to reach this site over https) and LinkedIn. YouTube takes one video per post (add one photo and it becomes the video’s thumbnail; YouTube can’t post a photo on its own); the first line of the text is its title, and it uploads as private until you make it public in YouTube Studio.</p></details>
          </aside>

          <aside className="sfa-composer__col sfa-composer__settings" aria-label="Accounts and scheduling">
            <section aria-labelledby="composer-accounts" className="sfa-composer__card">
              <h3 className="sfa-label" id="composer-accounts">Post to {selected.size > 0 && <span className="sfa-count sfa-num">{selected.size}</span>}</h3>
              <AccountSelector accounts={accounts} selected={selected} locked={locked} loading={accountsLoading} onToggle={toggle} onSetAll={(ids) => setSelected(new Set(ids))} />
            </section>

            {!locked && <section aria-labelledby="composer-schedule">
              <h3 className="sfa-label" id="composer-schedule"><CalendarClock size={15} /> Schedule</h3>
              <div className="sfa-schedule">
                <label>Date<input type="date" value={date} min={format(new Date(), 'yyyy-MM-dd')} onChange={(event) => setDate(event.target.value)} aria-invalid={inPast || undefined} data-testid="input-schedule-date" /></label>
                <label>Time<input type="time" value={time} onChange={(event) => setTime(event.target.value)} aria-invalid={inPast || undefined} data-testid="input-schedule-time" /></label>
                <span className="sfa-muted sfa-schedule__tz">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
              </div>
              <div className="sfa-presets" role="group" aria-label="Quick times">
                {schedulePresets().map((preset) => <button key={preset.key} type="button" className="sfa-tagchip sfa-tagchip--button" onClick={() => setSlot(preset.date)} data-testid={`preset-${preset.key}`}>{preset.label}</button>)}
              </div>
            </section>}
            {!locked && !editing && <RepeatSection repeat={repeat} onChange={setRepeat} date={date} time={time} timezone={timezone} disabled={busy} />}
            {editing?.recurrenceId && <p className="sfa-note" data-testid="recurrence-note"><Repeat size={14} /> <span>This post is one occurrence of a recurring post. Changes here apply to this occurrence only; manage the series on the Recurring page.</span></p>}

            {editing && !readOnly && <PostApprovalPanel postId={editing.id} postStatus={editing.status} />}

            <FirstCommentField value={firstComment} onChange={setFirstComment} accounts={selectedAccounts} disabled={locked} />

            {editing && editing.targets.some((target) => target.status === 'published' || target.status === 'failed') && <section aria-labelledby="composer-results" data-testid="composer-results">
              <h3 className="sfa-label" id="composer-results">Results</h3>
              <ul className="sfa-results">
                {editing.targets.map((target) => <li key={target.connectedAccountId}>
                  <PlatformBadge platform={target.platform} size={16} />
                  <span className="sfa-results__name">{target.accountName}</span>
                  <StatusPill status={target.status} />
                  {target.postUrl && <a className="sfa-linkbtn" href={target.postUrl} target="_blank" rel="noopener noreferrer">View post <ExternalLink size={12} /></a>}
                  {target.errorMessage && <p className="sfa-results__err" role="note">{target.errorMessage}</p>}
                  {target.firstCommentStatus === 'published' && <p className="sfa-muted sfa-results__note" data-testid={`first-comment-result-${target.connectedAccountId}`}><Check size={12} aria-hidden /> First comment posted</p>}
                  {(target.firstCommentStatus === 'failed' || target.firstCommentStatus === 'unsupported') && target.firstCommentError && <p className="sfa-results__err" role="note" data-testid={`first-comment-result-${target.connectedAccountId}`}>{target.firstCommentError}</p>}
                </li>)}
              </ul>
              {partlySent && <p className="sfa-muted">Some accounts already have this post, so it can’t be edited. Retry publishes only to the accounts that failed.</p>}
            </section>}
            {error && <div className="sfa-alert" role="alert" data-testid="status-composer-error"><AlertTriangle size={15} /> <span>{error}</span></div>}
          </aside>
        </div>

        {!readOnly && <footer className="sfa-composer__foot">
          {editing && <Button variant="destructive" icon={<Trash2 size={14} />} disabled={busy} loading={remove.isPending} onClick={onDelete} data-testid="button-delete-post">Delete</Button>}
          <span className="sfa-composer__blocker" role="status">{partlySent ? null : scheduleBlocker}</span>
          {!partlySent && <Button variant="secondary" disabled={busy || overLimit || media.uploading} loading={busy && savingAs === 'draft'} onClick={() => submit('draft')} title="Save as draft (Ctrl+S)" data-testid="button-save-draft">Save as draft</Button>}
          {!partlySent && !repeat && <Button variant="outline" disabled={busy || queueBlocker !== null} loading={busy && savingAs === 'queue'} icon={<ListPlus size={14} />} onClick={() => submit('queue')} title="Schedule into the next free slot of the selected accounts' posting queues" data-testid="button-add-to-queue">Add to queue</Button>}
          {!(repeat && !editing) && <Button variant={partlySent ? 'primary' : 'outline'} disabled={busy || publishBlocker !== null} loading={publishBusy} icon={<Rocket size={14} />} onClick={onPublishNow} data-testid="button-publish-now">{partlySent ? 'Retry failed accounts' : 'Publish now'}</Button>}
          {!partlySent && <Button variant="primary" disabled={busy || scheduleBlocker !== null} loading={busy && savingAs === 'schedule'} icon={repeat && !editing ? <Repeat size={14} /> : <Send size={14} />} onClick={() => submit('schedule')} title="Schedule (Ctrl+Enter)" data-testid="button-schedule-post">
            {busy && savingAs === 'schedule' ? 'Saving…' : repeat && !editing ? 'Create recurring post' : editing?.status === 'scheduled' ? 'Update schedule' : 'Schedule post'}
          </Button>}
        </footer>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
