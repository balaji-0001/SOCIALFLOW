import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { CircleAlert, MailCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getAuthMeQueryKey,
  getGetInvitationQueryKey,
  useAcceptInvitation,
  useAuthLogin,
  useAuthLogout,
  useAuthMe,
  useAuthSignup,
  useGetInvitation,
  type InvitationInfo,
} from '@workspace/api-client-react';
import { Button, Skeleton } from './ui';
import './team.css';

function errorMessage(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const message = (data as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="sfa-auth sfa-team-accept" data-testid="page-accept-invite">
    <main className="sfa-auth__panel"><div className="sfa-auth__card">{children}</div></main>
  </div>;
}

function Alert({ children, testid }: { children: ReactNode; testid: string }) {
  return <div className="sfa-alert" role="alert" data-testid={testid}><CircleAlert size={15} /> <span>{children}</span></div>;
}

/** Signed-in user whose email matches: one click to join. */
function AcceptAction({ token, disabled }: { token: string; disabled?: boolean }) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);
  const accept = useAcceptInvitation({
    mutation: {
      onSuccess: () => { queryClient.invalidateQueries(); navigate('/dashboard'); },
      onError: (err) => setError(errorMessage(err) ?? "Couldn't accept the invitation."),
    },
  });
  return <>
    {error && <Alert testid="status-accept-error">{error}</Alert>}
    <Button variant="primary" size="lg" className="sfa-auth__submit" loading={accept.isPending} disabled={disabled}
      onClick={() => { setError(null); accept.mutate({ token }); }} data-testid="button-accept-invitation">Accept invitation</Button>
  </>;
}

/** Not signed in: sign in or create an account for the invited address, then accept. */
function AuthForm({ token, info }: { token: string; info: InvitationInfo }) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const isSignup = !info.hasAccount;

  const accept = useAcceptInvitation({
    mutation: {
      onSuccess: () => { queryClient.invalidateQueries(); navigate('/dashboard'); },
      onError: (err) => setError(errorMessage(err) ?? "You're signed in, but we couldn't accept the invitation."),
    },
  });
  const afterAuth = () => { queryClient.invalidateQueries({ queryKey: getAuthMeQueryKey() }); accept.mutate({ token }); };
  const signup = useAuthSignup({ mutation: { onSuccess: afterAuth, onError: (err) => setError(errorMessage(err) ?? 'Could not create your account.') } });
  const login = useAuthLogin({ mutation: { onSuccess: afterAuth, onError: (err) => setError(errorMessage(err) ?? 'Incorrect email or password.') } });
  const busy = signup.isPending || login.isPending || accept.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < 8) { setError('Use at least 8 characters for your password.'); return; }
    if (isSignup) {
      const displayName = name.trim();
      signup.mutate({ data: { email: info.email, password, ...(displayName ? { displayName } : {}) } });
    } else {
      login.mutate({ data: { email: info.email, password } });
    }
  };

  return <form className="sfa-form" onSubmit={submit} noValidate aria-label={isSignup ? 'Create your account' : 'Sign in'}>
    {isSignup && <div className="sfa-field">
      <label htmlFor="accept-name">Your name</label>
      <input id="accept-name" className="sfa-input" type="text" value={name} placeholder="Ada Lovelace" autoComplete="name" onChange={(e) => setName(e.target.value)} data-testid="input-accept-name" />
    </div>}
    <div className="sfa-field">
      <label htmlFor="accept-email">Email</label>
      <input id="accept-email" className="sfa-input" type="email" value={info.email} readOnly aria-readonly="true" autoComplete="email" data-testid="input-accept-email" />
    </div>
    <div className="sfa-field">
      <label htmlFor="accept-password">{isSignup ? 'Create a password' : 'Password'}</label>
      <input id="accept-password" className="sfa-input" type="password" value={password} minLength={8} required autoComplete={isSignup ? 'new-password' : 'current-password'}
        placeholder="At least 8 characters" aria-invalid={error ? true : undefined} onChange={(e) => setPassword(e.target.value)} data-testid="input-accept-password" />
    </div>
    {error && <Alert testid="status-accept-error">{error}</Alert>}
    <Button type="submit" variant="primary" size="lg" className="sfa-auth__submit" loading={busy} data-testid="button-accept-submit">
      {isSignup ? 'Create account & join' : 'Sign in & join'}
    </Button>
  </form>;
}

function SwitchAccount({ invitedEmail, currentEmail }: { invitedEmail: string; currentEmail: string }) {
  const [error, setError] = useState<string | null>(null);
  const logout = useAuthLogout({ mutation: { onSuccess: () => window.location.reload(), onError: () => setError("Couldn't sign you out. Try again.") } });
  return <>
    <p data-testid="text-accept-mismatch">This invitation is for <strong>{invitedEmail}</strong>. You're signed in as <strong>{currentEmail}</strong>.</p>
    {error && <Alert testid="status-signout-error">{error}</Alert>}
    <Button variant="primary" size="lg" className="sfa-auth__submit" loading={logout.isPending} onClick={() => { setError(null); logout.mutate(); }} data-testid="button-accept-signout">Sign out and continue</Button>
  </>;
}

export function AcceptInvitePage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const invitation = useGetInvitation(token, { query: { queryKey: getGetInvitationQueryKey(token), enabled: token.length > 0, retry: false } });
  const me = useAuthMe({ query: { queryKey: getAuthMeQueryKey(), retry: false } });

  useEffect(() => { document.title = 'Accept invitation · Socialflow'; }, []);

  const info = invitation.data;

  if (!token || invitation.isError) {
    return <Shell>
      <h1>Invitation unavailable</h1>
      <Alert testid="status-invite-error">{!token ? 'This invitation link is missing its token.' : errorMessage(invitation.error) ?? "This invitation link isn't valid."}</Alert>
      <a className="sfa-linkbtn" href="/signin" data-testid="link-go-signin">Go to sign in</a>
    </Shell>;
  }

  if (invitation.isLoading || !info || me.isLoading) {
    return <Shell>
      <div aria-busy="true" aria-label="Loading invitation" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }} data-testid="skeleton-invite">
        <Skeleton width={40} height={40} radius={999} /><Skeleton width="80%" height={22} /><Skeleton width="55%" /><Skeleton width="100%" height={40} />
      </div>
    </Shell>;
  }

  const currentEmail = me.data?.user.email;
  const signedIn = Boolean(currentEmail);
  const matches = signedIn && currentEmail!.toLowerCase() === info.email.toLowerCase();

  return <Shell>
    <span className="sfa-emptystate__icon" aria-hidden="true" style={{ alignSelf: 'flex-start' }}><MailCheck size={22} /></span>
    <h1 data-testid="text-invite-headline">{info.invitedBy ?? 'Someone'} invited you to {info.workspaceName} as {info.roleLabel}</h1>
    <p className="sfa-team-accept__email" data-testid="text-invite-email">{info.email}</p>
    {signedIn
      ? matches ? <AcceptAction token={token} /> : <SwitchAccount invitedEmail={info.email} currentEmail={currentEmail!} />
      : <AuthForm token={token} info={info} />}
  </Shell>;
}

export default AcceptInvitePage;
