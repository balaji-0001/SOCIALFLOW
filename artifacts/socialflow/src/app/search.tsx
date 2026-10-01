import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { format } from 'date-fns';
import { CornerDownLeft, FileText, Network, Search as SearchIcon, Tag as TagIcon } from 'lucide-react';
import {
  getListConnectedAccountsQueryKey,
  getListPostsQueryKey,
  getListTagsQueryKey,
  useListConnectedAccounts,
  useListPosts,
  useListTags,
} from '@workspace/api-client-react';
import { useComposer } from './composer';
import { PlatformBadge, STATUS_LABEL, snippet } from './platforms';

/* Global search: posts (text, per-network text, tags), connected accounts, tags and pages. Filters what the app has already loaded. */

const PAGES = [
  { label: 'Dashboard', href: '/dashboard' }, { label: 'Calendar', href: '/calendar' }, { label: 'Manage Posts', href: '/posts' }, { label: 'Drafts', href: '/drafts' },
  { label: 'Queue', href: '/queue' }, { label: 'Recurring posts', href: '/recurring' }, { label: 'Connected accounts', href: '/workspace' }, { label: 'Settings', href: '/settings' },
  { label: 'Automations: WordPress and RSS', href: '/automations' }, { label: 'Bulk import (CSV)', href: '/automations?tab=import' },
];

type Hit = { key: string; group: 'Posts' | 'Accounts' | 'Tags' | 'Pages'; label: string; hint: string; icon: 'post' | 'account' | 'tag' | 'page'; run: () => void; platform?: Parameters<typeof PlatformBadge>[0]['platform'] };

export function GlobalSearch() {
  const [, navigate] = useLocation();
  const composer = useComposer();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const enabled = open;
  const { data: postData } = useListPosts(undefined, { query: { queryKey: getListPostsQueryKey(), enabled } });
  const { data: accountData } = useListConnectedAccounts({ query: { queryKey: getListConnectedAccountsQueryKey(), enabled } });
  const { data: tagData } = useListTags({ query: { queryKey: getListTagsQueryKey(), enabled } });

  // "/" or Ctrl/Cmd+K focuses the search from anywhere (unless typing in a field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey)) {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    const onDown = (event: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, []);

  const close = () => { setOpen(false); setQuery(''); inputRef.current?.blur(); };

  const hits = useMemo<Hit[]>(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [];
    const out: Hit[] = [];
    for (const post of postData?.posts ?? []) {
      const haystack = [post.content, ...Object.values(post.platformContent ?? {}), ...post.tags.map((tag) => tag.name), ...post.targets.map((target) => target.accountName)].join(' ').toLowerCase();
      if (haystack.includes(term)) out.push({ key: `p-${post.id}`, group: 'Posts', label: snippet(post.content || '(no text)', 80), hint: `${STATUS_LABEL[post.status]}${post.scheduledAt ? ` · ${format(new Date(post.scheduledAt), 'MMM d, h:mm a')}` : ''}`, icon: 'post', run: () => composer.open({ post }) });
      if (out.filter((hit) => hit.group === 'Posts').length >= 6) break;
    }
    for (const account of accountData?.accounts ?? []) {
      if (`${account.displayName} ${account.username ?? ''} ${account.platform}`.toLowerCase().includes(term)) out.push({ key: `a-${account.id}`, group: 'Accounts', label: account.displayName, hint: account.platform, icon: 'account', platform: account.platform, run: () => navigate('/workspace') });
    }
    for (const tag of tagData?.tags ?? []) {
      if (tag.name.toLowerCase().includes(term)) out.push({ key: `t-${tag.id}`, group: 'Tags', label: tag.name, hint: `${tag.postCount ?? 0} posts`, icon: 'tag', run: () => navigate('/settings?tab=tags') });
    }
    for (const page of PAGES) {
      if (page.label.toLowerCase().includes(term)) out.push({ key: `g-${page.href}`, group: 'Pages', label: page.label, hint: 'Go to page', icon: 'page', run: () => navigate(page.href) });
    }
    return out;
  }, [query, postData, accountData, tagData, composer, navigate]);

  useEffect(() => { setCursor(0); }, [query]);

  const choose = (hit: Hit | undefined) => { if (!hit) return; hit.run(); close(); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((value) => Math.min(hits.length - 1, value + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((value) => Math.max(0, value - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(hits[cursor]); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
  };

  const groups = (['Posts', 'Accounts', 'Tags', 'Pages'] as const).map((group) => ({ group, items: hits.filter((hit) => hit.group === group) })).filter((entry) => entry.items.length > 0);
  const listId = 'sfa-search-results';

  return <div className="sfa-gsearch" ref={wrapRef}>
    <label className="sfa-gsearch__field">
      <SearchIcon size={15} aria-hidden />
      <input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
        placeholder="Search posts, accounts, tags…" aria-label="Search" role="combobox" aria-expanded={open && query.trim().length > 0} aria-controls={listId} aria-autocomplete="list" data-testid="input-global-search" />
      <kbd className="sfa-kbd" aria-hidden>/</kbd>
    </label>
    {open && query.trim().length > 0 && <div className="sfa-gsearch__panel" id={listId} role="listbox" aria-label="Search results" data-testid="global-search-results">
      {hits.length === 0 ? <p className="sfa-gsearch__empty">No matches for “{query.trim()}”.</p>
        : groups.map(({ group, items }) => <div key={group} role="group" aria-label={group}>
          <div className="sfa-gsearch__group">{group}</div>
          {items.map((hit) => {
            const index = hits.indexOf(hit);
            return <button key={hit.key} type="button" role="option" aria-selected={index === cursor} className={`sfa-gsearch__hit ${index === cursor ? 'is-on' : ''}`} onMouseEnter={() => setCursor(index)} onClick={() => choose(hit)} data-testid={`search-hit-${hit.key}`}>
              <span className="sfa-gsearch__icon" aria-hidden>{hit.platform ? <PlatformBadge platform={hit.platform} size={16} /> : hit.icon === 'post' ? <FileText size={15} /> : hit.icon === 'tag' ? <TagIcon size={15} /> : <Network size={15} />}</span>
              <span className="sfa-gsearch__text"><strong>{hit.label}</strong><small>{hit.hint}</small></span>
              {index === cursor && <CornerDownLeft size={13} aria-hidden />}
            </button>;
          })}
        </div>)}
    </div>}
  </div>;
}
