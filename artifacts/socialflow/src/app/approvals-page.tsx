import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { CheckCircle2, ClipboardCheck, Info, MessageSquareWarning, Send, X, XCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetApprovalQueryKey,
  getGetApprovalSettingsQueryKey,
  useAddApprovalComment,
  useApproveApproval,
  useAuthMe,
  useGetApproval,
  useGetApprovalSettings,
  useListApprovals,
  useRejectApproval,
  useRequestApprovalChanges,
  useUpdateApprovalSettings,
  type Approval,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { ApprovalBadge, approvalErrorMessage } from './approval-controls';
import { Button, EmptyState, ErrorState, IconButton, PageHeader, Skeleton } from './ui';
import './approvals.css';

type Tab = 'needs_me' | 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'all';
const TABS: { id: Tab; label: string }[] = [
  { id: 'needs_me', label: 'Needs my decision' },
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'changes_requested', label: 'Changes requested' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'all', label: 'All' },
];

const ago = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : formatDistanceToNow(d, { addSuffix: true }); };
const exact = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : format(d, 'PPpp'); };
const preview = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n).trimEnd()}...` : s);

/* ---------- Settings ---------- */

function SettingsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const settings = useGetApprovalSettings({ query: { queryKey: getGetApprovalSettingsQueryKey() } });
  const update = useUpdateApprovalSettings({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetApprovalSettingsQueryKey(), data);
        toast({ title: data.required ? 'Approval is now required' : 'Approval is no longer required' });
      },
      onError: (err) => toast({ title: "Couldn't change the setting", description: approvalErrorMessage(err), variant: 'destructive' }),
    },
  });
  const required = settings.data?.required === true;
  return <section className="sfa-card sfa-approvals-settings" aria-labelledby="sfa-approvals-set-h" data-testid="card-approval-settings">
    <div>
      <h2 id="sfa-approvals-set-h">Require approval before publishing</h2>
      <p>When on, posts wait until an approver approves them, and they are not published before then. Editing an approved post sends it back to pending. When off, posts publish as scheduled and approval is optional.</p>
      {settings.data?.updatedAt && <p className="sfa-approvals-muted">Last changed {ago(settings.data.updatedAt)}.</p>}
      {settings.isError && <p className="sfa-approvals-error" role="alert">Couldn't load this setting. {approvalErrorMessage(settings.error)}</p>}
    </div>
    {settings.isLoading ? <Skeleton width={44} height={24} radius={999} /> :
      <button type="button" role="switch" aria-checked={required} aria-label="Require approval before publishing" className={`sfa-approvals-switch${required ? ' is-on' : ''}`}
        disabled={settings.isError || update.isPending} onClick={() => update.mutate({ data: { required: !required } })} data-testid="switch-approval-required"><span /></button>}
  </section>;
}

/* ---------- Detail ---------- */

function Detail({ approval, canDecide, myId, onClose }: { approval: Approval; canDecide: boolean; myId?: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const drawerRef = useRef<HTMLElement>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const detail = useGetApproval(approval.id, { query: { queryKey: getGetApprovalQueryKey(approval.id) } });
  const isOwn = !!myId && approval.requestedBy === myId;
  const isPending = approval.status === 'pending';

  useEffect(() => { drawerRef.current?.querySelector<HTMLElement>("[data-testid=button-approval-close]")?.focus(); }, []);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/approvals'] });
    queryClient.invalidateQueries({ queryKey: getGetApprovalQueryKey(approval.id) });
  };
  const done = (title: string) => () => { refresh(); setNote(''); toast({ title }); };
  const fail = (title: string) => (err: unknown) => { refresh(); toast({ title, description: approvalErrorMessage(err), variant: 'destructive' }); };
  const approve = useApproveApproval({ mutation: { onSuccess: done('Post approved'), onError: fail("Couldn't approve") } });
  const reject = useRejectApproval({ mutation: { onSuccess: done('Post rejected'), onError: fail("Couldn't reject") } });
  const changes = useRequestApprovalChanges({ mutation: { onSuccess: done('Changes requested'), onError: fail("Couldn't request changes") } });
  const addComment = useAddApprovalComment({
    mutation: { onSuccess: () => { refresh(); setComment(''); }, onError: fail("Couldn't add the comment") },
  });
  const busy = approve.isPending || reject.isPending || changes.isPending;

  const decideWithNote = (kind: 'reject' | 'changes') => {
    const trimmed = note.trim();
    if (!trimmed) { setNoteError('Add a note explaining your decision.'); return; }
    setNoteError(null);
    (kind === 'reject' ? reject : changes).mutate({ approvalId: approval.id, data: { note: trimmed } });
  };
  const submitComment = (e: FormEvent) => { e.preventDefault(); const body = comment.trim(); if (body) addComment.mutate({ approvalId: approval.id, data: { body } }); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };

  const current = detail.data ?? approval;
  return <div className="sfa-approvals-overlay" onKeyDown={onKey}>
    <button type="button" className="sfa-approvals-scrim" aria-label="Close details" tabIndex={-1} onClick={onClose} />
    <aside ref={drawerRef} className="sfa-approvals-drawer" role="dialog" aria-modal="true" aria-labelledby="sfa-approvals-dlg-h" data-testid="drawer-approval">
      <header>
        <h2 id="sfa-approvals-dlg-h">Approval request</h2>
        <ApprovalBadge status={current.status} />
        <IconButton label="Close" onClick={onClose} data-testid="button-approval-close"><X size={16} /></IconButton>
      </header>
      <div className="sfa-approvals-body">
        <p className="sfa-approvals-muted">Requested by {current.requestedByName ?? 'someone who has left'} <time dateTime={current.requestedAt} title={exact(current.requestedAt)}>{ago(current.requestedAt)}</time>
          {current.post?.scheduledAt && <> · Scheduled for {exact(current.post.scheduledAt)}</>}</p>
        <h3>Post</h3>
        {current.post
          ? <div className="sfa-approvals-post" data-testid="text-approval-post">{current.post.content || <em>This post has no text.</em>}</div>
          : <p className="sfa-approvals-muted">The post for this request no longer exists.</p>}
        {current.decidedAt && <p className="sfa-approvals-muted">Decision by {current.decidedByName ?? 'an approver'} {ago(current.decidedAt)}.</p>}
        {current.note && <p className="sfa-approvals-quote">{current.note}</p>}

        <h3>Decision</h3>
        {!isPending ? <p className="sfa-approvals-muted">This request is {current.status.replace('_', ' ')}, so no decision is needed.</p>
          : isOwn ? <p className="sfa-approvals-note-box" role="note"><Info size={15} />You requested this approval, so someone else has to decide it.</p>
          : !canDecide ? <p className="sfa-approvals-note-box" role="note"><Info size={15} />Your role can't approve or reject posts. An approver, admin or owner can.</p>
          : <div className="sfa-approvals-decide">
            <label htmlFor="sfa-approvals-decision-note" className="sfa-approvals-label">Note (required to reject or request changes)</label>
            <textarea id="sfa-approvals-decision-note" className="sfa-textarea sfa-approvals-note" value={note} maxLength={2000} aria-invalid={noteError ? true : undefined}
              onChange={(e) => { setNote(e.target.value); if (noteError) setNoteError(null); }} data-testid="input-decision-note" />
            {noteError && <p className="sfa-approvals-error" role="alert" data-testid="text-decision-error">{noteError}</p>}
            <div className="sfa-approvals-row">
              <Button variant="primary" icon={<CheckCircle2 size={15} />} loading={approve.isPending} disabled={busy} onClick={() => approve.mutate({ approvalId: approval.id, data: { note: note.trim() || null } })} data-testid="button-approve">Approve</Button>
              <Button variant="outline" icon={<MessageSquareWarning size={15} />} loading={changes.isPending} disabled={busy} onClick={() => decideWithNote('changes')} data-testid="button-request-changes">Request changes</Button>
              <Button variant="outline" icon={<XCircle size={15} />} loading={reject.isPending} disabled={busy} onClick={() => decideWithNote('reject')} data-testid="button-reject">Reject</Button>
            </div>
          </div>}

        <h3>Comments</h3>
        {detail.isLoading ? <Skeleton width="70%" />
          : detail.isError ? <ErrorState title="Couldn't load comments" onRetry={() => detail.refetch()} />
          : detail.data && detail.data.comments.length === 0 ? <p className="sfa-approvals-muted">No comments yet. Use this thread to discuss the post with the requester.</p>
          : <ul className="sfa-approvals-comments" aria-label="Comments">{detail.data?.comments.map((c) => <li key={c.id} data-testid={`row-comment-${c.id}`}>
            <strong>{c.author}</strong> <time dateTime={c.createdAt} title={exact(c.createdAt)}>{ago(c.createdAt)}</time>
            <p>{c.body}</p></li>)}</ul>}
        <form onSubmit={submitComment} className="sfa-approvals-commentform">
          <label htmlFor="sfa-approvals-comment" className="sfa-approvals-label">Add a comment</label>
          <textarea id="sfa-approvals-comment" className="sfa-textarea sfa-approvals-note" value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} data-testid="input-comment" />
          <div><Button type="submit" icon={<Send size={14} />} loading={addComment.isPending} disabled={!comment.trim()} data-testid="button-add-comment">Comment</Button></div>
        </form>
      </div>
    </aside>
  </div>;
}

/* ---------- Page ---------- */

export function ApprovalsPage() {
  const me = useAuthMe();
  const list = useListApprovals();
  const [tab, setTab] = useState<Tab>('all');
  const [tabTouched, setTabTouched] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const perms = me.data?.permissions ?? [];
  const canDecide = perms.includes('approvals:decide');
  const canManage = perms.includes('approvals:manage');
  const myId = me.data?.user.id;
  const all = list.data?.approvals ?? [];
  const isQueue = list.data?.scope === 'queue';

  const needsMe = all.filter((a) => a.status === 'pending' && a.requestedBy !== myId);
  useEffect(() => { if (!tabTouched && canDecide && list.data) setTab(needsMe.length > 0 ? 'needs_me' : 'pending'); }, [tabTouched, canDecide, list.data, needsMe.length]);

  const rows = tab === 'all' ? all : tab === 'needs_me' ? (canDecide ? needsMe : []) : all.filter((a) => a.status === tab);
  const countOf = (t: Tab) => t === 'all' ? all.length : t === 'needs_me' ? (canDecide ? needsMe.length : 0) : all.filter((a) => a.status === t).length;
  const open = all.find((a) => a.id === openId) ?? null;
  const visibleTabs = TABS.filter((t) => t.id !== 'needs_me' || canDecide);

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'Home' ? -index : event.key === 'End' ? visibleTabs.length - 1 - index : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + visibleTabs.length) % visibleTabs.length;
    setTabTouched(true); setTab(visibleTabs[next]!.id); tabRefs.current[next]?.focus();
  };

  const emptyText: Record<Tab, string> = {
    needs_me: 'Nothing is waiting for your decision.',
    pending: 'No requests are pending.',
    approved: 'No approved requests yet.',
    changes_requested: 'No requests have changes requested.',
    rejected: 'No rejected requests.',
    all: isQueue ? 'Nobody has asked for approval yet.' : "You haven't asked for approval on any post yet.",
  };

  return <div className="sfa-page" data-testid="page-approvals">
    <PageHeader title="Approvals" description={isQueue
      ? 'Review posts your team has sent for approval. You see every request in this workspace.'
      : 'Track the posts you sent for approval. You see your own requests.'} />
    {canManage && <SettingsCard />}
    <div className="sfa-card">
      <div className="sfa-approvals-tabs" role="tablist" aria-label="Approval status">
        {visibleTabs.map((t, i) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} className={tab === t.id ? 'is-on' : ''}
          ref={(el) => { tabRefs.current[i] = el; }} onClick={() => { setTabTouched(true); setTab(t.id); }} onKeyDown={(e) => onTabKey(e, i)} data-testid={`tab-approvals-${t.id}`}>
          {t.label}{list.data && countOf(t.id) > 0 && <span className="sfa-approvals-count">{countOf(t.id)}</span>}
        </button>)}
      </div>
      <div className="sfa-approvals-list" role="tabpanel">
        {list.isError ? <ErrorState title="Couldn't load approvals" description={approvalErrorMessage(list.error) ?? 'You may not have permission to see approvals, or the service is unavailable.'} onRetry={() => list.refetch()} />
          : list.isLoading ? <div aria-busy="true" aria-label="Loading approvals">{[0, 1, 2].map((i) => <div className="sfa-approvals-skelrow" key={i}><Skeleton width={`${70 - i * 10}%`} /><Skeleton width={120} /></div>)}</div>
          : rows.length === 0 ? <EmptyState icon={<ClipboardCheck size={22} />} title={emptyText[tab]}
              description={tab === 'all' && !isQueue ? 'Open a draft or scheduled post and choose Send for approval. Requests will show up here.' : 'Requests appear here when someone sends a post for approval. Turning on "Require approval before publishing" makes it part of your workflow.'} />
          : <ul className="sfa-approvals-rows" aria-label="Approval requests">{rows.map((a) => <li key={a.id}>
            <button type="button" className="sfa-approvals-item" onClick={() => setOpenId(a.id)} data-testid={`row-approval-${a.id}`}>
              <span className="sfa-approvals-item__text">{a.post ? (a.post.content ? preview(a.post.content) : 'Post without text') : 'Post no longer exists'}</span>
              <span className="sfa-approvals-item__meta">
                <span>{a.requestedByName ?? 'Unknown requester'}</span>
                <time dateTime={a.requestedAt} title={exact(a.requestedAt)}>{ago(a.requestedAt)}</time>
                <ApprovalBadge status={a.status} />
              </span>
            </button></li>)}</ul>}
      </div>
    </div>
    {open && <Detail key={open.id} approval={open} canDecide={canDecide} myId={myId} onClose={() => setOpenId(null)} />}
  </div>;
}
