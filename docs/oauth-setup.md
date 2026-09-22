# Social account connections (OAuth 2.0)

Socialflow connects social accounts through each platform's **official OAuth
flow and APIs**. It never asks for, sees or stores social media passwords, and
there are no mock or demo accounts: if a platform's credentials, permissions or
app approval are missing, the UI says so and the connect button stays disabled.

| Platform | Status | Account types |
|---|---|---|
| Facebook | **Implemented** | Facebook Pages |
| Instagram | Architecture ready, adapter next | Instagram Business / Creator accounts |
| LinkedIn | Architecture ready, adapter next | Member profiles, organization pages |
| YouTube | Architecture ready, adapter next | YouTube channels |

---

## 1. How it works

```
Browser                         API server (/api)                         Provider
───────                         ─────────────────                         ────────
Connect ──GET /connections/facebook/start──▶ create state (hashed, 10 min, single use,
                                             bound to this browser session)
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
  tied to the browser's session and deleted the moment the callback uses it.
  A callback from another browser, a replay, or an expired state is rejected.
  Providers that support PKCE get an S256 challenge automatically
  (`usesPkce: true`).
- **Token storage.** Access and refresh tokens are encrypted with AES-256-GCM
  (`lib/crypto.ts`). The ciphertext is bound (as AAD) to its workspace, platform
  and account, so it can't be copied to another row. Tokens are never returned
  by the API or logged.
- **Ownership.** Every connected account belongs to a workspace. A workspace can
  hold any number of accounts per platform (unique per workspace + platform +
  external account ID).
- **Health.** `POST /api/connections/:id/verify` asks the provider whether the
  token is still valid and has the required scopes. It marks accounts `active`,
  `expired`, `revoked`, `missing_permissions` or `error`. Unhealthy accounts
  show a **Reconnect** button, which re-runs OAuth for that account (for
  Facebook with `auth_type=rerequest`, so previously declined permissions are
  asked for again).
- **Refresh.** `ensureFreshToken` refreshes tokens that are about to expire
  for providers with refresh tokens (LinkedIn, Google). Facebook Page tokens
  obtained from a long-lived user token don't expire, so Facebook needs no
  refresh.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/connections/providers` | Which platforms are implemented and configured, missing secret **names**, callback URLs |
| GET | `/api/connections/:platform/start[?reconnect=<accountId>]` | Browser navigation that starts OAuth |
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
| `OAUTH_REDIRECT_BASE_URL` | prod | e.g. `https://app.yourdomain.com`. If unset, dev uses `https://$REPLIT_DEV_DOMAIN` and production uses the first `$REPLIT_DOMAINS` entry. Must be HTTPS. |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | Facebook | Meta app → App settings → Basic. |
| `FACEBOOK_GRAPH_API_VERSION` | no | Defaults to `v26.0`. |
| `FACEBOOK_LOGIN_CONFIG_ID` | no | Set if you use *Facebook Login for Business*. Permissions then come from the configuration instead of `scope`. |
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | Instagram (next phase) | |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | LinkedIn (next phase) | |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | YouTube (next phase) | |

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

## 4. Instagram (next phase)

The adapter slot is registered (`instagram`, not implemented). Meta offers two
official paths:

| | Instagram API with **Instagram Login** | Instagram API with **Facebook Login** |
|---|---|---|
| Account needs a linked Facebook Page | No | Yes |
| Credentials | Instagram app ID/secret (Meta app → Instagram product) → `INSTAGRAM_APP_ID/SECRET` | Reuses `FACEBOOK_APP_ID/SECRET` |
| Scopes | `instagram_business_basic`, `instagram_business_content_publish` (+ `instagram_business_manage_comments`, `instagram_business_manage_messages` if needed) | `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement` |
| Tokens | Long-lived 60 days, refresh via `ig_refresh_token` | Page token (non-expiring) |
| Redirect URL | `…/api/connections/instagram/callback` in the Instagram product's *Business login settings* | Same Facebook Login redirect list |

Either way: Business or Creator accounts only (not personal), Development mode
works for app-role users, and public use needs App Review (Advanced Access) and
Business Verification. **Recommended:** Instagram Login, since it doesn't
require customers to link a Facebook Page.

## 5. LinkedIn (next phase)

1. <https://www.linkedin.com/developers/apps> → **Create app**. It must be
   linked to a LinkedIn **Company Page**, and a Page admin must verify it.
2. **Auth** tab: copy the Client ID/Secret into `LINKEDIN_CLIENT_ID/SECRET` and add
   the redirect URLs under *Authorized redirect URLs*.
3. **Products:**
   - *Sign In with LinkedIn using OpenID Connect* → `openid`, `profile` (instant).
   - *Share on LinkedIn* → `w_member_social` (post as the member; instant).
   - *Community Management API* → `r_organization_social`, `w_organization_social`,
     `rw_organization_admin` (organization pages). **Requires an access request
     and review, and LinkedIn requires it to be the only product on its app.**
     Plan for a separate LinkedIn app for organization pages.
4. Tokens last 60 days. Refresh tokens are only issued to approved Community
   Management / Marketing partners. Without one, users reconnect when the
   token expires (the UI will show "Token expired → Reconnect").

## 6. YouTube (next phase)

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
   tokens issued to apps in Testing expire after **7 days**.
5. The adapter will use PKCE, `access_type=offline` and `prompt=consent` to
   get a refresh token, and list channels via `channels.list?mine=true`, which
   can return several channels (Brand Accounts) to pick from.
6. Videos uploaded from **unverified** API projects are locked to *private*
   until the project passes a YouTube API compliance audit. Uploads also cost a
   large share of the default 10,000 units/day quota.

---

## 7. Testing with your own accounts

### Automated tests
```bash
pnpm --filter @workspace/api-server run test
```
- Unit tests: encryption (tamper, AAD, rotation), redirect URL config, and the
  Facebook adapter against a faked Graph API (token exchange, long-lived
  upgrade, `appsecret_proof`, declined scopes, no Pages, revoked/expired
  tokens).
- Route tests (`src/routes/connections.test.ts`) run the full flow against
  Postgres with only Facebook's HTTP faked: start → callback → pick → list →
  verify → reconnect → disconnect, plus state replay, cross-browser state,
  user cancel, missing scopes, workspace isolation and missing credentials.
  **They skip until the schema is pushed** (`pnpm --filter @workspace/db run push`).
  They create and delete their own workspaces.

No real provider is called by the tests. They prove the plumbing, not your Meta
app configuration. For that, do the manual test below.

### Manual Facebook test (Development mode, no App Review needed)
1. Push the schema: `pnpm --filter @workspace/db run push`.
2. Add Secrets: `TOKEN_ENCRYPTION_KEY`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`.
3. Restart the **API Server** workflow.
4. Open `https://<your-repl>.replit.dev/api/connections/providers`. Facebook
   should show `"configured": true`, and `callbackUrl` is the exact URL to paste
   into *Valid OAuth Redirect URIs*.
5. Make sure your Facebook account has a role on the Meta app and manages at
   least one Page (create a test Page if needed).
6. Open `/workspace` → **Facebook Pages → Connect account** → approve in the
   Facebook dialog and choose your Pages → pick them in Socialflow's
   picker → they appear as *Connected*.
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

---

## 8. Known gaps / before production

- **No user login yet.** A workspace is currently tied to a browser session
  cookie (`lib/session.ts`). Clearing cookies loses access to that workspace.
  Before launch, add real authentication and make `resolveWorkspace` return the
  signed-in user's workspace. Nothing else in the OAuth code needs to change.
- **Meta data deletion callback** (`/api/connections/facebook/data-deletion`) is
  not implemented yet and is required for App Review.
- **Disconnect doesn't revoke on Meta's side.** `DELETE /me/permissions` would
  revoke the app for that Facebook user across *all* their Pages and workspaces.
  Users can revoke in Facebook settings.
- **No background health checks.** Status is checked on demand (**Check**).
  A scheduled job calling `verifyConnectedAccount` would catch revocations
  proactively.
- **No publishing yet.** This phase covers connections only.
