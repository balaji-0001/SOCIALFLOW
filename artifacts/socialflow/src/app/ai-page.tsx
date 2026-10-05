import { useState, type FormEvent } from 'react';
import { BookmarkPlus, Check, Copy, Mic, Pencil, Plus, Sparkles, Trash2, WandSparkles } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetAiStatusQueryKey,
  getGetAiUsageQueryKey,
  getListBrandVoicesQueryKey,
  useAuthMe,
  useCreateBrandVoice,
  useCreateLibraryItem,
  useDeleteBrandVoice,
  useGenerateAiContent,
  useGetAiStatus,
  useGetAiUsage,
  useListBrandVoices,
  useUpdateBrandVoice,
  type AiGenerateResult,
  type AiOutput,
  type AiPlatform,
  type AiTask,
  type BrandVoice,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { useConfirm } from './confirm';
import { Button, EmptyState, ErrorState, PageHeader, Skeleton } from './ui';
import { CharCount, PLATFORM_LABELS, TASK_LABELS, aiErrorMessage } from './ai-assist';
import './ai.css';

const PLATFORMS: AiPlatform[] = ['facebook', 'instagram', 'linkedin', 'youtube', 'x'];
const TONES = ['Friendly', 'Professional', 'Playful', 'Bold', 'Inspirational', 'Informative', 'Empathetic'];
const TASK_HELP: Record<AiTask, string> = {
  caption: 'Write a new post from a topic.',
  rewrite: 'Rewrite your text, keeping the meaning.',
  shorten: 'Make your text shorter.',
  expand: 'Add detail to your text.',
  hashtags: 'Suggest hashtags for your text.',
  variations: 'Get several alternative versions.',
  repurpose: 'Adapt your text for each selected platform.',
  first_comment: 'Write a first comment to post under your text.',
};

function apiMessage(err: unknown): string | undefined {
  const m = (err as { data?: { message?: unknown } } | null)?.data?.message;
  return typeof m === 'string' ? m : undefined;
}

/* ---------- Usage ---------- */

function UsageMeter() {
  const usage = useGetAiUsage({ query: { queryKey: getGetAiUsageQueryKey(), retry: false } });
  if (usage.isLoading) return <div className="sfa-ai-usage" aria-busy="true"><Skeleton width={160} /><Skeleton height={8} radius={999} /></div>;
  if (usage.isError || !usage.data) return <div className="sfa-ai-usage"><p className="sfa-ai-muted" data-testid="text-ai-usage-error">Usage is unavailable right now.</p></div>;
  const u = usage.data;
  const pct = u.limit > 0 ? Math.min(100, Math.round((u.requests / u.limit) * 100)) : 0;
  let resets = '';
  try { resets = new Date(u.resetsAt).toLocaleString(); } catch { resets = u.resetsAt; }
  return <div className="sfa-ai-usage" data-testid="meter-ai-usage">
    <div className="sfa-ai-usage__row">
      <strong>{u.requests} of {u.limit} generations used today</strong>
      <span className="sfa-ai-muted">{u.remaining} left, resets {resets}</span>
    </div>
    <div className="sfa-ai-bar" role="progressbar" aria-valuemin={0} aria-valuemax={u.limit} aria-valuenow={u.requests} aria-label="Daily AI usage">
      <span className={pct >= 90 ? 'is-high' : ''} style={{ width: `${pct}%` }} />
    </div>
    <span className="sfa-ai-muted">{u.inputTokens.toLocaleString()} input and {u.outputTokens.toLocaleString()} output tokens today (workspace-wide).</span>
  </div>;
}

/* ---------- Result card ---------- */

function ResultCard({ output, task, canSave }: { output: AiOutput; task: AiTask; canSave: boolean }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useCreateLibraryItem({
    mutation: {
      onSuccess: () => { setSaved(true); toast({ title: 'Saved to library' }); },
      onError: (e) => toast({ title: "Couldn't save to library", description: apiMessage(e), variant: 'destructive' }),
    },
  });
  const copy = async () => {
    try { await navigator.clipboard.writeText(output.text); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { toast({ title: "Couldn't copy", description: 'Select the text and copy it manually.', variant: 'destructive' }); }
  };
  const title = `${TASK_LABELS[task]}${output.platform ? ` (${PLATFORM_LABELS[output.platform] ?? output.platform})` : ''}: ${output.text.replace(/\s+/g, ' ').slice(0, 60)}`.slice(0, 200);
  return <li className={`sfa-ai-card${output.withinLimit ? '' : ' is-over'}`} data-testid="card-ai-result">
    <div className="sfa-ai-card__head">
      {output.platform && <span className="sfa-ai-chip">{PLATFORM_LABELS[output.platform] ?? output.platform}</span>}
      <CharCount length={output.length} limit={output.limit} withinLimit={output.withinLimit} />
    </div>
    <p className="sfa-ai-text">{output.text}</p>
    {!output.withinLimit && <p className="sfa-ai-error">This text is over the platform's character limit and will be rejected or cut off if published as is. Shorten it before use.</p>}
    <div className="sfa-ai-card__actions">
      <Button size="sm" variant="outline" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={copy} data-testid="button-ai-copy">{copied ? 'Copied' : 'Copy'}</Button>
      {canSave && <Button size="sm" variant="outline" icon={saved ? <Check size={14} /> : <BookmarkPlus size={14} />} loading={save.isPending} disabled={saved}
        onClick={() => save.mutate({ data: { kind: 'caption', title, body: output.text } })} data-testid="button-ai-save-library">{saved ? 'Saved' : 'Save to library'}</Button>}
    </div>
  </li>;
}

/* ---------- Generate ---------- */

function Generator({ tasks, maxVariations, canUse, canSave }: { tasks: AiTask[]; maxVariations: number; canUse: boolean; canSave: boolean }) {
  const queryClient = useQueryClient();
  const voices = useListBrandVoices({ query: { queryKey: getListBrandVoicesQueryKey(), retry: false } });
  const [task, setTask] = useState<AiTask>(tasks.includes('caption') ? 'caption' : tasks[0] ?? 'caption');
  const [topic, setTopic] = useState('');
  const [text, setText] = useState('');
  const [instruction, setInstruction] = useState('');
  const [tone, setTone] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [platforms, setPlatforms] = useState<AiPlatform[]>([]);
  const [n, setN] = useState(3);
  const [result, setResult] = useState<AiGenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gen = useGenerateAiContent({
    mutation: {
      onSuccess: (r) => { setResult(r); setError(null); queryClient.invalidateQueries({ queryKey: getGetAiUsageQueryKey() }); },
      onError: (e) => { setError(aiErrorMessage(e)); queryClient.invalidateQueries({ queryKey: getGetAiUsageQueryKey() }); },
    },
  });

  const usesTopic = task === 'caption' || task === 'variations';
  const usesText = task !== 'caption';
  const needsPlatforms = task === 'repurpose';
  const problem =
    task === 'caption' && !topic.trim() ? 'Enter a topic to write about.'
    : usesText && task !== 'variations' && !text.trim() ? 'Paste the text to work on.'
    : task === 'variations' && !text.trim() && !topic.trim() ? 'Enter a topic or the text to vary.'
    : needsPlatforms && platforms.length === 0 ? 'Choose at least one platform.'
    : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem) { setError(problem); return; }
    setError(null);
    gen.mutate({
      data: {
        task,
        ...(usesTopic && topic.trim() ? { topic: topic.trim() } : {}),
        ...(usesText && text.trim() ? { text: text.trim() } : {}),
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
        ...(tone ? { tone } : {}),
        ...(platforms.length ? { platforms } : {}),
        ...(task === 'variations' ? { n: Math.min(n, maxVariations) } : {}),
        ...(voiceId ? { brandVoiceId: voiceId } : {}),
      },
    });
  };
  const togglePlatform = (p: AiPlatform) => setPlatforms((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]);

  return <div className="sfa-ai-grid">
    <form className="sfa-ai-form" onSubmit={submit} noValidate aria-label="Generate content">
      <fieldset className="sfa-ai-tasks">
        <legend>What do you want to do?</legend>
        <div className="sfa-ai-taskgrid" role="radiogroup">
          {tasks.map((t) => <label key={t} className={`sfa-ai-task${task === t ? ' is-on' : ''}`}>
            <input type="radio" name="sfa-ai-task" value={t} checked={task === t} onChange={() => { setTask(t); setError(null); }} data-testid={`radio-ai-task-${t}`} />
            <strong>{TASK_LABELS[t as AiTask] ?? t}</strong>
            <span>{TASK_HELP[t as AiTask] ?? ''}</span>
          </label>)}
        </div>
      </fieldset>

      {usesTopic && <div className="sfa-field">
        <label htmlFor="sfa-ai-topic">{task === 'caption' ? 'Topic' : 'Topic (optional if you paste text)'}</label>
        <textarea id="sfa-ai-topic" className="sfa-input" rows={3} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What is the post about?" data-testid="input-ai-topic" />
      </div>}
      {usesText && <div className="sfa-field">
        <label htmlFor="sfa-ai-text">Your text</label>
        <textarea id="sfa-ai-text" className="sfa-input" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the text to work on" data-testid="input-ai-text" />
      </div>}
      <div className="sfa-field">
        <label htmlFor="sfa-ai-instruction">Extra instruction (optional)</label>
        <input id="sfa-ai-instruction" className="sfa-input" value={instruction} maxLength={500} onChange={(e) => setInstruction(e.target.value)} placeholder="e.g. mention the weekend sale" data-testid="input-ai-instruction" />
      </div>

      <fieldset className="sfa-ai-platforms">
        <legend>Platforms {needsPlatforms ? '(required)' : '(optional, applies limits)'}</legend>
        <div className="sfa-ai-pills">
          {PLATFORMS.map((p) => <label key={p} className={`sfa-ai-pill${platforms.includes(p) ? ' is-on' : ''}`}>
            <input type="checkbox" checked={platforms.includes(p)} onChange={() => togglePlatform(p)} data-testid={`checkbox-ai-platform-${p}`} />
            {PLATFORM_LABELS[p]}
          </label>)}
        </div>
      </fieldset>

      <div className="sfa-ai-row">
        <div className="sfa-field">
          <label htmlFor="sfa-ai-tone">Tone</label>
          <select id="sfa-ai-tone" className="sfa-select" value={tone} onChange={(e) => setTone(e.target.value)} data-testid="select-ai-tone">
            <option value="">Default</option>
            {TONES.map((t) => <option key={t} value={t.toLowerCase()}>{t}</option>)}
          </select>
        </div>
        <div className="sfa-field">
          <label htmlFor="sfa-ai-voice">Brand voice</label>
          <select id="sfa-ai-voice" className="sfa-select" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} data-testid="select-ai-voice">
            <option value="">None</option>
            {(voices.data?.voices ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          {voices.isError && <span className="sfa-ai-muted">Brand voices couldn't be loaded.</span>}
        </div>
        {task === 'variations' && <div className="sfa-field">
          <label htmlFor="sfa-ai-n">How many</label>
          <select id="sfa-ai-n" className="sfa-select" value={n} onChange={(e) => setN(Number(e.target.value))} data-testid="select-ai-count">
            {Array.from({ length: Math.max(1, maxVariations) }, (_, i) => i + 1).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>}
      </div>

      {error && <p className="sfa-ai-error" role="alert" data-testid="text-ai-error">{error}</p>}
      <div>
        <Button type="submit" variant="primary" icon={<WandSparkles size={15} />} loading={gen.isPending} disabled={!canUse} data-testid="button-ai-generate">Generate</Button>
        {!canUse && <p className="sfa-ai-muted">Your role can view AI Studio but can't generate content.</p>}
      </div>
    </form>

    <section className="sfa-ai-results" aria-label="Results" aria-live="polite">
      {gen.isPending && <div aria-busy="true" className="sfa-ai-skel"><Skeleton height={90} radius={12} /><Skeleton height={90} radius={12} /></div>}
      {!gen.isPending && !result && <EmptyState icon={<Sparkles size={22} />} title="Nothing generated yet" description="Choose a task, fill in the details and press Generate. Results appear here." />}
      {!gen.isPending && result && <>
        <p className="sfa-ai-muted" data-testid="text-ai-meta">Generated with {result.model}. {result.remainingToday} generations left today.</p>
        <ul className="sfa-ai-cards">{result.outputs.map((o, i) => <ResultCard key={`${result.usage.outputTokens}-${i}`} output={o} task={result.task} canSave={canSave} />)}</ul>
      </>}
    </section>
  </div>;
}

/* ---------- Brand voices ---------- */

const splitWords = (s: string) => s.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);

function VoiceForm({ voice, onDone }: { voice: BrandVoice | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(voice?.name ?? '');
  const [description, setDescription] = useState(voice?.description ?? '');
  const [toneNotes, setToneNotes] = useState(voice?.toneNotes ?? '');
  const [doWords, setDo] = useState((voice?.doWords ?? []).join(', '));
  const [dontWords, setDont] = useState((voice?.dontWords ?? []).join(', '));
  const [error, setError] = useState<string | null>(null);
  const opts = {
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListBrandVoicesQueryKey() }); toast({ title: voice ? 'Brand voice updated' : 'Brand voice created' }); onDone(); },
    onError: (e: unknown) => setError(apiMessage(e) ?? "Couldn't save the brand voice."),
  };
  const create = useCreateBrandVoice({ mutation: opts });
  const update = useUpdateBrandVoice({ mutation: opts });
  const busy = create.isPending || update.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Give the voice a name.'); return; }
    setError(null);
    const data = { name: name.trim(), description: description.trim(), toneNotes: toneNotes.trim(), doWords: splitWords(doWords), dontWords: splitWords(dontWords) };
    if (voice) update.mutate({ voiceId: voice.id, data }); else create.mutate({ data });
  };
  return <form className="sfa-ai-voiceform" onSubmit={submit} noValidate aria-label={voice ? 'Edit brand voice' : 'New brand voice'}>
    <h3>{voice ? 'Edit brand voice' : 'New brand voice'}</h3>
    <div className="sfa-field"><label htmlFor="sfa-ai-vname">Name</label>
      <input id="sfa-ai-vname" className="sfa-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-testid="input-voice-name" /></div>
    <div className="sfa-field"><label htmlFor="sfa-ai-vdesc">Description</label>
      <textarea id="sfa-ai-vdesc" className="sfa-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} data-testid="input-voice-description" /></div>
    <div className="sfa-field"><label htmlFor="sfa-ai-vtone">Tone notes</label>
      <textarea id="sfa-ai-vtone" className="sfa-input" rows={3} value={toneNotes} onChange={(e) => setToneNotes(e.target.value)} data-testid="input-voice-tone" /></div>
    <div className="sfa-ai-row">
      <div className="sfa-field"><label htmlFor="sfa-ai-vdo">Words to use (comma separated)</label>
        <input id="sfa-ai-vdo" className="sfa-input" value={doWords} onChange={(e) => setDo(e.target.value)} data-testid="input-voice-do" /></div>
      <div className="sfa-field"><label htmlFor="sfa-ai-vdont">Words to avoid (comma separated)</label>
        <input id="sfa-ai-vdont" className="sfa-input" value={dontWords} onChange={(e) => setDont(e.target.value)} data-testid="input-voice-dont" /></div>
    </div>
    {error && <p className="sfa-ai-error" role="alert" data-testid="text-voice-error">{error}</p>}
    <div className="sfa-ai-card__actions">
      <Button type="submit" variant="primary" loading={busy} data-testid="button-voice-save">Save</Button>
      <Button variant="ghost" onClick={onDone} data-testid="button-voice-cancel">Cancel</Button>
    </div>
  </form>;
}

function BrandVoices({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
  const voices = useListBrandVoices({ query: { queryKey: getListBrandVoicesQueryKey(), retry: false } });
  const [editing, setEditing] = useState<BrandVoice | 'new' | null>(null);
  const del = useDeleteBrandVoice({
    mutation: {
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListBrandVoicesQueryKey() }); toast({ title: 'Brand voice deleted' }); },
      onError: (e) => toast({ title: "Couldn't delete", description: apiMessage(e), variant: 'destructive' }),
    },
  });

  if (voices.isLoading) return <div aria-busy="true" className="sfa-ai-skel"><Skeleton height={70} radius={12} /><Skeleton height={70} radius={12} /></div>;
  if (voices.isError) return <ErrorState title="Couldn't load brand voices" onRetry={() => voices.refetch()} />;
  const list = voices.data?.voices ?? [];
  return <div className="sfa-ai-voices">
    {canManage && editing === null && <div><Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')} data-testid="button-voice-new">New brand voice</Button></div>}
    {!canManage && <p className="sfa-ai-muted">Only owners and admins can create or change brand voices. You can pick any of them when generating.</p>}
    {editing !== null && <VoiceForm voice={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
    {list.length === 0 && editing === null && <EmptyState icon={<Mic size={22} />} title="No brand voices yet"
      description={canManage ? 'A brand voice tells the AI how your brand sounds: tone, words to use and words to avoid. Create one to keep generated copy on brand.' : 'An owner or admin can create a brand voice so generated copy stays on brand.'} />}
    <ul className="sfa-ai-cards">
      {list.map((v) => <li className="sfa-ai-card" key={v.id} data-testid={`card-voice-${v.id}`}>
        <div className="sfa-ai-card__head"><strong>{v.name}</strong></div>
        {v.description && <p className="sfa-ai-text">{v.description}</p>}
        {v.toneNotes && <p className="sfa-ai-muted">Tone: {v.toneNotes}</p>}
        {v.doWords.length > 0 && <p className="sfa-ai-muted">Use: {v.doWords.join(', ')}</p>}
        {v.dontWords.length > 0 && <p className="sfa-ai-muted">Avoid: {v.dontWords.join(', ')}</p>}
        {canManage && <div className="sfa-ai-card__actions">
          <Button size="sm" variant="outline" icon={<Pencil size={14} />} onClick={() => setEditing(v)} data-testid={`button-voice-edit-${v.id}`}>Edit</Button>
          <Button size="sm" variant="outline" icon={<Trash2 size={14} />} loading={del.isPending && del.variables?.voiceId === v.id}
            onClick={async () => { if (await confirm({ title: `Delete "${v.name}"?`, description: 'It will no longer be available when generating content.', confirmLabel: 'Delete', destructive: true })) del.mutate({ voiceId: v.id }); }}
            data-testid={`button-voice-delete-${v.id}`}>Delete</Button>
        </div>}
      </li>)}
    </ul>
  </div>;
}

/* ---------- Page ---------- */

export function AiStudioPage() {
  const me = useAuthMe();
  const perms = me.data?.permissions ?? [];
  const role = me.data?.role as string | undefined;
  const canUse = perms.includes('ai:use');
  const canManage = perms.includes('ai:manage') || role === 'owner' || role === 'admin';
  const canSave = perms.includes('library:write') || perms.includes('posts:write');
  const status = useGetAiStatus({ query: { queryKey: getGetAiStatusQueryKey(), retry: false } });
  const [tab, setTab] = useState<'generate' | 'voices'>('generate');

  return <div className="sfa-page sfa-ai-page">
    <PageHeader eyebrow="AI" title="AI Studio" description="Draft, rewrite and adapt social copy with your brand voice." />
    {status.isLoading && <div className="sfa-ai-panel" aria-busy="true"><Skeleton height={20} width="40%" /><Skeleton height={160} radius={12} /></div>}
    {status.isError && <ErrorState title="Couldn't check AI Studio" description="We couldn't reach the server to see whether AI is set up." onRetry={() => status.refetch()} />}
    {status.data && !status.data.available && <div className="sfa-ai-panel" data-testid="state-ai-unavailable">
      <EmptyState icon={<Sparkles size={22} />} title="AI Studio isn't configured on this server"
        description={<>AI Studio needs an Anthropic API key. Whoever runs this server must set the <code>ANTHROPIC_API_KEY</code> environment variable and restart it. Until then, nothing can be generated.{status.data.reason ? ` Server says: ${status.data.reason}` : ''}</>} />
    </div>}
    {status.data?.available && <>
      <div className="sfa-ai-panel"><UsageMeter /></div>
      <div className="sfa-ai-tabs" role="tablist" aria-label="AI Studio sections">
        {(['generate', 'voices'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'is-on' : ''} onClick={() => setTab(t)} data-testid={`tab-ai-${t}`}>
          {t === 'generate' ? 'Generate' : 'Brand voices'}</button>)}
      </div>
      <div className="sfa-ai-panel" role="tabpanel">
        {tab === 'generate'
          ? <Generator tasks={status.data.tasks} maxVariations={status.data.maxVariations} canUse={canUse} canSave={canSave} />
          : <BrandVoices canManage={canManage} />}
      </div>
    </>}
  </div>;
}
