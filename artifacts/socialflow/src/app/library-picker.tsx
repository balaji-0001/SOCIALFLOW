import { useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowLeft, Image as ImageIcon, Library, Search, Star, X } from 'lucide-react';
import {
  getListLibraryItemsQueryKey,
  listLibraryItems,
  useRenderLibraryTemplate,
  useUseLibraryItem,
  type LibraryItem,
  type LibraryKind,
  type ListLibraryItemsParams,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { Button, EmptyState, ErrorState, Skeleton } from './ui';
import './library.css';

export const KIND_LABELS: Record<LibraryKind, string> = { media: 'Media', caption: 'Captions', template: 'Templates', snippet: 'Snippets' };
export const ALL_KINDS: LibraryKind[] = ['media', 'caption', 'template', 'snippet'];

export function libErrorMessage(err: unknown): string | undefined {
  const data = typeof err === 'object' && err !== null ? (err as { data?: unknown }).data : undefined;
  const message = typeof data === 'object' && data !== null ? (data as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message : undefined;
}
function missingList(err: unknown): string[] {
  const data = typeof err === 'object' && err !== null ? (err as { data?: unknown }).data : undefined;
  const missing = typeof data === 'object' && data !== null ? (data as { missing?: unknown }).missing : undefined;
  return Array.isArray(missing) ? missing.filter((m): m is string => typeof m === 'string') : [];
}

export function LibraryThumb({ item }: { item: LibraryItem }) {
  const media = item.media;
  if (!media) return <div className="sfa-lib-thumb sfa-lib-thumb--none"><ImageIcon size={22} aria-hidden="true" /><span>File unavailable</span></div>;
  if (media.kind === 'video') return <div className="sfa-lib-thumb"><video src={media.url} preload="metadata" muted aria-label={item.title} /></div>;
  if (media.kind === 'image') return <div className="sfa-lib-thumb"><img src={media.url} alt={item.title} loading="lazy" /></div>;
  return <div className="sfa-lib-thumb sfa-lib-thumb--none"><ImageIcon size={22} aria-hidden="true" /><span>{media.fileName}</span></div>;
}

export type LibraryPickerProps = {
  open: boolean;
  onClose: () => void;
  /** Called after the /use endpoint counted the use. For templates, `renderedText` is the filled-in text. */
  onPick: (item: LibraryItem, renderedText?: string) => void;
  /** Restrict to these kinds (default: all). */
  kinds?: LibraryKind[];
};

function TemplateForm({ item, onBack, onDone }: { item: LibraryItem; onBack: () => void; onDone: (text: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const render = useRenderLibraryTemplate({
    mutation: {
      onSuccess: (r) => onDone(r.text),
      onError: (err) => { setMissing(missingList(err)); setError(libErrorMessage(err) ?? "Couldn't fill in this template."); },
    },
  });
  return <form className="sfa-lib-tplform" onSubmit={(e) => { e.preventDefault(); setError(null); setMissing([]); render.mutate({ itemId: item.id, data: { variables: values } }); }} data-testid="form-library-template">
    <button type="button" className="sfa-lib-back" onClick={onBack}><ArrowLeft size={14} /> Back</button>
    <h3>{item.title}</h3>
    {item.placeholders.length === 0
      ? <p className="sfa-lib-muted">This template has no placeholders.</p>
      : <p className="sfa-lib-muted">Fill in every value. Nothing is filled in for you.</p>}
    {item.placeholders.map((name) => <div className="sfa-field" key={name}>
      <label htmlFor={`sfa-lib-var-${name}`}>{name}</label>
      <input id={`sfa-lib-var-${name}`} className="sfa-input" value={values[name] ?? ''} maxLength={2000} aria-invalid={missing.includes(name) || undefined}
        onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))} data-testid={`input-library-var-${name}`} />
    </div>)}
    {error && <p className="sfa-lib-error" role="alert" data-testid="text-library-render-error">{error}{missing.length > 0 && <> Missing: {missing.map((m) => `{{${m}}}`).join(', ')}.</>}</p>}
    <Button type="submit" variant="primary" loading={render.isPending} data-testid="button-library-render">Insert template</Button>
  </form>;
}

export function LibraryPicker({ open, onClose, onPick, kinds }: LibraryPickerProps) {
  const allowed = kinds && kinds.length > 0 ? kinds : ALL_KINDS;
  const { toast } = useToast();
  const [kind, setKind] = useState<LibraryKind | 'all'>(allowed.length === 1 ? allowed[0]! : 'all');
  const [q, setQ] = useState('');
  const [favorite, setFavorite] = useState(false);
  const [template, setTemplate] = useState<LibraryItem | null>(null);
  const use = useUseLibraryItem();

  const base: ListLibraryItemsParams = { limit: 24, sort: 'used', ...(q.trim() ? { q: q.trim() } : {}), ...(favorite ? { favorite: true } : {}) };
  const activeKinds = kind === 'all' ? allowed : [kind];
  const query = useInfiniteQuery({
    queryKey: [...getListLibraryItemsQueryKey(base), 'picker', activeKinds.join(',')],
    enabled: open,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      // The API filters by a single kind; fetch per allowed kind when several are active.
      if (activeKinds.length === 1) return listLibraryItems({ ...base, kind: activeKinds[0], ...(pageParam ? { cursor: pageParam } : {}) });
      const page = await listLibraryItems({ ...base, ...(pageParam ? { cursor: pageParam } : {}) });
      return { ...page, items: page.items.filter((i) => allowed.includes(i.kind)) };
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  const finish = (item: LibraryItem, text?: string) => {
    use.mutate({ itemId: item.id }, {
      onSuccess: (used) => { onPick(used, text); onClose(); },
      onError: (err) => toast({ title: "Couldn't use this item", description: libErrorMessage(err), variant: 'destructive' }),
    });
  };
  const choose = (item: LibraryItem) => { if (item.kind === 'template') setTemplate(item); else finish(item); };

  return <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) { setTemplate(null); onClose(); } }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="sfa-overlay sfa-overlay--top" />
      <DialogPrimitive.Content className="sfa-dialog sfa-lib-dialog" data-testid="dialog-library-picker">
        <DialogPrimitive.Close asChild><button type="button" className="sfa-iconbtn sfa-dialog__close" aria-label="Close" data-testid="button-close-library-picker"><X size={18} /></button></DialogPrimitive.Close>
        <DialogPrimitive.Title className="sfa-dialog__title">Content library</DialogPrimitive.Title>
        <DialogPrimitive.Description className="sfa-dialog__desc">Pick a saved caption, template, snippet or media item.</DialogPrimitive.Description>
        {template
          ? <TemplateForm item={template} onBack={() => setTemplate(null)} onDone={(text) => finish(template, text)} />
          : <>
            <div className="sfa-lib-pickbar">
              <div className="sfa-lib-search"><Search size={15} aria-hidden="true" />
                <input className="sfa-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the library" aria-label="Search the library" data-testid="input-library-picker-search" /></div>
              <button type="button" className={`sfa-lib-favbtn ${favorite ? 'is-on' : ''}`} aria-pressed={favorite} onClick={() => setFavorite((f) => !f)} data-testid="button-library-picker-favorites"><Star size={14} /> Favorites</button>
            </div>
            {allowed.length > 1 && <div className="sfa-lib-tabs" role="group" aria-label="Kind">
              {(['all', ...allowed] as const).map((k) => <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? 'is-on' : ''} onClick={() => setKind(k)} data-testid={`tab-library-picker-${k}`}>{k === 'all' ? 'All' : KIND_LABELS[k]}</button>)}
            </div>}
            <div className="sfa-lib-picklist" aria-busy={query.isLoading}>
              {query.isError ? <ErrorState title="Couldn't load the library" onRetry={() => query.refetch()} />
                : query.isLoading ? [0, 1, 2].map((i) => <Skeleton key={i} height={54} radius={10} />)
                : items.length === 0 ? <EmptyState icon={<Library size={22} />} title="Nothing here" description={q || favorite ? 'No library items match. Clear the search or favorites filter.' : 'Your library has no items of this kind yet. Add some from the Library page.'} />
                : items.map((item) => <button key={item.id} type="button" className="sfa-lib-pickrow" disabled={use.isPending} onClick={() => choose(item)} data-testid={`button-library-pick-${item.id}`}>
                  {item.kind === 'media' ? <span className="sfa-lib-pickthumb"><LibraryThumb item={item} /></span> : null}
                  <span className="sfa-lib-pickmain"><strong>{item.title}</strong>
                    {item.kind !== 'media' && item.body && <span>{item.body}</span>}</span>
                  <em>{KIND_LABELS[item.kind]}</em>
                </button>)}
              {query.hasNextPage && <Button variant="outline" loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()} data-testid="button-library-picker-more">Load more</Button>}
            </div>
          </>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
