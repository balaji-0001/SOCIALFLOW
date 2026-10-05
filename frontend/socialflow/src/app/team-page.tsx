import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useLocation } from 'wouter';
import { format, formatDistanceToNow } from 'date-fns';
import { Activity, Check, Copy, Info, LogOut, Mail, MailPlus, Minus, RefreshCw, ShieldCheck, Trash2, Users } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getAuthMeQueryKey,
  getGetTeamQueryKey,
  useCreateInvitation,
  useGetTeam,
  useRemoveMember,
  useResendInvitation,
  useRevokeInvitation,
  useUpdateMemberRole,
  type ActivityEntry,
  type InvitationCreated,
  type Member,
  type PendingInvitation,
  type Team,
  type WorkspaceRole,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { useConfirm } from './confirm';
import { Button, EmptyState, ErrorState, PageHeader, Skeleton } from './ui';
import './team.css';

type TeamTab = 'members' | 'invitations' | 'roles' | 'activity';

const PERMISSION_LABELS: Record<string, string> = {
  'posts:read': 'View posts',
  'posts:write': 'Create & edit posts',
  'posts:publish': 'Publish',
  'posts:delete': 'Delete posts',
  'media:write': 'Upload media',
  'accounts:read': 'See accounts',
  'accounts:manage': 'Connect / disconnect accounts',
  'queues:manage': 'Manage queues',
  'organize:manage': 'Tags & fields',
  'analytics:read': 'View analytics',
  'analytics:refresh': 'Refresh analytics',
  'team:read': 'See the team',
  'team:manage': 'Invite & manage people',
};

function errorMessage(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const message = (data as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

const initials = (name: string) => {
  const parts = name.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[1]![0]! : '')).toUpperCase();
};
const formatDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : format(d, 'd MMM yyyy'); };
const ago = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : formatDistanceToNow(d, { addSuffix: true }); };
const exact = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : format(d, 'PPpp'); };

function roleLabel(team: Team, role: string): string {
  return team.roles.find((r) => r.role === role)?.label ?? role;
}

function TableSkeleton({ label }: { label: string }) {
  return <div className="sfa-team-skel" aria-busy="true" aria-label={label}>
    {[0, 1, 2].map((i) => <div className="sfa-team-skelrow" key={i}>
      <Skeleton width={32} height={32} radius={999} /><Skeleton width={`${50 - i * 8}%`} /><Skeleton width={70} height={22} radius={999} />
    </div>)}
  </div>;
}

/* ---------- Invite ---------- */

function InviteResult({ result, onDismiss }: { result: InvitationCreated; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  const copy = async () => {
    if (!result.inviteUrl) return;
    try { await navigator.clipboard.writeText(result.inviteUrl); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { toast({ title: "Couldn't copy the link", description: 'Select the link and copy it manually.', variant: 'destructive' }); }
  };
  return <div className="sfa-team-result" role="status" data-testid="status-invite-result">
    <h3>Invitation ready for {result.email}</h3>
    <p>{result.emailSent ? `We emailed this link to ${result.email}.` : "Email isn't set up, so share this link yourself."}</p>
    {result.inviteUrl && <div className="sfa-team-linkrow">
      <input className="sfa-input" readOnly value={result.inviteUrl} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} data-testid="input-invite-link" />
      <Button variant="outline" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={copy} data-testid="button-invite-copy">{copied ? 'Copied' : 'Copy'}</Button>
    </div>}
    <div><Button variant="ghost" size="sm" onClick={onDismiss} data-testid="button-invite-dismiss">Dismiss</Button></div>
  </div>;
}

function InviteForm({ team, onResult }: { team: Team; onResult: (r: InvitationCreated) => void }) {
  const queryClient = useQueryClient();
  const errorId = useId();
  const grantable = team.me.grantableRoles;
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WorkspaceRole>(grantable.includes('editor') ? 'editor' : grantable[0] ?? 'viewer');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateInvitation({
    mutation: {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: [getGetTeamQueryKey()[0]] });
        setEmail(''); setError(null); onResult(result);
      },
      onError: (err) => setError(errorMessage(err) ?? "Couldn't send the invitation."),
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(trimmed)) { setError('Enter a valid email address.'); return; }
    setError(null);
    create.mutate({ data: { email: trimmed, role } });
  };
  return <form className="sfa-team-invite" onSubmit={submit} aria-label="Invite someone" noValidate>
    <h3>Invite someone</h3>
    <div className="sfa-team-formrow">
      <div className="sfa-field">
        <label htmlFor="sfa-team-invite-email">Email</label>
        <input id="sfa-team-invite-email" className="sfa-input" type="email" value={email} placeholder="teammate@company.com" autoComplete="off"
          aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
          onChange={(e) => { setEmail(e.target.value); if (error) setError(null); }} data-testid="input-invite-email" />
      </div>
      <div className="sfa-field">
        <label htmlFor="sfa-team-invite-role">Role</label>
        <select id="sfa-team-invite-role" className="sfa-select" value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)} data-testid="select-invite-role">
          {grantable.map((r) => <option key={r} value={r}>{roleLabel(team, r)}</option>)}
        </select>
      </div>
      <Button type="submit" variant="primary" icon={<MailPlus size={15} />} loading={create.isPending} data-testid="button-invite-send">Send invite</Button>
    </div>
    {error && <p className="sfa-team-error" id={errorId} role="alert" data-testid="text-invite-error">{error}</p>}
  </form>;
}

/* ---------- Members ---------- */

function MemberRow({ team, member }: { team: Team; member: Member }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [, navigate] = useLocation();
  const { me } = team;
  const isMe = member.userId === me.userId;
  const name = member.displayName || member.email;
  const manageable = me.canManage && !isMe && member.role !== 'owner' && (me.role === 'owner' || member.role !== 'admin');
  const options: WorkspaceRole[] = manageable && !me.grantableRoles.includes(member.role) ? [member.role, ...me.grantableRoles] : me.grantableRoles;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: [getGetTeamQueryKey()[0]] });
    if (isMe) queryClient.invalidateQueries({ queryKey: getAuthMeQueryKey() });
  };
  const update = useUpdateMemberRole({
    mutation: {
      onSuccess: (_data, vars) => { refresh(); toast({ title: 'Role updated', description: `${name} is now ${roleLabel(team, vars.data.role)}.` }); },
      onError: (err) => { refresh(); toast({ title: "Couldn't change the role", description: errorMessage(err), variant: 'destructive' }); },
    },
  });
  const remove = useRemoveMember({
    mutation: {
      onSuccess: () => {
        if (isMe) { queryClient.invalidateQueries(); toast({ title: 'You left the workspace' }); navigate('/dashboard'); }
        else { refresh(); toast({ title: 'Member removed', description: `${name} no longer has access.` }); }
      },
      onError: (err) => toast({ title: isMe ? "Couldn't leave the workspace" : "Couldn't remove the member", description: errorMessage(err), variant: 'destructive' }),
    },
  });
  const busy = update.isPending || remove.isPending;

  return <tr data-testid={`row-member-${member.userId}`}>
    <td>
      <div className="sfa-team-person">
        <span className="sfa-avatar" style={{ height: 32, width: 32, fontSize: 12 }} aria-hidden="true">{initials(name)}</span>
        <div>
          <strong>{name}{isMe && <span className="sfa-team-you" data-testid={`badge-you-${member.userId}`}>You</span>}</strong>
          {member.displayName && <span>{member.email}</span>}
        </div>
      </div>
    </td>
    <td>{manageable
      ? <select className="sfa-select sfa-team-rolesel" value={member.role} disabled={busy} aria-label={`Role for ${name}`}
          onChange={(e) => update.mutate({ userId: member.userId, data: { role: e.target.value as WorkspaceRole } })} data-testid={`select-role-${member.userId}`}>
          {options.map((r) => <option key={r} value={r}>{roleLabel(team, r)}</option>)}
        </select>
      : <span className="sfa-team-role" data-testid={`text-role-${member.userId}`}>{roleLabel(team, member.role)}</span>}</td>
    <td className="sfa-team-muted">{formatDate(member.joinedAt)}</td>
    <td><div className="sfa-team-actions">
      {isMe && member.role !== 'owner' && <Button variant="outline" size="sm" icon={<LogOut size={14} />} loading={remove.isPending} disabled={busy}
        onClick={async () => { if (await confirm({ title: 'Leave this workspace?', description: `You'll lose access to ${team.workspace.name} until someone invites you again.`, confirmLabel: 'Leave workspace', destructive: true })) remove.mutate({ userId: member.userId }); }}
        data-testid="button-leave-workspace">Leave workspace</Button>}
      {manageable && <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} loading={remove.isPending} disabled={busy}
        onClick={async () => { if (await confirm({ title: `Remove ${name}?`, description: 'They will immediately lose access to this workspace.', confirmLabel: 'Remove', destructive: true })) remove.mutate({ userId: member.userId }); }}
        aria-label={`Remove ${name}`} data-testid={`button-remove-${member.userId}`}>Remove</Button>}
    </div></td>
  </tr>;
}

function MembersTab({ team }: { team: Team }) {
  const [result, setResult] = useState<InvitationCreated | null>(null);
  return <div className="sfa-team-panel" data-testid="panel-members">
    {team.me.canManage
      ? <>
        <InviteForm team={team} onResult={setResult} />
        {result && <InviteResult result={result} onDismiss={() => setResult(null)} />}
      </>
      : <p className="sfa-team-note" role="note"><Info size={15} />Only owners and admins can invite people or change roles. Ask one of them if you need to add someone.</p>}
    {team.members.length === 0
      ? <EmptyState icon={<Users size={22} />} title="No members yet" description="People you invite will show up here once they join." />
      : <div className="sfa-team-scroll"><table className="sfa-team-table" aria-label="Workspace members">
        <thead><tr><th scope="col">Member</th><th scope="col">Role</th><th scope="col">Joined</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{team.members.map((m) => <MemberRow key={m.userId} team={team} member={m} />)}</tbody>
      </table></div>}
  </div>;
}

/* ---------- Invitations ---------- */

function InvitationRow({ team, invitation, onResult }: { team: Team; invitation: PendingInvitation; onResult: (r: InvitationCreated) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const refresh = () => queryClient.invalidateQueries({ queryKey: [getGetTeamQueryKey()[0]] });
  const resend = useResendInvitation({
    mutation: { onSuccess: (r) => { refresh(); onResult(r); }, onError: (err) => toast({ title: "Couldn't resend the invitation", description: errorMessage(err), variant: 'destructive' }) },
  });
  const revoke = useRevokeInvitation({
    mutation: { onSuccess: () => { refresh(); toast({ title: 'Invitation revoked', description: `${invitation.email} can no longer use that link.` }); }, onError: (err) => toast({ title: "Couldn't revoke the invitation", description: errorMessage(err), variant: 'destructive' }) },
  });
  const busy = resend.isPending || revoke.isPending;
  return <tr data-testid={`row-invitation-${invitation.id}`}>
    <td><strong>{invitation.email}</strong>{invitation.expired && <span className="sfa-team-expired" data-testid={`badge-expired-${invitation.id}`}>Expired</span>}</td>
    <td><span className="sfa-team-role">{roleLabel(team, invitation.role)}</span></td>
    <td className="sfa-team-muted">{invitation.invitedBy ?? 'Unknown'}</td>
    <td className="sfa-team-muted" title={exact(invitation.createdAt)}>{formatDate(invitation.createdAt)}</td>
    <td>{team.me.canManage && <div className="sfa-team-actions">
      <Button variant="outline" size="sm" icon={<RefreshCw size={13} />} loading={resend.isPending} disabled={busy} onClick={() => resend.mutate({ invitationId: invitation.id })}
        aria-label={`Resend invitation to ${invitation.email}`} data-testid={`button-resend-${invitation.id}`}>Resend</Button>
      <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} loading={revoke.isPending} disabled={busy}
        onClick={async () => { if (await confirm({ title: `Revoke invitation for ${invitation.email}?`, description: 'The link they were sent will stop working.', confirmLabel: 'Revoke', destructive: true })) revoke.mutate({ invitationId: invitation.id }); }}
        aria-label={`Revoke invitation for ${invitation.email}`} data-testid={`button-revoke-${invitation.id}`}>Revoke</Button>
    </div>}</td>
  </tr>;
}

function InvitationsTab({ team }: { team: Team }) {
  const [result, setResult] = useState<InvitationCreated | null>(null);
  return <div className="sfa-team-panel" data-testid="panel-invitations">
    {result && <InviteResult result={result} onDismiss={() => setResult(null)} />}
    {team.invitations.length === 0
      ? <EmptyState icon={<Mail size={22} />} title="No pending invitations" description="Invitations you send stay here until they're accepted, revoked or expire." />
      : <div className="sfa-team-scroll"><table className="sfa-team-table" aria-label="Pending invitations">
        <thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Invited by</th><th scope="col">Sent</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{team.invitations.map((i) => <InvitationRow key={i.id} team={team} invitation={i} onResult={setResult} />)}</tbody>
      </table></div>}
  </div>;
}

/* ---------- Roles ---------- */

function RolesTab({ team }: { team: Team }) {
  return <div className="sfa-team-panel" data-testid="panel-roles">
    <p className="sfa-team-note" role="note"><Info size={15} />What each role can do in this workspace. Owners and admins choose roles when inviting people.</p>
    <div className="sfa-team-scroll" tabIndex={0} role="region" aria-label="Roles and permissions matrix">
      <table className="sfa-team-table sfa-team-matrix">
        <thead><tr>
          <th scope="col">Role</th>
          {team.permissions.map((p) => <th scope="col" key={p}>{PERMISSION_LABELS[p] ?? p}</th>)}
        </tr></thead>
        <tbody>{team.roles.map((r) => <tr key={r.role} data-testid={`row-role-${r.role}`}>
          <td><strong>{r.label}</strong><span>{r.description}</span></td>
          {team.permissions.map((p) => r.permissions.includes(p)
            ? <td key={p} className="sfa-team-yes"><Check size={16} aria-hidden="true" /><span className="sr-only">Allowed</span></td>
            : <td key={p} className="sfa-team-no"><Minus size={16} aria-hidden="true" /><span className="sr-only">Not allowed</span></td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}

/* ---------- Activity ---------- */

function detailText(detail: ActivityEntry['detail'], key: string): string {
  const v = detail?.[key];
  return typeof v === 'string' ? v : '';
}

function sentence(a: ActivityEntry, team: Team): string {
  const target = a.target ?? 'someone';
  const rl = (v: string) => (v ? roleLabel(team, v) : 'another role');
  const role = detailText(a.detail, 'role');
  switch (a.action) {
    case 'member.invited': return `${a.actor} invited ${target}${role ? ` as ${rl(role)}` : ''}`;
    case 'member.invite_resent': return `${a.actor} resent the invitation to ${target}`;
    case 'member.invite_revoked': return `${a.actor} revoked the invitation for ${target}`;
    case 'member.joined': return `${a.actor} joined`;
    case 'member.role_changed': return `${a.actor} changed ${target} from ${rl(detailText(a.detail, 'from'))} to ${rl(detailText(a.detail, 'to'))}`;
    case 'member.removed': return `${a.actor} removed ${target}`;
    case 'member.left': return `${a.actor} left the workspace`;
    case 'account.disconnected': return a.target ? `${a.actor} disconnected a ${a.target} account` : `${a.actor} disconnected an account`;
    default: return a.action;
  }
}

function ActivityTab({ team }: { team: Team }) {
  return <div className="sfa-team-panel" data-testid="panel-activity">
    {team.activity.length === 0
      ? <EmptyState icon={<Activity size={22} />} title="No activity yet" description="Invitations, role changes and other team events will be listed here." />
      : <ul className="sfa-team-feed" aria-label="Team activity">{team.activity.map((a) => <li key={a.id} data-testid={`row-activity-${a.id}`}>
        <p>{sentence(a, team)}</p>
        <time dateTime={a.createdAt} title={exact(a.createdAt)}>{ago(a.createdAt)}</time>
      </li>)}</ul>}
  </div>;
}

/* ---------- Page ---------- */

export function TeamPage() {
  const { data: team, isLoading, isError, refetch } = useGetTeam({ query: { queryKey: getGetTeamQueryKey() } });
  const [tab, setTab] = useState<TeamTab>('members');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabs: { id: TeamTab; label: string; Icon: typeof Users; count?: number }[] = [
    { id: 'members', label: 'Members', Icon: Users },
    { id: 'invitations', label: 'Invitations', Icon: Mail, count: team?.invitations.length },
    { id: 'roles', label: 'Roles & permissions', Icon: ShieldCheck },
    { id: 'activity', label: 'Activity', Icon: Activity },
  ];
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'Home' ? -index : event.key === 'End' ? tabs.length - 1 - index : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + tabs.length) % tabs.length;
    setTab(tabs[next]!.id);
    tabRefs.current[next]?.focus();
  };

  return <div className="sfa-page" data-testid="page-team">
    <PageHeader title="Team" description="Invite people to your workspace, choose what they can do, and see who changed what." />
    <div className="sfa-card">
      <div className="sfa-team-tabs" role="tablist" aria-label="Team sections">
        {tabs.map(({ id, label, Icon, count }, index) => <button key={id} type="button" role="tab" id={`sfa-team-tab-${id}`} aria-selected={tab === id} aria-controls={`sfa-team-panel-${id}`}
          tabIndex={tab === id ? 0 : -1} ref={(el) => { tabRefs.current[index] = el; }} className={tab === id ? 'is-on' : ''}
          onClick={() => setTab(id)} onKeyDown={(e) => onTabKey(e, index)} data-testid={`tab-team-${id}`}>
          <Icon size={15} /> {label}
          {count !== undefined && count > 0 && <span className="sfa-team-count" data-testid="badge-invitation-count">{count}</span>}
        </button>)}
      </div>
      <div role="tabpanel" id={`sfa-team-panel-${tab}`} aria-labelledby={`sfa-team-tab-${tab}`}>
        {isError ? <div className="sfa-team-panel"><ErrorState title="Couldn't load your team" onRetry={() => refetch()} /></div>
          : isLoading || !team ? <div className="sfa-team-panel"><TableSkeleton label="Loading team" /></div>
          : tab === 'members' ? <MembersTab team={team} />
          : tab === 'invitations' ? <InvitationsTab team={team} />
          : tab === 'roles' ? <RolesTab team={team} />
          : <ActivityTab team={team} />}
      </div>
    </div>
  </div>;
}
