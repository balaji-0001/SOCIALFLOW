# User accounts and social connections

Socialflow requires a real account (email + password) before any social
platform can be connected. A workspace is created automatically at sign-up
and owned by that user; every connection, OAuth state and pending selection
is scoped to it and checked against the signed-in user on every request (see
§0). Social accounts themselves connect through each platform's **official
OAuth flow and APIs**. Socialflow never asks for, sees or stores social media
passwords, and there are no mock or demo accounts: if a platform's
credentials, permissions or app approval are missing, the UI says so and the
connect button stays disabled.

| Platform | Status | Account types |
|---|---|---|
| Facebook | **Implemented** | Facebook Pages |
| Instagram | **Implemented** (Instagram Login) | Instagram Business / Creator accounts |
| LinkedIn | **Implemented** | Member profiles, organization Pages (opt-in) |
| YouTube | **Implemented** | YouTube channels |

---

## 0. User accounts

- **Routes.** `POST /api/auth/signup` (`{email, password, displayName?}`, creates the
  user, a workspace, and signs in), `POST /api/auth/login` (`{email, password}`),
  `POST /api/auth/logout`, `GET /api/auth/me`.
- **Passwords.** Hashed with scrypt (`lib/password.ts`, Node's built-in
  `node:crypto`, no third-party hashing dependency), never logged, never
  returned by the API. Minimum 8 characters.
- **Sessions.** A random 256-bit token in an HttpOnly, Secure (in production),
  SameSite=Lax, signed cookie (`sf_session`). Only its SHA-256 hash is stored.
  Sessions last 30 days; signing out deletes the row server-side, not just the
  cookie.
- **Timing safety.** `/auth/login` always runs a real password comparison,
  whether or not the email exists, so response time can't be used to enumerate
  registered emails.
- **Rate limiting.** `/auth/login` (20 / 15 min) and `/auth/signup` (10 / hour)
  per IP, in-memory (`middlewares/rate-limit.ts`). Single-process; a
  multi-instance deployment should swap this for a shared store.
- **Every social-connection route requires a session.** `GET /api/connections/
  :platform/start` redirects a signed-out browser to `/signin?next=<url>` and
  resumes the exact start URL (including `?reconnect=`) after sign-in. Every
  other connection route (`GET /connections`, `verify`, `disconnect`, the
  pending-selection routes) returns `401 unauthorized` if not signed in.

## 1. How it works

```
Browser                         API server (/api)                         Provider
───────                         ─────────────────                         ────────
Connect ──GET /connections/facebook/start──▶ (302 to /signin if not authenticated)
                                             create state (hashed, 10 min, single use,
                                             bound to this browser's session)
        ◀──────────── 302 to provider consent screen ───────────────────────▶ user approves
        ──GET /connections/facebook/callback?code&state──▶ consume state, verify session,
                                             exchange code → tokens (server-side only),
                                             check granted scopes, list Pages
        ◀── 302 /workspace?pending=<id>      store candidates encrypted (15 min)
Pick Pages ──POST /connections/pending/<id>/complete──▶ save selected accounts,
                                             tokens AES-256-GCM encrypted
```

- **Adapters.** Everything provider-specific lives in
  `artifacts/api-server/src/lib/oauth/providers/<platform>.ts` behind the
  `OAuthProviderAdapter` interface (`lib/oauth/types.ts`). The routes, state
  handling, encryption, storage, account picker and UI are shared.
- **State and CSRF.** A random 256-bit `state` is stored as a SHA-256 hash,
  tied to the browser's authenticated session and deleted the moment the
  callback uses it. A callback from another browser, a replay, or an expired
  state is rejected. Providers that support PKCE get an S256 challenge
  automatically (`usesPkce: true`) — currently YouTube.
- **Token storage.** Access and refresh tokens are encrypted with AES-256-GCM
  (`lib/crypto.ts`). The ciphertext is bound (as AAD) to its workspace, platform
  and account, so it can't be copied to another row. Tokens are never returned
  by the API or logged.
- **Ownership.** Every workspace belongs to the user who created it
  (`socialflow_workspace_members`); every connected account belongs to a
  workspace. A workspace can hold any number of accounts per platform (unique
  per workspace + platform + external account ID). One user can never read or
  modify another user's connections — every connection route resolves the
  workspace from the session, never from a client-supplied ID.
- **Health.** `POST /api/connections/:id/verify` asks the provider whether the
  token is still valid and has the required scopes. It marks accounts `active`,
  `expired`, `revoked`, `missing_permissions` or `error`. Unhealthy accounts
  show a **Reconnect** button, which re-runs OAuth for that account (for
  Facebook with `auth_type=rerequest`, so previously declined permissions are
  asked for again).
- **Refresh.** `ensureFreshToken` refreshes tokens that are about to expire for
  providers with refresh tokens (LinkedIn, when the app has MDP refresh-token
  approval; Google). Instagram refreshes its long-lived access token in place
  (no separate refresh token) via the same mechanism. Facebook Page tokens
  obtained from a long-lived user token don't expire, so Facebook needs no
  refresh.

### API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/signup` | Create an account + workspace, sign in |
| POST | `/api/auth/login` | Sign in |
| POST | `/api/auth/logout` | End the session |
| GET | `/api/auth/me` | The signed-in user and their workspace ID |
| GET | `/api/connections/providers` | Which platforms are implemented and configured, missing secret **names**, callback URLs (public, no auth needed) |
| GET | `/api/connections/:platform/start[?reconnect=<accountId>]` | Browser navigation that starts OAuth; redirects to `/signin` if not authenticated |
| GET | `/api/connections/:platform/callback` | OAuth redirect URI (register this with the provider) |
| GET | `/api/connections/pending/:id` | Accounts returned by the provider, awaiting selection |
| POST | `/api/connections/pending/:id/complete` | `{ "externalAccountIds": [...] }` connects the selected accounts |
| DELETE | `/api/connections/pending/:id` | Discard a selection |
| GET | `/api/connections` | Connected accounts for the current workspace (no tokens) |
| POST | `/api/connections/:id/verify` | Re-check the token and permissions with the provider |
| DELETE | `/api/connections/:id` | Disconnect (deletes stored tokens) |

---

## 2. Secrets (Replit → Tools → Secrets)

All credentials stay on the server. None are exposed to the frontend.

| Secret | Required | Notes |
|---|---|---|
| `SESSION_SECRET` | yes | Already set. Signs the session cookie. |
| `TOKEN_ENCRYPTION_KEY` | yes | 32 random bytes, base64. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Losing it makes stored tokens unreadable** (users would have to reconnect). |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | no | Old key, used for decryption only during key rotation. |
| `OAUTH_REDIRECT_BASE_URL` | prod | e.g. `https://app.yourdomain.com`. If unset, dev uses `https://$REPLIT_DEV_DOMAIN` and production uses the first `$REPLIT_DOMAINS` entry. Must be HTTPS (Instagram Login rejects `http://localhost`, unlike Facebook Login). |
| `AUTH_LOGIN_RATE_LIMIT` / `AUTH_SIGNUP_RATE_LIMIT` | no | Requests per window before `429`. Defaults 20/15 min and 10/hour. |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | Facebook | Meta app → App settings → Basic. |
| `FACEBOOK_GRAPH_API_VERSION` | no | Defaults to `v26.0`. |
| `FACEBOOK_LOGIN_CONFIG_ID` | no | Set if you use *Facebook Login for Business*. Permissions then come from the configuration instead of `scope`. |
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | Instagram | From the Instagram product's *API setup with Instagram login* page — **not** the Facebook app ID/secret, and never an Instagram account ID or access token. |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | LinkedIn | linkedin.com/developers → your app → Auth tab. |
| `LINKEDIN_ORG_ENABLED` | no | `true` to also discover organization Pages the member administers. Requires Community Management API access (separate LinkedIn review) — leave unset otherwise; member sign-in works either way. |
| `LINKEDIN_API_VERSION` | LinkedIn orgs only | `YYYYMM`, required only when `LINKEDIN_ORG_ENABLED=true`. Check the current value against LinkedIn's versioning docs before setting it. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | YouTube | console.cloud.google.com → Credentials → OAuth client ID (Web application). |

> ⚠️ **The existing `SOCIALFLOW_INSTAGRAM_CLIENT_ID` / `SOCIALFLOW_INSTAGRAM_CLIENT_SECRET`
> secrets hold the wrong kind of value.** By format, the "client ID" is an Instagram
> account ID and the "secret" is a Meta **access token**, not an app secret. The
> code no longer reads them. Delete them, and if that access token is still valid,
> treat it as exposed and revoke it (remove the app under Facebook → Settings →
> Business integrations, or reset it in the Meta dashboard).

### Redirect (callback) URLs

The exact URL to register is shown by `GET /api/connections/providers`
(`callbackUrl`) and follows this pattern:

| Environment | Redirect URL |
|---|---|
| Development (Replit workspace) | `https://<your-repl>.replit.dev/api/connections/<platform>/callback` |
| Production (deployment) | `https://<your-app>.replit.app/api/connections/<platform>/callback`, or your custom domain via `OAUTH_REDIRECT_BASE_URL` |

Register **both** dev and prod URLs with each provider. The URL must match
exactly: scheme, host, path, no trailing slash.

---

## 3. Facebook Pages (implemented)

### Developer app
1. Go to <https://developers.facebook.com/apps> → **Create app** → use case
   *"Manage everything on your Page"* (or type **Business**).
2. **App settings → Basic:** copy the **App ID** and **App Secret** into
   `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET`. Add your **App domains**
   (`<your-repl>.replit.dev`, your production domain), a **Privacy Policy URL**
   and **User data deletion** instructions URL (both required to go Live).
3. Add the **Facebook Login for Business** product (or **Facebook Login**).
   Under *Settings*, add every redirect URL from the table above to **Valid OAuth
   Redirect URIs**. Keep *Client OAuth login* and *Web OAuth login* on, and
   *Enforce HTTPS* on.
4. Optional (Login for Business): create a **Configuration** with the
   permissions below and put its ID in `FACEBOOK_LOGIN_CONFIG_ID`.

### Permissions requested
| Permission | Why | Required |
|---|---|---|
| `pages_show_list` | List the Pages the user manages | yes |
| `pages_read_engagement` | Read Page content and metadata | yes |
| `pages_manage_posts` | Publish posts to the Page | yes |
| `business_management` | See Pages owned through a Business Portfolio (otherwise they can be missing from the list) | optional |

If the user declines a required permission, the flow fails with a clear
"missing permissions" message and nothing is stored. Pages where the user's
role can't create content are shown but not selectable.

### Access levels and approval
- **Development mode (no review needed):** only people with a role on the app
  (Admin, Developer, Tester in *App roles*) can connect, and only Pages they
  manage. **This is enough to test with your own account.**
- **Live for everyone:** request **Advanced Access** for each permission through
  **App Review** (screencast of the flow + usage description), complete
  **Business Verification**, then switch the app to Live. Expect days to weeks.
- Meta requires a **data deletion callback or instructions URL** before going
  Live. Socialflow doesn't implement the deletion callback endpoint yet (see
  "Known gaps").

### Token lifetimes
The code is exchanged for a short-lived user token, which is upgraded to a
long-lived (~60 day) user token. Page tokens fetched with it **don't expire**.
They stop working if the user removes the app, loses their Page role, changes
their password, or an admin revokes access. **Check** / verify detects this
(`debug_token` + a Page read) and marks the account `revoked` / `expired` /
`missing_permissions`. All Graph calls made with user or Page tokens include
`appsecret_proof`. You can also turn on *Require App Secret* in the app's
Advanced settings.

---

## 4. Instagram (implemented — Instagram Login)

The adapter (`artifacts/api-server/src/lib/oauth/providers/instagram.ts`) uses
the **Instagram API with Instagram Login** path: the user signs in directly
with their Instagram account, with no linked Facebook Page required.

- **Account types.** Only Instagram **Business** or **Creator** (professional)
  accounts. Personal accounts are rejected with a clear error after the
  callback, telling the user to switch to a professional account.
- **Scopes.** `instagram_business_basic`, `instagram_business_content_publish`.
- **Flow.** Authorize at `instagram.com/oauth/authorize` → exchange the code
  for a short-lived token at `api.instagram.com/oauth/access_token` → upgrade
  to a 60-day long-lived token at `graph.instagram.com/access_token`
  (`grant_type=ig_exchange_token`) → fetch the profile from
  `graph.instagram.com/me`. Unlike Facebook, one login returns exactly one
  account (the account you log into *is* the professional account), so there
  is no multi-account picker step — the shared picker still runs, showing one
  candidate.
- **Refresh.** Instagram has no separate refresh token; the long-lived access
  token is refreshed in place via `graph.instagram.com/refresh_access_token`
  (`grant_type=ig_refresh_token`), which requires the current token to be at
  least 24 hours old. The adapter stores the access token as its own
  "refresh token" so the shared `ensureFreshToken` logic triggers this
  automatically before the 60-day expiry.
- **Verification limitation.** Meta does not document a permissions-listing
  endpoint for this product equivalent to Facebook's `/me/permissions`, so
  `verifyAccount` only re-checks token validity and refreshes profile data.
  It does not re-derive granted scopes; the code does not guess an endpoint
  that isn't documented.
- **Redirect URL.** Registered separately from Facebook's, under the
  Instagram product → *API setup with Instagram login* → *Business login
  settings* → *OAuth redirect URIs*. `…/api/connections/instagram/callback`.
- **Access levels.** Same as Facebook: Development mode works for app-role
  testers only; public use needs App Review (Advanced Access) and Business
  Verification.

The alternative Meta path, **Instagram API with Facebook Login** (requires a
linked Facebook Page, reuses `FACEBOOK_APP_ID/SECRET`), is not implemented.
It remains a documented option if a future need (e.g. publishing through a
Page-linked Instagram account) requires it.

## 5. LinkedIn (implemented)

The adapter (`artifacts/api-server/src/lib/oauth/providers/linkedin.ts`) uses
the standard 3-legged LinkedIn OAuth flow (no PKCE — LinkedIn is a
confidential-client flow) plus OpenID Connect for the member profile.

1. <https://www.linkedin.com/developers/apps> → **Create app**. It must be
   linked to a LinkedIn **Company Page**, and a Page admin must verify it.
2. **Auth** tab: copy the Client ID/Secret into `LINKEDIN_CLIENT_ID/SECRET` and add
   the redirect URLs under *Authorized redirect URLs*.
3. **Products:**
   - *Sign In with LinkedIn using OpenID Connect* → `openid`, `profile` (instant) —
     always requested.
   - *Share on LinkedIn* → `w_member_social` (post as the member; instant) —
     always requested.
   - *Community Management API* → `r_organization_social`, `w_organization_social`,
     `rw_organization_admin` (organization Pages). **Requires an access request
     and review, and LinkedIn requires it to be the only product on its app.**
     Plan for a separate LinkedIn app for organization Pages. Only requested
     when `LINKEDIN_ORG_ENABLED=true` — leave it unset if the app doesn't have
     this access, and member sign-in works normally.
4. **Member accounts** always work once the required product is added: the
   member profile connects via `GET /v2/userinfo`.
5. **Organization Pages** (opt-in): with `LINKEDIN_ORG_ENABLED=true` and
   `LINKEDIN_API_VERSION` set (`YYYYMM`, check the current value against
   LinkedIn's versioning docs), the adapter calls `organizationAcls` to find
   Pages the member administers. If the app lacks Community Management API
   access, this fails gracefully — the member connection still succeeds, just
   without organization candidates. Reconnecting an organization re-checks
   its admin role via the same call.
6. Tokens last 60 days. Refresh tokens are only issued to approved Community
   Management / Marketing Developer Platform partners. Without one, users
   reconnect when the token expires (the UI shows "Token expired → Reconnect").

## 6. YouTube (implemented)

The adapter (`artifacts/api-server/src/lib/oauth/providers/youtube.ts`) uses
Google's OAuth 2.0 web-server flow with PKCE (S256) plus the YouTube Data API v3.

1. <https://console.cloud.google.com> → create a project → enable **YouTube Data
   API v3**.
2. **OAuth consent screen** (Google Auth Platform): External, app name, support
   email, authorized domains, privacy policy. Add scopes
   `https://www.googleapis.com/auth/youtube.readonly` and
   `https://www.googleapis.com/auth/youtube.upload`. These are
   sensitive/restricted scopes, so **Google verification** is required before
   public use.
3. **Credentials → OAuth client ID → Web application:** add the redirect URLs as
   *Authorized redirect URIs*, then copy into `GOOGLE_CLIENT_ID/SECRET`.
4. While in **Testing**, add your Google account under *Test users*. Refresh
   tokens issued to apps in Testing expire after **7 days** — after that, the
   account shows "Token expired → Reconnect".
5. The adapter uses PKCE, `access_type=offline` and, on reconnect,
   `prompt=consent` to force a fresh refresh token even if one was already
   granted. It lists channels via `channels.list?mine=true`, which can return
   several channels (Brand Accounts) to pick from.
6. Videos uploaded from **unverified** API projects are locked to *private*
   until the project passes a YouTube API compliance audit. Uploads also cost a
   large share of the default 10,000 units/day quota. Video publishing is
   implemented (see docs/media.md): one video per post, uploaded private by
   default (`YOUTUBE_DEFAULT_PRIVACY` to change).

---

## 7. Testing with your own accounts

### Automated tests
```bash
pnpm --filter @workspace/api-server run test
```
- Unit tests: encryption (tamper, AAD, rotation), redirect URL config, the
  rate limiter, and each adapter against a faked provider API — Facebook
  (token exchange, long-lived upgrade, `appsecret_proof`, declined scopes, no
  Pages, revoked/expired tokens), Instagram (short/long-lived exchange,
  personal-account rejection, declined scopes, refresh, revoked/expired
  tokens), LinkedIn (member profile, organization discovery on/off, missing
  Community Management API access, refresh, revoked tokens), YouTube (PKCE
  code exchange, multiple Brand Account channels, no channels, missing
  scopes, refresh, revoked/expired tokens).
- Auth route tests (`src/routes/auth.test.ts`): sign-up, duplicate/case-
  insensitive email, weak password, wrong password, unknown email, sign-out
  invalidating the session, `/auth/me` unauthorized.
- Connection route tests (`src/routes/connections.test.ts`) run the full flow
  against Postgres with only Facebook's HTTP faked, on top of real sign-up:
  start → callback → pick → list → verify → reconnect → disconnect, plus
  state replay, cross-browser state, user cancel, missing scopes, workspace
  isolation between different users, missing credentials, and unauthenticated
  requests being rejected (401, or redirected to `/signin` for the browser
  start route). **They skip until the schema is pushed**
  (`pnpm --filter @workspace/db run push`). They create and delete their own
  users and workspaces.

No real provider is called by the tests. They prove the plumbing, not your Meta,
LinkedIn or Google app configuration. For that, do the manual tests below.

### Manual Facebook test (Development mode, no App Review needed)
1. Push the schema: `pnpm --filter @workspace/db run push`.
2. Add Secrets: `TOKEN_ENCRYPTION_KEY`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`.
3. Restart the **API Server** workflow.
4. Open `https://<your-repl>.replit.dev/api/connections/providers`. Facebook
   should show `"configured": true`, and `callbackUrl` is the exact URL to paste
   into *Valid OAuth Redirect URIs*.
5. Make sure your Facebook account has a role on the Meta app and manages at
   least one Page (create a test Page if needed).
6. Open `/signin`, create an account (or sign in), then open `/workspace` →
   **Facebook Pages → Connect account** → approve in the Facebook dialog and
   choose your Pages → pick them in Socialflow's picker → they appear as
   *Connected*.
7. **Check** re-validates the token with Meta.
8. Test failure handling:
   - Click Connect and hit **Cancel** in Facebook → "connection was cancelled".
   - Connect and untick `pages_manage_posts` in *Edit access* → "missing permissions".
   - In Facebook → Settings → **Business integrations**, remove the app → **Check** → *Access revoked* → **Reconnect**.
   - **Disconnect** → the row and its encrypted tokens are deleted.

Typical errors: *"URL blocked: This redirect failed because the redirect URI is
not whitelisted"* means the callback URL isn't in Valid OAuth Redirect URIs
(copy it from `/api/connections/providers`). *"Feature unavailable"* or
*"App not active"* means your account has no role on the app, or the app is in
Development mode for a non-role user.

### Manual Instagram test (Development mode, no App Review needed)
1. Add Secrets: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` (from the Instagram
   product, not the Facebook app ID/secret).
2. Restart the API server.
3. Open `/api/connections/providers`. Instagram should show `"configured": true`,
   and `callbackUrl` is the exact URL to paste into the Instagram product's
   *Business login settings → OAuth redirect URIs*. Instagram requires
   **HTTPS** — `http://localhost` is rejected even in Development mode, unlike
   Facebook Login. Use a tunnel (e.g. `cloudflared tunnel --url http://localhost:5000`)
   or a Replit dev/prod domain and set `OAUTH_REDIRECT_BASE_URL` to it.
4. Make sure your Instagram account is a **Business or Creator** account and
   has a role on the Meta app (App roles → Roles → Tester).
5. Open `/workspace` → **Instagram → Connect account** → sign in with Instagram
   → the account is picked up automatically (one login = one account, no
   multi-account picker step) → it appears as *Connected*.
6. **Check** re-validates the token by re-fetching the profile.
7. Test failure handling:
   - Try connecting a **personal** Instagram account → clear "not a
     professional account" error, nothing is stored.
   - Click Connect and hit **Cancel** in Instagram's dialog → "connection was
     cancelled".
   - **Disconnect** → the row and its encrypted tokens are deleted.

---

## 8. Known gaps / before production

- **One workspace per user.** Each user gets exactly one workspace at
  sign-up; there's no team invite flow, workspace switcher, or way to add a
  second member to `socialflow_workspace_members` yet, though the schema and
  route-level checks already support multiple members per workspace.
- **No password reset / email verification.** Signing up only checks the
  email is well-formed, not that it's reachable. Losing a password currently
  means losing the account — no reset-by-email flow exists yet.
- **Meta data deletion callback** (`/api/connections/facebook/data-deletion`) is
  not implemented yet and is required for App Review, for both Facebook and
  Instagram.
- **Disconnect doesn't revoke on the provider's side** for any platform (Meta,
  LinkedIn or Google). Revoking `DELETE /me/permissions` on Meta, for example,
  would revoke the app for that user across *all* their Pages/accounts and
  workspaces, not just the one being disconnected. Users can revoke access in
  their own account settings on each platform. `youtube.ts` exports
  `revokeGoogleToken` for a future explicit "revoke on disconnect" option, but
  it isn't wired into the disconnect route.
- **Instagram permission verification is limited.** `verifyAccount` only
  re-checks token validity, not granted scopes — see §4 for why.
- **Rate limiting is per-process, in-memory.** Fine for a single instance;
  a multi-instance deployment needs a shared store (Redis or similar).
- **No background health checks.** Status is checked on demand (**Check**).
  A scheduled job calling `verifyConnectedAccount` would catch revocations
  proactively.
- **No publishing yet.** This phase covers user accounts and connections
  only, for all four platforms.
