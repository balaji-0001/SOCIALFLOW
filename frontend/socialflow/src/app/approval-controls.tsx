import { useId, useState } from 'react';
import { CheckCircle2, Clock, MessageSquareWarning, ShieldCheck, Undo2, XCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetApprovalSettingsQueryKey,
  useAuthMe,
  useGetApprovalSettings,
  useListApprovals,
  useRequestApproval,
  useWithdrawApproval,
  type Approval,
  type ApprovalStatus,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { Button, Skeleton } from './ui';
import './approvals.css';

export const APPROVAL_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending approval',
  approved: 'Approved',
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export function approvalErrorMessage(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const message = (data as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

const ICONS: Record<string, typeof Clock> = {
  pending: Clock,
  approved: CheckCircle2,
  changes_requested: MessageSquareWarning,
  rejected: XCircle,
  withdrawn: Undo2,
};

export function ApprovalBadge({ status }: { status: ApprovalStatus | string }) {
  const Icon = ICONS[status] ?? Clock;
  return <span className={`sfa-approvals-badge is-${status}`} data-testid={`badge-approval-${status}`}>
    <Icon size={12} aria-hidden="true" />{APPROVAL_STATUS_LABEL[status] ?? status}
  </span>;
}

function invalidateApprovals(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['/api/approvals'] });
}

/** Approval state for one post plus Send for approval / Withdraw. Renders nothing when approvals are not required and there is no request. */
export function PostApprovalPanel({ postId, postStatus }: { postId: string; postStatus?: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const noteId = useId();
  const [note, setNote] = useState('');
  const me = useAuthMe();
  const settings = useGetApprovalSettings({ query: { queryKey: getGetApprovalSettingsQueryKey(), retry: false } });
  const list = useListApprovals(undefined, { query: { queryKey: ['/api/approvals'], retry: false } });
  const perms = me.data?.permissions ?? [];
  const canRequest = perms.includes('approvals:request');
  const canManage = perms.includes('approvals:manage');
  const approval: Approval | undefined = list.data?.approvals.find((a) => a.postId === postId);

  const request = useRequestApproval({
    mutation: {
      onSuccess: () => { invalidateApprovals(queryClient); setNote(''); toast({ title: 'Sent for approval', description: 'An approver can now review this post.' }); },
      onError: (err) => toast({ title: "Couldn't send for approval", description: approvalErrorMessage(err), variant: 'destructive' }),
    },
  });
  const withdraw = useWithdrawApproval({
    mutation: {
      onSuccess: () => { invalidateApprovals(queryClient); setNote(''); toast({ title: 'Request withdrawn' }); },
      onError: (err) => toast({ title: "Couldn't withdraw the request", description: approvalErrorMessage(err), variant: 'destructive' }),
    },
  });

  if (me.isLoading || list.isLoading || settings.isLoading) return <div className="sfa-approvals-panel" aria-busy="true"><Skeleton width="60%" /></div>;
  if (list.isError) return <div className="sfa-approvals-panel" data-testid="panel-post-approval"><p className="sfa-approvals-muted">Approval status is unavailable right now. {approvalErrorMessage(list.error) ?? 'You may not have permission to see approvals.'}</p></div>;

  const required = settings.data?.required === true;
  if (!approval && !required) return null;

  const status = approval?.status;
  const canSend = canRequest && (postStatus === undefined || postStatus === 'draft' || postStatus === 'scheduled')
    && (!approval || status === 'rejected' || status === 'changes_requested' || status === 'withdrawn');
  const canWithdraw = !!approval && (status === 'pending' || status === 'changes_requested') && (canManage || (canRequest && approval.requestedBy === me.data?.user.id));

  return <section className="sfa-approvals-panel" aria-label="Approval" data-testid="panel-post-approval">
    <div className="sfa-approvals-panelhead">
      <strong><ShieldCheck size={15} aria-hidden="true" /> Approval</strong>
      {approval ? <ApprovalBadge status={approval.status} /> : <span className="sfa-approvals-muted">Not requested</span>}
    </div>
    {!approval && <p className="sfa-approvals-muted">This workspace requires approval before publishing. Send this post for review; it will wait until an approver approves it.</p>}
    {approval?.status === 'approved' && <p className="sfa-approvals-muted">Approved{approval.decidedByName ? ` by ${approval.decidedByName}` : ''}. Editing this post sends it back to pending.</p>}
    {approval?.note && (status === 'rejected' || status === 'changes_requested') && <p className="sfa-approvals-quote">{approval.decidedByName ? `${approval.decidedByName}: ` : ''}{approval.note}</p>}
    {(canSend || canWithdraw) && <>
      <label htmlFor={noteId} className="sfa-approvals-label">Note for the reviewer (optional)</label>
      <textarea id={noteId} className="sfa-textarea sfa-approvals-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} data-testid="input-approval-note" />
      <div className="sfa-approvals-row">
        {canSend && <Button variant="primary" loading={request.isPending} onClick={() => request.mutate({ postId, data: { note: note.trim() || null } })} data-testid="button-send-approval">
          {approval ? 'Send for approval again' : 'Send for approval'}</Button>}
        {canWithdraw && approval && <Button variant="outline" loading={withdraw.isPending} onClick={() => withdraw.mutate({ approvalId: approval.id, data: { note: note.trim() || null } })} data-testid="button-withdraw-approval">Withdraw</Button>}
      </div>
    </>}
    {!canSend && !canWithdraw && !approval && !canRequest && <p className="sfa-approvals-muted">Your role can't request approval. Ask an editor or admin.</p>}
  </section>;
}
