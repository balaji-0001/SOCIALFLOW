import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  getGetAiStatusQueryKey,
  useGenerateAiContent,
  useGetAiStatus,
  type AiGenerateResult,
  type AiPlatform,
  type AiTask,
} from '@workspace/api-client-react';
import { Button } from './ui';
import './ai.css';

export const TASK_LABELS: Record<AiTask, string> = {
  caption: 'Write a caption',
  rewrite: 'Rewrite',
  shorten: 'Shorten',
  expand: 'Expand',
  hashtags: 'Suggest hashtags',
  variations: 'Variations',
  repurpose: 'Repurpose for platforms',
  first_comment: 'First comment',
};

export const PLATFORM_LABELS: Record<string, string> = {
  facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', youtube: 'YouTube', x: 'X',
};

/** Turns a failed generate call into an honest, specific message. */
export function aiErrorMessage(err: unknown): string {
  const e = err as { status?: number; data?: { message?: unknown; error?: unknown } } | null;
  const status = e?.status;
  const server = typeof e?.data?.message === 'string' ? e.data.message : undefined;
  if (status === 429) return `Daily AI limit reached for this workspace. It resets at the start of the next UTC day.${server ? ` (${server})` : ''}`;
  if (status === 503) return `The AI service is busy or not configured right now. ${server ?? 'Try again in a minute.'}`;
  if (status === 502) return `The AI provider returned an error. ${server ?? 'Nothing was charged to your daily limit. Try again.'}`;
  if (status === 504) return `The AI provider timed out. ${server ?? 'Try again.'}`;
  if (status === 403) return "Your role can't use AI Studio. Ask an owner or admin for editor access.";
  return server ?? "Couldn't generate content. Check your connection and try again.";
}

export function CharCount({ length, limit, withinLimit }: { length: number; limit: number | null; withinLimit: boolean }) {
  return <span className={`sfa-ai-count${withinLimit ? '' : ' is-over'}`} data-testid="text-ai-count">
    {length.toLocaleString()}{limit != null ? ` / ${limit.toLocaleString()}` : ''} characters
    {!withinLimit && limit != null && ` - ${(length - limit).toLocaleString()} over the limit`}
  </span>;
}

export interface AiAssistPopoverProps {
  currentText: string;
  platforms?: AiPlatform[];
  onInsert: (text: string) => void;
}

const ASSIST_TASKS: AiTask[] = ['caption', 'rewrite', 'shorten', 'expand', 'hashtags', 'variations', 'first_comment'];

/** Compact AI panel for the composer. Renders nothing usable unless the server has AI configured. */
export function AiAssistPopover({ currentText, platforms, onInsert }: AiAssistPopoverProps) {
  const [open, setOpen] = useState(false);
  const status = useGetAiStatus({ query: { queryKey: getGetAiStatusQueryKey(), retry: false, staleTime: 60_000 } });
  const [task, setTask] = useState<AiTask>('rewrite');
  const [instruction, setInstruction] = useState('');
  const [result, setResult] = useState<AiGenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gen = useGenerateAiContent({
    mutation: {
      onSuccess: (r) => { setResult(r); setError(null); },
      onError: (e) => { setResult(null); setError(aiErrorMessage(e)); },
    },
  });

  const available = status.data?.available === true;
  const needsText = task !== 'caption';
  const hasText = currentText.trim().length > 0;
  const run = () => {
    setError(null);
    gen.mutate({
      data: {
        task,
        ...(hasText ? (task === 'caption' ? { topic: currentText } : { text: currentText }) : {}),
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
        ...(platforms && platforms.length ? { platforms } : {}),
      },
    });
  };

  return <div className="sfa-ai-assist">
    <Button variant="outline" size="sm" icon={<Sparkles size={14} />} onClick={() => setOpen((o) => !o)}
      aria-expanded={open} aria-controls="sfa-ai-assist-panel" data-testid="button-ai-assist-toggle">AI assist</Button>
    {open && <div className="sfa-ai-assist__panel" id="sfa-ai-assist-panel" role="group" aria-label="AI assist" data-testid="panel-ai-assist">
      {status.isLoading && <p className="sfa-ai-muted">Checking AI availability...</p>}
      {status.isError && <p className="sfa-ai-error" role="alert">Couldn't check whether AI is available.</p>}
      {status.data && !available && <p className="sfa-ai-muted" data-testid="text-ai-assist-unavailable">
        AI isn't available on this server. {status.data.reason ?? 'An ANTHROPIC_API_KEY must be set on the server.'}
      </p>}
      {available && <>
        <div className="sfa-field">
          <label htmlFor="sfa-ai-assist-task">Task</label>
          <select id="sfa-ai-assist-task" className="sfa-select" value={task} onChange={(e) => setTask(e.target.value as AiTask)} data-testid="select-ai-assist-task">
            {ASSIST_TASKS.filter((t) => !status.data!.tasks.length || status.data!.tasks.includes(t)).map((t) => <option key={t} value={t}>{TASK_LABELS[t]}</option>)}
          </select>
        </div>
        <div className="sfa-field">
          <label htmlFor="sfa-ai-assist-instr">Instruction (optional)</label>
          <input id="sfa-ai-assist-instr" className="sfa-input" value={instruction} maxLength={500} placeholder="e.g. friendlier, mention the sale"
            onChange={(e) => setInstruction(e.target.value)} data-testid="input-ai-assist-instruction" />
        </div>
        {needsText && !hasText && <p className="sfa-ai-muted">Write some text in the composer first, then this task can work on it.</p>}
        <Button variant="primary" size="sm" icon={<Sparkles size={14} />} loading={gen.isPending}
          disabled={(needsText && !hasText) || (task === 'caption' && !hasText && !instruction.trim())} onClick={run} data-testid="button-ai-assist-generate">Generate</Button>
        {error && <p className="sfa-ai-error" role="alert" data-testid="text-ai-assist-error">{error}</p>}
        {result && <ul className="sfa-ai-assist__results" aria-live="polite">
          {result.outputs.map((o, i) => <li key={i} className="sfa-ai-assist__item">
            <p className="sfa-ai-text">{o.text}</p>
            <CharCount length={o.length} limit={o.limit} withinLimit={o.withinLimit} />
            <Button size="sm" variant="secondary" onClick={() => onInsert(o.text)} data-testid={`button-ai-assist-use-${i}`}>Use this</Button>
          </li>)}
          <li className="sfa-ai-muted">{result.remainingToday} generations left today.</li>
        </ul>}
      </>}
    </div>}
  </div>;
}
