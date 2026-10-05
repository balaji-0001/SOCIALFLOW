import { useEffect, useId, useState, type FormEvent } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Folder, FolderPlus, Info, Library, Pencil, Plus, Search, Star, Trash2, X } from 'lucide-react';
import {
  getAuthMeQueryKey,
  getListLibraryFoldersQueryKey,
  getListLibraryItemsQueryKey,
  listLibraryItems,
  useAuthMe,
  useCreateLibraryFolder,
  useCreateLibraryItem,
  useDeleteLibraryFolder,
  useDeleteLibraryItem,
  useListLibraryFolders,
  useRenameLibraryFolder,
  useUpdateLibraryItem,
  type LibraryFolder,
  type LibraryItem,
  type LibraryKind,
  type ListLibraryItemsParams,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { useConfirm } from './confirm';
import { ALL_KINDS, KIND_LABELS, LibraryThumb, libErrorMessage } from './library-picker';
import { Button, EmptyState, ErrorState, IconButton, PageHeader, Skeleton } from './ui';
import './library.css';

type FolderSel = 'all' | 'none' | string;
type Sort = 'recent' | 'used' | 'name';
type Editing = { mode: 'create'; kind: LibraryKind } | { mode: 'edit'; item: LibraryItem } | null;

const SORTS: { id: Sort; label: string }[] = [{ id: 'recent', label: 'Recent' }, { id: 'used', label: 'Most used' }, { id: 'name', label: 'Name' }];
const TEXT_KINDS: LibraryKind[] = ['caption', 'template', 'snippet'];
const KIND_HINT: Record<LibraryKind, string> = {
  media: 'A saved image or video. Add media from the media tools elsewhere in the app.',
  caption: 'A ready-to-use post caption.',
  template: 'Text with placeholders written as {{name}}. You fill the values in when you use it.',
  snippet: 'A reusable piece of text such as a hashtag set, disclaimer or sign-off.',
};

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = window.setTimeout(() => setV(value), ms); return () => window.clearTimeout(t); }, [value, ms]);
  return v;
}

/* ---------- Item dialog ---------- */

function ItemDialog({ editing, folders, onClose }: { editing: Editing; folders: LibraryFolder[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const uid = useId();
  const item = editing?.mode === 'edit' ? editing.item : null;
  const kind: LibraryKind = editing ? (editing.mode === 'edit' ? editing.item.kind : editing.kind) : 'caption';
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState('');
  const [folderId, setFolderId] = useState('');
  const [favorite, setFavorite] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) return;
    const it = editing.mode === 'edit' ? editing.item : null;
    setTitle(it?.title ?? ''); setBody(it?.body ?? ''); setLabels(it?.labels.join(', ') ?? ''); setFolderId(it?.folderId ?? ''); setFavorite(it?.favorite ?? false); setError(null);
  }, [editing]);

  const done = () => {
    queryClient.invalidateQueries({ queryKey: [getListLibraryItemsQueryKey()[0]] });
    queryClient.invalidateQueries({ queryKey: getListLibraryFoldersQueryKey() });
    onClose();
  };
  const onError = (err: unknown) => setError(libErrorMessage(err) ?? "Couldn't save this item.");
  const create = useCreateLibraryItem({ mutation: { onSuccess: () => { toast({ title: 'Saved to library' }); done(); }, onError } });
  const update = useUpdateLibraryItem({ mutation: { onSuccess: () => { toast({ title: 'Library item updated' }); done(); }, onError } });
  const busy = create.isPending || update.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const t = title.trim();
    if (!t) { setError('Give this item a title.'); return; }
    if (kind !== 'media' && !body.trim()) { setError('Add some text.'); return; }
    const list = labels.split(',').map((l) => l.trim()).filter(Boolean);
    if (list.length > 20) { setError('Use at most 20 labels.'); return; }
    if (list.some((l) => l.length > 40)) { setError('Each label can be at most 40 characters.'); return; }
    setError(null);
    const common = { title: t, labels: list, folderId: folderId || null, favorite };
    if (item) update.mutate({ itemId: item.id, data: kind === 'media' ? common : { ...common, body } });
    else create.mutate({ data: { kind, ...common, body } });
  };

  return <DialogPrimitive.Root open={editing !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="sfa-overlay" />
      <DialogPrimitive.Content className="sfa-dialog" data-testid="dialog-library-item">
        <DialogPrimitive.Close asChild><button type="button" className="sfa-iconbtn sfa-dialog__close" aria-label="Close" data-testid="button-close-library-item"><X size={18} /></button></DialogPrimitive.Close>
        <DialogPrimitive.Title className="sfa-dialog__title">{item ? 'Edit' : 'New'} {KIND_LABELS[kind].toLowerCase().replace(/s$/, '')}</DialogPrimitive.Title>
        <DialogPrimitive.Description className="sfa-dialog__desc">{KIND_HINT[kind]}</DialogPrimitive.Description>
        <form className="sfa-lib-form" onSubmit={submit} noValidate>
          <div className="sfa-field">
            <label htmlFor={`${uid}-title`}>Title</label>
            <input id={`${uid}-title`} className="sfa-input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} data-testid="input-library-title" />
          </div>
          {kind !== 'media' && <div className="sfa-field">
            <label htmlFor={`${uid}-body`}>{kind === 'template' ? 'Template text' : 'Text'}</label>
            <textarea id={`${uid}-body`} className="sfa-textarea sfa-lib-textarea" rows={7} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} data-testid="input-library-body" />
            {kind === 'template' && <span className="sfa-field__hint">Write placeholders as {'{{name}}'}, for example {'Hi {{first_name}}, join us on {{date}}'}. You will be asked for each value when you use the template.</span>}
          </div>}
          <div className="sfa-field">
            <label htmlFor={`${uid}-labels`}>Labels</label>
            <input id={`${uid}-labels`} className="sfa-input" value={labels} placeholder="launch, evergreen" onChange={(e) => setLabels(e.target.value)} data-testid="input-library-labels" />
            <span className="sfa-field__hint">Separate with commas. Up to 20 labels of 40 characters.</span>
          </div>
          <div className="sfa-field">
            <label htmlFor={`${uid}-folder`}>Folder</label>
            <select id={`${uid}-folder`} className="sfa-select sfa-lib-select" value={folderId} onChange={(e) => setFolderId(e.target.value)} data-testid="select-library-folder">
              <option value="">No folder</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
          <label className="sfa-lib-check"><input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} data-testid="checkbox-library-favorite" /> Favorite</label>
          {error && <p className="sfa-lib-error" role="alert" data-testid="text-library-item-error">{error}</p>}
          <div className="sfa-lib-formactions">
            <Button variant="secondary" onClick={onClose} data-testid="button-library-item-cancel">Cancel</Button>
            <Button type="submit" variant="primary" loading={busy} data-testid="button-library-item-save">{item ? 'Save changes' : 'Save to library'}</Button>
          </div>
        </form>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

/* ---------- Folder dialog ---------- */

type FolderEditing = { mode: 'create' } | { mode: 'rename'; folder: LibraryFolder } | null;

function FolderDialog({ editing, onClose }: { editing: FolderEditing; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const uid = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (editing) { setName(editing.mode === 'rename' ? editing.folder.name : ''); setError(null); } }, [editing]);
  const done = () => { queryClient.invalidateQueries({ queryKey: getListLibraryFoldersQueryKey() }); onClose(); };
  const onError = (err: unknown) => setError(libErrorMessage(err) ?? "Couldn't save the folder.");
  const create = useCreateLibraryFolder({ mutation: { onSuccess: () => { toast({ title: 'Folder created' }); done(); }, onError } });
  const rename = useRenameLibraryFolder({ mutation: { onSuccess: () => { toast({ title: 'Folder renamed' }); done(); }, onError } });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const n = name.trim();
    if (!n) { setError('Enter a folder name.'); return; }
    setError(null);
    if (editing?.mode === 'rename') rename.mutate({ folderId: editing.folder.id, data: { name: n } });
    else create.mutate({ data: { name: n } });
  };
  return <DialogPrimitive.Root open={editing !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="sfa-overlay" />
      <DialogPrimitive.Content className="sfa-dialog sfa-lib-smalldialog" data-testid="dialog-library-folder">
        <DialogPrimitive.Close asChild><button type="button" className="sfa-iconbtn sfa-dialog__close" aria-label="Close"><X size={18} /></button></DialogPrimitive.Close>
        <DialogPrimitive.Title className="sfa-dialog__title">{editing?.mode === 'rename' ? 'Rename folder' : 'New folder'}</DialogPrimitive.Title>
        <DialogPrimitive.Description className="sr-only">Folder name, up to 80 characters.</DialogPrimitive.Description>
        <form className="sfa-lib-form" onSubmit={submit} noValidate>
          <div className="sfa-field">
            <label htmlFor={`${uid}-name`}>Name</label>
            <input id={`${uid}-name`} className="sfa-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-testid="input-library-folder-name" />
          </div>
          {error && <p className="sfa-lib-error" role="alert" data-testid="text-library-folder-error">{error}</p>}
          <div className="sfa-lib-formactions">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={create.isPending || rename.isPending} data-testid="button-library-folder-save">Save</Button>
          </div>
        </form>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

/* ---------- Card ---------- */

function ItemCard({ item, folderName, canWrite, onEdit }: { item: LibraryItem; folderName?: string; canWrite: boolean; onEdit: (i: LibraryItem) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [copied, setCopied] = useState(false);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: [getListLibraryItemsQueryKey()[0]] });
    queryClient.invalidateQueries({ queryKey: getListLibraryFoldersQueryKey() });
  };
  const fav = useUpdateLibraryItem({ mutation: { onSuccess: refresh, onError: (e) => toast({ title: "Couldn't update favorite", description: libErrorMessage(e), variant: 'destructive' }) } });
  const del = useDeleteLibraryItem({ mutation: { onSuccess: () => { toast({ title: 'Removed from library' }); refresh(); }, onError: (e) => toast({ title: "Couldn't delete", description: libErrorMessage(e), variant: 'destructive' }) } });

  const copy = async () => {
    if (!item.body) return;
    try { await navigator.clipboard.writeText(item.body); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { toast({ title: "Couldn't copy", description: 'Select the text and copy it manually.', variant: 'destructive' }); }
  };
  const remove = async () => {
    const ok = await confirm({
      title: `Delete "${item.title}"?`,
      description: item.kind === 'media'
        ? "This removes the library entry only. The uploaded file and any posts using it are not deleted."
        : 'This removes it from the library. Posts you already wrote with it are not changed.',
      confirmLabel: 'Delete', destructive: true,
    });
    if (ok) del.mutate({ itemId: item.id });
  };

  return <article className={`sfa-lib-card sfa-lib-card--${item.kind}`} data-testid={`card-library-${item.id}`}>
    {item.kind === 'media' && <LibraryThumb item={item} />}
    <div className="sfa-lib-card__body">
      <div className="sfa-lib-card__top">
        <span className="sfa-lib-kind">{KIND_LABELS[item.kind]}</span>
        <button type="button" className={`sfa-lib-star ${item.favorite ? 'is-on' : ''}`} aria-pressed={item.favorite} aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
          disabled={!canWrite || fav.isPending} onClick={() => fav.mutate({ itemId: item.id, data: { favorite: !item.favorite } })} data-testid={`button-library-favorite-${item.id}`}>
          <Star size={16} fill={item.favorite ? 'currentColor' : 'none'} />
        </button>
      </div>
      <h3 className="sfa-lib-card__title">{item.title}</h3>
      {item.kind !== 'media' && item.body && <p className="sfa-lib-card__text">{item.body}</p>}
      {item.kind === 'template' && item.placeholders.length > 0 && <p className="sfa-lib-card__ph">Placeholders: {item.placeholders.map((p) => `{{${p}}}`).join(' ')}</p>}
      {(item.labels.length > 0 || folderName) && <ul className="sfa-lib-chips" aria-label="Labels and folder">
        {folderName && <li className="sfa-lib-chip sfa-lib-chip--folder"><Folder size={11} /> {folderName}</li>}
        {item.labels.map((l) => <li className="sfa-lib-chip" key={l}>{l}</li>)}
      </ul>}
      <p className="sfa-lib-card__meta">Used {item.useCount} {item.useCount === 1 ? 'time' : 'times'}</p>
      <div className="sfa-lib-card__actions">
        {item.kind !== 'media' && <Button size="sm" variant="outline" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={copy} data-testid={`button-library-copy-${item.id}`}>{copied ? 'Copied' : 'Copy'}</Button>}
        {canWrite && <>
          <IconButton label={`Edit ${item.title}`} onClick={() => onEdit(item)} data-testid={`button-library-edit-${item.id}`}><Pencil size={15} /></IconButton>
          <IconButton label={`Delete ${item.title}`} onClick={remove} disabled={del.isPending} data-testid={`button-library-delete-${item.id}`}><Trash2 size={15} /></IconButton>
        </>}
      </div>
    </div>
  </article>;
}

/* ---------- Page ---------- */

export function LibraryPage() {
  const me = useAuthMe({ query: { queryKey: getAuthMeQueryKey(), retry: false } });
  const canWrite = me.data?.permissions?.includes('library:write') ?? false;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [kind, setKind] = useState<LibraryKind | 'all'>('all');
  const [folder, setFolder] = useState<FolderSel>('all');
  const [favorite, setFavorite] = useState(false);
  const [sort, setSort] = useState<Sort>('recent');
  const [editing, setEditing] = useState<Editing>(null);
  const [folderEditing, setFolderEditing] = useState<FolderEditing>(null);

  const foldersQuery = useListLibraryFolders({ query: { queryKey: getListLibraryFoldersQueryKey() } });
  const folders = foldersQuery.data?.folders ?? [];
  const folderById = new Map(folders.map((f) => [f.id, f.name]));

  const params: ListLibraryItemsParams = {
    limit: 24, sort,
    ...(q ? { q } : {}), ...(kind !== 'all' ? { kind } : {}), ...(folder !== 'all' ? { folder } : {}), ...(favorite ? { favorite: true } : {}),
  };
  const query = useInfiniteQuery({
    queryKey: [...getListLibraryItemsQueryKey(params), 'page'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => listLibraryItems({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = q !== '' || kind !== 'all' || folder !== 'all' || favorite;

  const delFolder = useDeleteLibraryFolder({
    mutation: {
      onSuccess: () => {
        toast({ title: 'Folder deleted', description: 'Its items were moved to no folder.' });
        queryClient.invalidateQueries({ queryKey: getListLibraryFoldersQueryKey() });
        queryClient.invalidateQueries({ queryKey: [getListLibraryItemsQueryKey()[0]] });
      },
      onError: (e) => toast({ title: "Couldn't delete the folder", description: libErrorMessage(e), variant: 'destructive' }),
    },
  });
  const removeFolder = async (f: LibraryFolder) => {
    const ok = await confirm({ title: `Delete folder "${f.name}"?`, description: 'The items in it are not deleted. They move to "no folder".', confirmLabel: 'Delete folder', destructive: true });
    if (!ok) return;
    if (folder === f.id) setFolder('all');
    delFolder.mutate({ folderId: f.id });
  };

  const newKinds = TEXT_KINDS;

  return <div className="sfa-page sfa-lib" data-testid="page-library">
    <PageHeader title="Content library" description="Save captions, templates, snippets and media once, then reuse them in any post."
      actions={canWrite ? <div className="sfa-lib-new" role="group" aria-label="Create a library item">
        {newKinds.map((k) => <Button key={k} variant={k === 'caption' ? 'primary' : 'outline'} size="sm" icon={<Plus size={14} />} onClick={() => setEditing({ mode: 'create', kind: k })} data-testid={`button-library-new-${k}`}>{KIND_LABELS[k].replace(/s$/, '')}</Button>)}
      </div> : undefined} />
    {me.data && !canWrite && <p className="sfa-lib-note" data-testid="text-library-readonly"><Info size={15} /> Your role can view and copy library items but not change them.</p>}

    <div className="sfa-lib-layout">
      <aside className="sfa-lib-side" aria-label="Folders">
        <div className="sfa-lib-side__head"><h2>Folders</h2>
          {canWrite && <IconButton label="New folder" onClick={() => setFolderEditing({ mode: 'create' })} data-testid="button-library-new-folder"><FolderPlus size={16} /></IconButton>}
        </div>
        <ul className="sfa-lib-folders">
          <li><button type="button" className={folder === 'all' ? 'is-on' : ''} aria-pressed={folder === 'all'} onClick={() => setFolder('all')} data-testid="button-library-folder-all">All items</button></li>
          <li><button type="button" className={folder === 'none' ? 'is-on' : ''} aria-pressed={folder === 'none'} onClick={() => setFolder('none')} data-testid="button-library-folder-none">No folder</button></li>
          {folders.map((f) => <li key={f.id} className="sfa-lib-folderrow">
            <button type="button" className={folder === f.id ? 'is-on' : ''} aria-pressed={folder === f.id} onClick={() => setFolder(f.id)} data-testid={`button-library-folder-${f.id}`}>
              <span className="sfa-lib-foldername">{f.name}</span><em>{f.itemCount}</em>
            </button>
            {canWrite && <span className="sfa-lib-folderact">
              <IconButton label={`Rename ${f.name}`} onClick={() => setFolderEditing({ mode: 'rename', folder: f })} data-testid={`button-library-folder-rename-${f.id}`}><Pencil size={13} /></IconButton>
              <IconButton label={`Delete ${f.name}`} onClick={() => removeFolder(f)} data-testid={`button-library-folder-delete-${f.id}`}><Trash2 size={13} /></IconButton>
            </span>}
          </li>)}
        </ul>
        {foldersQuery.isLoading && <Skeleton height={30} radius={8} />}
        {foldersQuery.isError && <p className="sfa-lib-error" role="alert">Couldn't load folders.</p>}
        {!foldersQuery.isLoading && !foldersQuery.isError && folders.length === 0 && <p className="sfa-lib-muted">No folders yet.{canWrite ? ' Create one to organise items.' : ''}</p>}
        <p className="sfa-lib-muted sfa-lib-side__note"><Info size={12} /> Deleting a folder does not delete its items. They move to "No folder".</p>
      </aside>

      <section className="sfa-lib-main">
        <div className="sfa-lib-toolbar">
          <div className="sfa-lib-search"><Search size={15} aria-hidden="true" />
            <input className="sfa-input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search titles and text" aria-label="Search the library" data-testid="input-library-search" /></div>
          <div className="sfa-lib-tabs" role="group" aria-label="Kind">
            {(['all', ...ALL_KINDS] as const).map((k) => <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? 'is-on' : ''} onClick={() => setKind(k)} data-testid={`tab-library-${k}`}>{k === 'all' ? 'All' : KIND_LABELS[k]}</button>)}
          </div>
          <button type="button" className={`sfa-lib-favbtn ${favorite ? 'is-on' : ''}`} aria-pressed={favorite} onClick={() => setFavorite((f) => !f)} data-testid="button-library-favorites"><Star size={14} /> Favorites</button>
          <select className="sfa-select sfa-lib-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by" data-testid="select-library-sort">
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>

        <div aria-busy={query.isLoading}>
          {query.isError ? <ErrorState title="Couldn't load the library" onRetry={() => query.refetch()} />
            : query.isLoading ? <div className="sfa-lib-grid">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={170} radius={12} />)}</div>
            : items.length === 0 ? (filtered
              ? <EmptyState icon={<Search size={22} />} title="Nothing matches" description="No library items match these filters. Clear the search, folder or favorites filter."
                action={<Button variant="outline" onClick={() => { setSearch(''); setKind('all'); setFolder('all'); setFavorite(false); }} data-testid="button-library-clear">Clear filters</Button>} />
              : <EmptyState icon={<Library size={22} />} title="Your library is empty"
                description={canWrite ? 'Save a caption, template or snippet with the buttons above. Media is added to the library from your uploads elsewhere in the app.' : 'Nothing has been saved yet. Someone who can edit the library needs to add items.'} />)
            : <>
              <div className="sfa-lib-grid" data-testid="list-library-items">
                {items.map((item) => <ItemCard key={item.id} item={item} canWrite={canWrite} folderName={item.folderId ? folderById.get(item.folderId) : undefined} onEdit={(i) => setEditing({ mode: 'edit', item: i })} />)}
              </div>
              {query.hasNextPage && <div className="sfa-lib-more"><Button variant="outline" loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()} data-testid="button-library-load-more">Load more</Button></div>}
              {query.isFetchNextPageError && <p className="sfa-lib-error" role="alert">Couldn't load more items. Try again.</p>}
            </>}
        </div>
      </section>
    </div>

    <ItemDialog editing={editing} folders={folders} onClose={() => setEditing(null)} />
    <FolderDialog editing={folderEditing} onClose={() => setFolderEditing(null)} />
  </div>;
}
