import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useLocation, useSearch } from 'wouter';
import { ArrowDown, ArrowUp, AtSign, Check, CircleHelp, Info, ListChecks, Lock, Pencil, Plus, Send, Tag as TagIcon, Trash2, User, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getListCustomFieldsQueryKey,
  getListMentionGroupsQueryKey,
  getListTagsQueryKey,
  useCreateCustomField,
  useCreateMentionGroup,
  useCreateTag,
  useDeleteCustomField,
  useDeleteMentionGroup,
  useDeleteTag,
  useListCustomFields,
  useListMentionGroups,
  useListTags,
  useUpdateCustomField,
  useUpdateMentionGroup,
  useUpdateTag,
  type CustomField,
  type CustomFieldInputType,
  type MentionGroup,
  type Tag,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { useConfirm } from './confirm';
import { Button, EmptyState, ErrorState, IconButton, PageHeader, Skeleton } from './ui';
import { HelpTab, ProfileTab, PublishingTab, SecurityTab } from './settings-extra';
import './settings.css';

/* ---------- Shared helpers ---------- */

type SettingsTab = 'profile' | 'publishing' | 'tags' | 'fields' | 'mentions' | 'security' | 'help';
const TABS: { id: SettingsTab; label: string; Icon: typeof TagIcon }[] = [
  { id: 'profile', label: 'Profile & workspace', Icon: User },
  { id: 'publishing', label: 'Publishing', Icon: Send },
  { id: 'tags', label: 'Tags', Icon: TagIcon },
  { id: 'fields', label: 'Custom fields', Icon: ListChecks },
  { id: 'mentions', label: 'Mention groups', Icon: AtSign },
  { id: 'security', label: 'Security', Icon: Lock },
  { id: 'help', label: 'Help', Icon: CircleHelp },
];
const isTab = (value: string | null): value is SettingsTab => TABS.some((tab) => tab.id === value);
const readTab = (search: string): SettingsTab => {
  const value = new URLSearchParams(search.startsWith('?') ? search : `?${search}`).get('tab');
  return isTab(value) ? value : 'profile';
};

/** Pulls the server's message out of an ApiError without depending on its class. */
function errorMessage(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const message = (data as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}
const errorStatus = (err: unknown): number | undefined => (typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : undefined);
/** 400 and 409 are things the user can fix in the form; everything else is reported in a toast. */
const isFormError = (err: unknown) => { const status = errorStatus(err); return status === 400 || status === 409; };

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

function ListSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return <ul className="sfa-set-list" aria-busy="true" aria-label={label}>
    {Array.from({ length: rows }, (_, i) => <li key={i} className="sfa-set-skelrow">
      <Skeleton width={22} height={22} radius={999} />
      <Skeleton width={`${46 - i * 9}%`} />
      <Skeleton width={64} height={22} radius={999} />
    </li>)}
  </ul>;
}

function Note({ children }: { children: ReactNode }) {
  return <p className="sfa-set-note" role="note"><Info size={15} />{children}</p>;
}

/* ---------- Tags ---------- */

const PRESET_COLORS = ['#6366f1', '#ec4899', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6'];

function ColorPicker({ value, onChange, onCommit, testid, label, compact = false }: { value: string; onChange: (color: string) => void; onCommit?: (color: string) => void; testid: string; label: string; compact?: boolean }) {
  const pick = (color: string) => { onChange(color); onCommit?.(color); };
  return <div className={`sfa-set-color ${compact ? 'sfa-set-color--compact' : ''}`} role="group" aria-label={label}>
    {PRESET_COLORS.map((color) => <button type="button" key={color} className={`sfa-set-color__preset ${value.toLowerCase() === color ? 'is-on' : ''}`}
      style={{ '--sfa-swatch': color } as CSSProperties} aria-label={`Colour ${color}`} aria-pressed={value.toLowerCase() === color}
      onClick={() => pick(color)} data-testid={`${testid}-preset-${color.slice(1)}`} />)}
    <label className="sfa-set-color__custom">
      <span className="sr-only">Custom colour</span>
      <input type="color" value={value} onChange={(event) => onChange(event.target.value)} onBlur={(event) => onCommit?.(event.target.value)} data-testid={`${testid}-custom`} />
      <span className="sfa-set-color__hex" aria-hidden="true">{value.toLowerCase()}</span>
    </label>
  </div>;
}

function NewTagForm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]!);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const create = useCreateTag({
    mutation: {
      onSuccess: (tag) => {
        queryClient.invalidateQueries({ queryKey: [getListTagsQueryKey()[0]] });
        toast({ title: 'Tag created', description: `“${tag.name}” is ready to use in the composer.` });
        setName(''); setError(null);
      },
      onError: (err) => {
        if (isFormError(err)) setError(err.data?.message ?? 'A tag with that name already exists.');
        else toast({ title: "Couldn't create the tag", description: err.data?.message ?? undefined, variant: 'destructive' });
      },
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError('Give the tag a name.'); return; }
    create.mutate({ data: { name: trimmed, color } });
  };
  return <form className="sfa-set-create" onSubmit={submit} aria-label="New tag" noValidate>
    <h3>New tag</h3>
    <div className="sfa-set-formrow">
      <div className="sfa-field">
        <label htmlFor="sfa-set-tag-name">Name</label>
        <input id="sfa-set-tag-name" className="sfa-input" value={name} maxLength={60} placeholder="e.g. Product launch" autoComplete="off"
          aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
          onChange={(event) => { setName(event.target.value); if (error) setError(null); }} data-testid="input-tag-name" />
      </div>
      <div className="sfa-field">
        <span className="sfa-label" id="sfa-set-tag-color-label">Colour</span>
        <ColorPicker value={color} onChange={setColor} testid="color-new" label="New tag colour" />
      </div>
      <div className="sfa-set-actions">
        <Button type="submit" variant="primary" icon={<Plus size={15} />} loading={create.isPending} data-testid="button-tag-create">Add tag</Button>
      </div>
    </div>
    {error && <p className="sfa-set-error sfa-set-formerr" id={errorId} role="alert" data-testid="text-tag-error">{error}</p>}
  </form>;
}

function TagRow({ tag }: { tag: Tag }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const refresh = () => queryClient.invalidateQueries({ queryKey: [getListTagsQueryKey()[0]] });

  useEffect(() => { if (!editing) setColor(tag.color); }, [tag.color, editing]);
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);

  const update = useUpdateTag({
    mutation: {
      onSuccess: (_, variables) => {
        refresh();
        if (variables.data.name !== undefined) { setEditing(false); setError(null); toast({ title: 'Tag renamed' }); }
        else toast({ title: 'Colour updated' });
      },
      onError: (err, variables) => {
        if (variables.data.name !== undefined && isFormError(err)) { setError(err.data?.message ?? 'A tag with that name already exists.'); inputRef.current?.focus(); return; }
        if (variables.data.color !== undefined) setColor(tag.color);
        toast({ title: "Couldn't update the tag", description: err.data?.message ?? undefined, variant: 'destructive' });
      },
    },
  });
  const remove = useDeleteTag({
    mutation: {
      onSuccess: () => { refresh(); toast({ title: 'Tag deleted', description: `“${tag.name}” was removed from ${plural(tag.postCount ?? 0, 'post')}.` }); },
      onError: (err) => { refresh(); toast({ title: "Couldn't delete the tag", description: err.data?.message ?? undefined, variant: 'destructive' }); },
    },
  });

  const startEditing = () => { setDraft(tag.name); setError(null); setEditing(true); };
  const cancel = () => { setEditing(false); setError(null); setDraft(tag.name); };
  const save = () => {
    const trimmed = draft.trim();
    if (!trimmed) { setError('Give the tag a name.'); return; }
    if (trimmed === tag.name) { cancel(); return; }
    update.mutate({ tagId: tag.id, data: { name: trimmed } });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); save(); }
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
  };
  const commitColor = (next: string) => { if (next.toLowerCase() !== tag.color.toLowerCase()) update.mutate({ tagId: tag.id, data: { color: next } }); };
  const busy = update.isPending || remove.isPending;

  return <li className="sfa-set-row sfa-set-row--tag" data-testid={`row-tag-${tag.id}`}>
    <span className="sfa-set-swatch" style={{ background: color }} aria-hidden="true" />
    <div className="sfa-set-row__main">
      {editing
        ? <div className="sfa-set-nameform">
            <div className="sfa-field">
              <label htmlFor={`sfa-set-rename-${tag.id}`} className="sr-only">Tag name</label>
              <input id={`sfa-set-rename-${tag.id}`} ref={inputRef} className="sfa-input sfa-set-nameinput" value={draft} maxLength={60} disabled={update.isPending}
                aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
                onChange={(event) => { setDraft(event.target.value); if (error) setError(null); }} onKeyDown={onKeyDown} data-testid={`input-tag-rename-${tag.id}`} />
            </div>
            <IconButton label="Save name" onClick={save} disabled={update.isPending} data-testid={`button-tag-rename-save-${tag.id}`}><Check size={15} /></IconButton>
            <IconButton label="Cancel rename" onClick={cancel} disabled={update.isPending} data-testid={`button-tag-rename-cancel-${tag.id}`}><X size={15} /></IconButton>
            {error && <p className="sfa-set-error" id={errorId} role="alert" style={{ flexBasis: '100%' }}>{error}</p>}
          </div>
        : <div className="sfa-set-row__title">
            <button type="button" className="sfa-set-namebtn" onClick={startEditing} title="Rename tag" aria-label={`Rename tag ${tag.name}`} data-testid={`button-tag-rename-${tag.id}`}>{tag.name}</button>
            <span className="sfa-set-row__meta sfa-num">{plural(tag.postCount ?? 0, 'post')}</span>
          </div>}
    </div>
    <ColorPicker value={color} onChange={setColor} onCommit={commitColor} testid={`color-tag-${tag.id}`} label={`Colour for ${tag.name}`} compact />
    <span className="sfa-set-row__actions">
      <IconButton label={`Delete tag ${tag.name}`} className="sfa-iconbtn--danger" disabled={busy}
        onClick={async () => { if (await confirm({ title: `Delete “${tag.name}”?`, description: 'Posts keep everything else; only the tag is removed.', confirmLabel: 'Delete tag', destructive: true })) remove.mutate({ tagId: tag.id }); }}
        data-testid={`button-tag-delete-${tag.id}`}><Trash2 size={15} /></IconButton>
    </span>
  </li>;
}

function TagsTab() {
  const { data, isLoading, isError, refetch } = useListTags({ query: { queryKey: getListTagsQueryKey() } });
  const tags = useMemo(() => [...(data?.tags ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [data]);
  return <div data-testid="panel-tags">
    <NewTagForm />
    {isError ? <ErrorState title="Couldn't load your tags" onRetry={() => refetch()} />
      : isLoading ? <ListSkeleton label="Loading tags" />
      : tags.length === 0
        ? <EmptyState icon={<TagIcon size={22} />} title="No tags yet" description="Tags help you group posts by campaign, theme or client. Create one above and it will show up in the composer." />
        : <ul className="sfa-set-list" aria-label="Tags">{tags.map((tag) => <TagRow key={tag.id} tag={tag} />)}</ul>}
  </div>;
}

/* ---------- Custom fields ---------- */

const FIELD_TYPES: { value: CustomFieldInputType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Select (choose one)' },
  { value: 'url', label: 'URL' },
];
const FIELD_TYPE_LABEL: Record<CustomFieldInputType, string> = { text: 'Text', number: 'Number', date: 'Date', select: 'Select', url: 'URL' };

const parseOptions = (raw: string) => [...new Set(raw.split(',').map((option) => option.trim()).filter(Boolean))];

type FieldDraft = { label: string; type: CustomFieldInputType; options: string; required: boolean };
const validateField = (draft: FieldDraft): { ok: true; value: { label: string; type: CustomFieldInputType; options: string[]; required: boolean } } | { ok: false; message: string } => {
  const label = draft.label.trim();
  if (!label) return { ok: false, message: 'Give the field a label.' };
  const options = draft.type === 'select' ? parseOptions(draft.options) : [];
  if (draft.type === 'select' && options.length === 0) return { ok: false, message: 'A select field needs at least one option. Separate options with commas.' };
  if (options.some((option) => option.length > 80)) return { ok: false, message: 'Keep each option under 80 characters.' };
  return { ok: true, value: { label, type: draft.type, options, required: draft.required } };
};

function FieldFormFields({ draft, onChange, idPrefix, testPrefix, disabled }: { draft: FieldDraft; onChange: (next: FieldDraft) => void; idPrefix: string; testPrefix: string; disabled?: boolean }) {
  return <>
    <div className="sfa-field">
      <label htmlFor={`${idPrefix}-label`}>Label</label>
      <input id={`${idPrefix}-label`} className="sfa-input" value={draft.label} maxLength={80} placeholder="e.g. Campaign" autoComplete="off" disabled={disabled}
        onChange={(event) => onChange({ ...draft, label: event.target.value })} data-testid={`${testPrefix}-label`} />
    </div>
    <div className="sfa-field">
      <label htmlFor={`${idPrefix}-type`}>Type</label>
      <select id={`${idPrefix}-type`} className="sfa-select sfa-set-select" value={draft.type} disabled={disabled}
        onChange={(event) => onChange({ ...draft, type: event.target.value as CustomFieldInputType })} data-testid={`${testPrefix}-type`}>
        {FIELD_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
      </select>
    </div>
    <div className="sfa-field">
      <label htmlFor={`${idPrefix}-options`}>Options{draft.type === 'select' ? '' : <span className="sfa-muted"> (select only)</span>}</label>
      <input id={`${idPrefix}-options`} className="sfa-input" value={draft.options} placeholder="Comma-separated, e.g. Draft, In review, Approved" autoComplete="off"
        disabled={disabled || draft.type !== 'select'} required={draft.type === 'select'} aria-required={draft.type === 'select'}
        onChange={(event) => onChange({ ...draft, options: event.target.value })} data-testid={`${testPrefix}-options`} />
    </div>
    <label className="sfa-set-check">
      <input type="checkbox" checked={draft.required} disabled={disabled} onChange={(event) => onChange({ ...draft, required: event.target.checked })} data-testid={`${testPrefix}-required`} />
      Required
    </label>
  </>;
}

const EMPTY_FIELD: FieldDraft = { label: '', type: 'text', options: '', required: false };

function NewFieldForm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<FieldDraft>(EMPTY_FIELD);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const create = useCreateCustomField({
    mutation: {
      onSuccess: (field) => {
        queryClient.invalidateQueries({ queryKey: [getListCustomFieldsQueryKey()[0]] });
        toast({ title: 'Field added', description: `“${field.label}” now appears in the composer.` });
        setDraft(EMPTY_FIELD); setError(null);
      },
      onError: (err) => {
        if (isFormError(err)) setError(err.data?.message ?? 'Check the field details and try again.');
        else toast({ title: "Couldn't add the field", description: err.data?.message ?? undefined, variant: 'destructive' });
      },
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateField(draft);
    if (!result.ok) { setError(result.message); return; }
    setError(null);
    create.mutate({ data: result.value });
  };
  return <form className="sfa-set-create" onSubmit={submit} aria-label="New custom field" aria-describedby={error ? errorId : undefined} noValidate>
    <h3>New field</h3>
    <div className="sfa-set-formrow sfa-set-formrow--fields">
      <FieldFormFields draft={draft} onChange={(next) => { setDraft(next); if (error) setError(null); }} idPrefix="sfa-set-newfield" testPrefix="input-field" />
      <div className="sfa-set-actions">
        <Button type="submit" variant="primary" icon={<Plus size={15} />} loading={create.isPending} data-testid="button-field-create">Add field</Button>
      </div>
    </div>
    {error && <p className="sfa-set-error sfa-set-formerr" id={errorId} role="alert" data-testid="text-field-error">{error}</p>}
  </form>;
}

function FieldRow({ field, index, count, onMove, moving }: { field: CustomField; index: number; count: number; onMove: (index: number, direction: -1 | 1) => void; moving: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<FieldDraft>({ label: field.label, type: field.type, options: field.options.join(', '), required: field.required });
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const refresh = () => queryClient.invalidateQueries({ queryKey: [getListCustomFieldsQueryKey()[0]] });

  const update = useUpdateCustomField({
    mutation: {
      onSuccess: (saved, variables) => {
        refresh();
        if (variables.data.label !== undefined) { setEditing(false); setError(null); toast({ title: 'Field updated' }); }
        else if (variables.data.required !== undefined) toast({ title: saved.required ? `“${saved.label}” is now required` : `“${saved.label}” is now optional` });
      },
      onError: (err, variables) => {
        if (variables.data.label !== undefined && isFormError(err)) { setError(err.data?.message ?? 'Check the field details and try again.'); return; }
        toast({ title: "Couldn't update the field", description: err.data?.message ?? undefined, variant: 'destructive' });
      },
    },
  });
  const remove = useDeleteCustomField({
    mutation: {
      onSuccess: () => { refresh(); toast({ title: 'Field deleted', description: `“${field.label}” was removed from the composer.` }); },
      onError: (err) => { refresh(); toast({ title: "Couldn't delete the field", description: err.data?.message ?? undefined, variant: 'destructive' }); },
    },
  });

  const startEditing = () => { setDraft({ label: field.label, type: field.type, options: field.options.join(', '), required: field.required }); setError(null); setEditing(true); };
  const cancel = () => { setEditing(false); setError(null); };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const result = validateField(draft);
    if (!result.ok) { setError(result.message); return; }
    update.mutate({ fieldId: field.id, data: result.value });
  };
  const busy = update.isPending || remove.isPending || moving;

  if (editing) {
    return <li className="sfa-set-row sfa-set-row--edit" data-testid={`row-field-${field.id}`}>
      <form className="sfa-form" onSubmit={save} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } }} aria-label={`Edit field ${field.label}`} aria-describedby={error ? errorId : undefined} noValidate>
        <div className="sfa-set-editgrid">
          <FieldFormFields draft={draft} onChange={(next) => { setDraft(next); if (error) setError(null); }} idPrefix={`sfa-set-field-${field.id}`} testPrefix={`input-field-edit-${field.id}`} disabled={update.isPending} />
        </div>
        {error && <p className="sfa-set-error" id={errorId} role="alert">{error}</p>}
        <div className="sfa-set-actions">
          <Button type="submit" variant="primary" size="sm" loading={update.isPending} data-testid={`button-field-edit-save-${field.id}`}>Save changes</Button>
          <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={update.isPending} data-testid={`button-field-edit-cancel-${field.id}`}>Cancel</Button>
        </div>
      </form>
    </li>;
  }

  return <li className="sfa-set-row sfa-set-row--field" data-testid={`row-field-${field.id}`}>
    <span className="sfa-set-row__actions" aria-label="Reorder">
      <IconButton label={`Move ${field.label} up`} disabled={busy || index === 0} onClick={() => onMove(index, -1)} data-testid={`button-field-up-${field.id}`}><ArrowUp size={15} /></IconButton>
      <IconButton label={`Move ${field.label} down`} disabled={busy || index === count - 1} onClick={() => onMove(index, 1)} data-testid={`button-field-down-${field.id}`}><ArrowDown size={15} /></IconButton>
    </span>
    <div className="sfa-set-row__main">
      <div className="sfa-set-row__title">
        <strong>{field.label}</strong>
        <span className="sfa-set-type">{FIELD_TYPE_LABEL[field.type]}</span>
        <span className="sfa-set-key" title="Field key">{field.key}</span>
      </div>
      {field.type === 'select' && field.options.length > 0 && <div className="sfa-set-opts" aria-label={`Options for ${field.label}`}>{field.options.map((option) => <span className="sfa-set-opt" key={option}>{option}</span>)}</div>}
    </div>
    <button type="button" role="switch" aria-checked={field.required} className="sfa-set-switch" disabled={busy}
      onClick={() => update.mutate({ fieldId: field.id, data: { required: !field.required } })} data-testid={`switch-field-required-${field.id}`}>
      <span className="sfa-set-switch__track" aria-hidden="true" />Required
    </button>
    <span className="sfa-set-row__actions">
      <IconButton label={`Edit field ${field.label}`} disabled={busy} onClick={startEditing} data-testid={`button-field-edit-${field.id}`}><Pencil size={15} /></IconButton>
      <IconButton label={`Delete field ${field.label}`} className="sfa-iconbtn--danger" disabled={busy}
        onClick={async () => { if (await confirm({ title: `Delete “${field.label}”?`, description: 'The field disappears from the composer. Values already saved on posts are no longer shown.', confirmLabel: 'Delete field', destructive: true })) remove.mutate({ fieldId: field.id }); }}
        data-testid={`button-field-delete-${field.id}`}><Trash2 size={15} /></IconButton>
    </span>
  </li>;
}

function FieldsTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, isError, refetch } = useListCustomFields({ query: { queryKey: getListCustomFieldsQueryKey() } });
  const fields = useMemo(() => [...(data?.fields ?? [])].sort((a, b) => a.position - b.position || a.label.localeCompare(b.label)), [data]);
  const [moving, setMoving] = useState(false);
  const reorder = useUpdateCustomField();

  /** Swap with a neighbour, then renumber so every position matches its index (the API stores positions as given). */
  const move = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= fields.length || moving) return;
    const next = [...fields];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(target, 0, item);
    setMoving(true);
    try {
      for (const [position, field] of next.entries()) {
        if (field.position !== position) await reorder.mutateAsync({ fieldId: field.id, data: { position } });
      }
      toast({ title: `Moved “${item.label}” ${direction === -1 ? 'up' : 'down'}` });
    } catch (err) {
      toast({ title: "Couldn't reorder the fields", description: errorMessage(err), variant: 'destructive' });
    } finally {
      setMoving(false);
      queryClient.invalidateQueries({ queryKey: [getListCustomFieldsQueryKey()[0]] });
    }
  };

  return <div data-testid="panel-fields">
    <NewFieldForm />
    <div style={{ paddingTop: 'var(--space-4)' }}>
      <Note>Fields appear in the composer and are saved with each post.</Note>
    </div>
    {isError ? <ErrorState title="Couldn't load your custom fields" onRetry={() => refetch()} />
      : isLoading ? <ListSkeleton label="Loading custom fields" />
      : fields.length === 0
        ? <EmptyState icon={<ListChecks size={22} />} title="No custom fields" description="Add a field above to capture extra details, like a campaign name or approval status, with every post." />
        : <ul className="sfa-set-list" aria-label="Custom fields" aria-busy={moving || undefined}>
            {fields.map((field, index) => <FieldRow key={field.id} field={field} index={index} count={fields.length} onMove={move} moving={moving} />)}
          </ul>}
  </div>;
}

/* ---------- Mention groups ---------- */

const HANDLE_PATTERN = /^@?[A-Za-z0-9._-]{1,64}$/;
/** Accepts one handle per line or a comma-separated list; returns normalised "@name" handles or a message. */
const parseHandles = (raw: string): { ok: true; handles: string[] } | { ok: false; message: string } => {
  const pieces = raw.split(/[\s,]+/).map((piece) => piece.trim()).filter(Boolean);
  if (pieces.length === 0) return { ok: false, message: 'Add at least one handle.' };
  const bad = pieces.find((piece) => !HANDLE_PATTERN.test(piece));
  if (bad) return { ok: false, message: `“${bad}” isn’t a valid handle. Use letters, numbers, dots, dashes or underscores.` };
  const handles = [...new Set(pieces.map((piece) => (piece.startsWith('@') ? piece : `@${piece}`)))];
  if (handles.length > 50) return { ok: false, message: 'A group can hold up to 50 handles.' };
  return { ok: true, handles };
};

function GroupFormFields({ name, handles, onName, onHandles, idPrefix, testPrefix, disabled, nameError }: { name: string; handles: string; onName: (value: string) => void; onHandles: (value: string) => void; idPrefix: string; testPrefix: string; disabled?: boolean; nameError?: boolean }) {
  return <>
    <div className="sfa-field">
      <label htmlFor={`${idPrefix}-name`}>Group name</label>
      <input id={`${idPrefix}-name`} className="sfa-input" value={name} maxLength={60} placeholder="e.g. Launch partners" autoComplete="off" disabled={disabled} aria-invalid={nameError || undefined}
        onChange={(event) => onName(event.target.value)} data-testid={`${testPrefix}-name`} />
    </div>
    <div className="sfa-field">
      <label htmlFor={`${idPrefix}-handles`}>Handles</label>
      <textarea id={`${idPrefix}-handles`} className="sfa-textarea sfa-set-textarea" value={handles} rows={3} placeholder={'@partner\n@agency, @studio'} disabled={disabled} spellCheck={false}
        onChange={(event) => onHandles(event.target.value)} data-testid={`${testPrefix}-handles`} />
      <p className="sfa-set-help">One per line or separated by commas. The @ is optional.</p>
    </div>
  </>;
}

function NewGroupForm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [handles, setHandles] = useState('');
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const create = useCreateMentionGroup({
    mutation: {
      onSuccess: (group) => {
        queryClient.invalidateQueries({ queryKey: [getListMentionGroupsQueryKey()[0]] });
        toast({ title: 'Mention group created', description: `“${group.name}” has ${plural(group.handles.length, 'handle')}.` });
        setName(''); setHandles(''); setError(null);
      },
      onError: (err) => {
        if (isFormError(err)) setError(err.data?.message ?? 'A group with that name already exists.');
        else toast({ title: "Couldn't create the group", description: err.data?.message ?? undefined, variant: 'destructive' });
      },
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError('Give the group a name.'); return; }
    const parsed = parseHandles(handles);
    if (!parsed.ok) { setError(parsed.message); return; }
    setError(null);
    create.mutate({ data: { name: trimmed, handles: parsed.handles } });
  };
  return <form className="sfa-set-create" onSubmit={submit} aria-label="New mention group" aria-describedby={error ? errorId : undefined} noValidate>
    <h3>New group</h3>
    <div className="sfa-set-formrow sfa-set-formrow--groups">
      <GroupFormFields name={name} handles={handles} onName={(value) => { setName(value); if (error) setError(null); }} onHandles={(value) => { setHandles(value); if (error) setError(null); }}
        idPrefix="sfa-set-newgroup" testPrefix="input-group" />
      <div className="sfa-set-actions">
        <Button type="submit" variant="primary" icon={<Plus size={15} />} loading={create.isPending} data-testid="button-group-create">Add group</Button>
      </div>
    </div>
    {error && <p className="sfa-set-error sfa-set-formerr" id={errorId} role="alert" data-testid="text-group-error">{error}</p>}
  </form>;
}

function GroupRow({ group }: { group: MentionGroup }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [handles, setHandles] = useState(group.handles.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const refresh = () => queryClient.invalidateQueries({ queryKey: [getListMentionGroupsQueryKey()[0]] });

  const update = useUpdateMentionGroup({
    mutation: {
      onSuccess: () => { refresh(); setEditing(false); setError(null); toast({ title: 'Mention group updated' }); },
      onError: (err) => {
        if (isFormError(err)) { setError(err.data?.message ?? 'Check the group details and try again.'); return; }
        toast({ title: "Couldn't update the group", description: err.data?.message ?? undefined, variant: 'destructive' });
      },
    },
  });
  const remove = useDeleteMentionGroup({
    mutation: {
      onSuccess: () => { refresh(); toast({ title: 'Mention group deleted', description: `“${group.name}” was removed.` }); },
      onError: (err) => { refresh(); toast({ title: "Couldn't delete the group", description: err.data?.message ?? undefined, variant: 'destructive' }); },
    },
  });

  const startEditing = () => { setName(group.name); setHandles(group.handles.join('\n')); setError(null); setEditing(true); };
  const cancel = () => { setEditing(false); setError(null); };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError('Give the group a name.'); return; }
    const parsed = parseHandles(handles);
    if (!parsed.ok) { setError(parsed.message); return; }
    update.mutate({ groupId: group.id, data: { name: trimmed, handles: parsed.handles } });
  };
  const busy = update.isPending || remove.isPending;

  if (editing) {
    return <li className="sfa-set-row sfa-set-row--edit" data-testid={`row-group-${group.id}`}>
      <form className="sfa-form" onSubmit={save} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } }} aria-label={`Edit group ${group.name}`} aria-describedby={error ? errorId : undefined} noValidate>
        <div className="sfa-set-editgrid">
          <GroupFormFields name={name} handles={handles} onName={(value) => { setName(value); if (error) setError(null); }} onHandles={(value) => { setHandles(value); if (error) setError(null); }}
            idPrefix={`sfa-set-group-${group.id}`} testPrefix={`input-group-edit-${group.id}`} disabled={update.isPending} nameError={Boolean(error && errorStatus(update.error) === 409)} />
        </div>
        {error && <p className="sfa-set-error" id={errorId} role="alert">{error}</p>}
        <div className="sfa-set-actions">
          <Button type="submit" variant="primary" size="sm" loading={update.isPending} data-testid={`button-group-edit-save-${group.id}`}>Save changes</Button>
          <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={update.isPending} data-testid={`button-group-edit-cancel-${group.id}`}>Cancel</Button>
        </div>
      </form>
    </li>;
  }

  return <li className="sfa-set-row sfa-set-row--group" data-testid={`row-group-${group.id}`}>
    <div className="sfa-set-row__main">
      <div className="sfa-set-row__title"><strong>{group.name}</strong><span className="sfa-set-row__meta sfa-num">{plural(group.handles.length, 'handle')}</span></div>
      <div className="sfa-set-chips" aria-label={`Handles in ${group.name}`}>{group.handles.map((handle) => <span className="sfa-set-chip" key={handle}>{handle}</span>)}</div>
    </div>
    <span className="sfa-set-row__actions">
      <IconButton label={`Edit group ${group.name}`} disabled={busy} onClick={startEditing} data-testid={`button-group-edit-${group.id}`}><Pencil size={15} /></IconButton>
      <IconButton label={`Delete group ${group.name}`} className="sfa-iconbtn--danger" disabled={busy}
        onClick={async () => { if (await confirm({ title: `Delete “${group.name}”?`, description: 'Posts that already mention these handles are not changed.', confirmLabel: 'Delete group', destructive: true })) remove.mutate({ groupId: group.id }); }}
        data-testid={`button-group-delete-${group.id}`}><Trash2 size={15} /></IconButton>
    </span>
  </li>;
}

function MentionsTab() {
  const { data, isLoading, isError, refetch } = useListMentionGroups({ query: { queryKey: getListMentionGroupsQueryKey() } });
  const groups = useMemo(() => [...(data?.groups ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [data]);
  return <div data-testid="panel-mentions">
    <NewGroupForm />
    <div style={{ paddingTop: 'var(--space-4)' }}>
      <Note>Insert a group from the @ button in the composer.</Note>
    </div>
    {isError ? <ErrorState title="Couldn't load your mention groups" onRetry={() => refetch()} />
      : isLoading ? <ListSkeleton label="Loading mention groups" />
      : groups.length === 0
        ? <EmptyState icon={<AtSign size={22} />} title="No mention groups" description="Save sets of handles you often tag together, then add them to a post in one click." />
        : <ul className="sfa-set-list" aria-label="Mention groups">{groups.map((group) => <GroupRow key={group.id} group={group} />)}</ul>}
  </div>;
}

/* ---------- Page ---------- */

export function SettingsPage() {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const tab = readTab(search || (typeof window !== 'undefined' ? window.location.search : ''));
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const select = (next: SettingsTab) => { if (next !== tab) navigate(`${location}?tab=${next}`, { replace: true }); };
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'Home' ? -index : event.key === 'End' ? TABS.length - 1 - index : 0;
    if (delta === 0) return;
    event.preventDefault();
    const nextIndex = (index + delta + TABS.length) % TABS.length;
    select(TABS[nextIndex]!.id);
    tabRefs.current[nextIndex]?.focus();
  };

  return <div className="sfa-page sfa-set-layout" data-testid="page-settings">
    <PageHeader title="Settings" description="Your profile, publishing defaults, and the tags, fields and mention groups that show up in the composer." />
    <div className="sfa-card">
      <div className="sfa-set-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map(({ id, label, Icon }, index) => <button key={id} type="button" role="tab" id={`sfa-set-tab-${id}`} aria-selected={tab === id} aria-controls={`sfa-set-panel-${id}`} tabIndex={tab === id ? 0 : -1}
          ref={(el) => { tabRefs.current[index] = el; }} className={tab === id ? 'is-on' : ''} onClick={() => select(id)} onKeyDown={(event) => onTabKey(event, index)} data-testid={`tab-settings-${id}`}>
          <Icon size={15} /> {label}
        </button>)}
      </div>
      <div role="tabpanel" id={`sfa-set-panel-${tab}`} aria-labelledby={`sfa-set-tab-${tab}`}>
        {tab === 'profile' ? <ProfileTab /> : tab === 'publishing' ? <PublishingTab /> : tab === 'tags' ? <TagsTab /> : tab === 'fields' ? <FieldsTab /> : tab === 'mentions' ? <MentionsTab /> : tab === 'security' ? <SecurityTab /> : <HelpTab />}
      </div>
    </div>
  </div>;
}

export default SettingsPage;
