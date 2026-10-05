# Meta OAuth setup for Socialflow

This guide describes the Meta integration that exists in the current codebase.
It does not ask Socialflow for a Facebook or Instagram password. The browser is
sent to Meta's consent screen, and the API server handles the authorization
code and encrypted tokens.

## Current implementation status

| Integration | Current status | Account type |
|---|---|---|
| Facebook Login | **Implemented** | Facebook Pages |
| Instagram Login | **Implemented** | Instagram Business / Creator accounts |
| Instagram through Facebook Login | **Not implemented** | Not built; Instagram Login is used instead (see below) |

The Facebook adapter is `backend/api-server/src/lib/oauth/providers/facebook.ts`,
using Facebook Login and the Facebook Graph API to list Facebook Pages. The
Instagram adapter is `backend/api-server/src/lib/oauth/providers/instagram.ts`,
using the Instagram API with Instagram Login — a separate product from
Facebook Login, with its own app ID/secret and its own token endpoints on
`api.instagram.com` / `graph.instagram.com`. It authenticates a single
Instagram professional account directly; no linked Facebook Page is required
or used.

Do not copy an Instagram account ID or an access token into an app ID or app
secret field. Socialflow only accepts Meta app credentials in the secrets
listed below.

## Exact OAuth routes

The routes are implemented in
`backend/api-server/src/routes/connections.ts`:

| Purpose | Exact path |
|---|---|
| Start Facebook OAuth | `GET /api/connections/facebook/start` |
| Facebook callback | `GET /api/connections/facebook/callback` |
| Start Instagram OAuth | `GET /api/connections/instagram/start` |
| Instagram callback | `GET /api/connections/instagram/callback` |

Both paths are usable now that the Instagram adapter is implemented. The two
platforms use independent app credentials and independent redirect URI lists
in the Meta dashboard, even though both are configured from the same Meta app.

For Facebook and Instagram, the full redirect URIs are:

```text
<redirect-base>/api/connections/facebook/callback
<redirect-base>/api/connections/instagram/callback
```

The redirect base is selected in this order:

1. `OAUTH_REDIRECT_BASE_URL`, if set. Its path is stripped and its origin is
   used.
2. In development, `https://` plus `REPLIT_DEV_DOMAIN`.
3. In production, `https://` plus the first entry in `REPLIT_DOMAINS`.

The value must be HTTPS except for local `http://localhost` testing. Do not
derive this URL from an incoming request host.

Examples:

```text
https://<development-domain>/api/connections/facebook/callback
https://<production-domain>/api/connections/facebook/callback
https://app.example.com/api/connections/facebook/callback
```

Register the exact development and production URLs separately in Meta. Do not
add a trailing slash, change the scheme, or register `/api/social/...`; that
is not a route in the current server.

The current server also exposes the computed URL without secrets:

```text
GET /api/connections/providers
```

Read the `callbackUrl` for the `facebook` and `instagram` providers and copy
each exact value into the matching redirect URL configuration — they are
registered in different places in the Meta dashboard (see below).

## Replit Secret names

Copy only the corresponding values from Meta Developer Dashboard into Replit
Secrets. Never put these values in frontend code, `docs/`, or logs.

### Required for the implemented Facebook adapter

| Replit Secret | Copy from Meta | Required |
|---|---|---|
| `FACEBOOK_APP_ID` | Meta Developer Dashboard → App settings → Basic → App ID | Yes |
| `FACEBOOK_APP_SECRET` | Meta Developer Dashboard → App settings → Basic → App Secret | Yes |

### Required for the implemented Instagram adapter

| Replit Secret | Copy from Meta | Required |
|---|---|---|
| `INSTAGRAM_APP_ID` | Meta Developer Dashboard → Instagram product → API setup with Instagram login → Instagram app ID | Yes |
| `INSTAGRAM_APP_SECRET` | Same page → Instagram app secret | Yes |

These are **not** the same values as `FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET`,
even though both live inside the same Meta app. Do not reuse one pair for the
other; the adapter will fail token exchange if you do.

### Optional Facebook adapter settings

| Replit Secret | Purpose |
|---|---|
| `FACEBOOK_LOGIN_CONFIG_ID` | Optional Facebook Login for Business configuration ID. When set, the Meta configuration supplies the permissions and the adapter sends `config_id` instead of a `scope` parameter. |
| `FACEBOOK_GRAPH_API_VERSION` | Optional Graph API version such as `v26.0`. If omitted, the adapter uses `v26.0`. |

### Required shared server settings

These are not Meta app credentials, but the existing OAuth path requires them:

| Replit Secret / variable | Purpose |
|---|---|
| `SESSION_SECRET` | Signs the `sf_session` HTTP-only cookie. The API server refuses to start without it. |
| `TOKEN_ENCRYPTION_KEY` | Encrypts OAuth tokens with AES-256-GCM. It must decode to exactly 32 bytes as base64 or 64-character hex. Losing it makes stored tokens unreadable. |
| `OAUTH_REDIRECT_BASE_URL` | Recommended for production. Set it to the public origin only, for example `https://app.example.com`. |
| `DATABASE_URL` | Required by the database package for workspace, OAuth state, pending connection, and connected account storage. |

`TOKEN_ENCRYPTION_KEY_PREVIOUS` is optional and is used only during key
rotation. `REPLIT_DEV_DOMAIN` and `REPLIT_DOMAINS` are supplied by the
environment and are fallback inputs for redirect URL construction; do not copy
them from Meta into app credential fields.

## Meta Developer Portal setup for Facebook Pages

### 1. Create or select the Meta app

1. Open <https://developers.facebook.com/apps/>.
2. Create a Business app, or use an existing app that is allowed to use
   Facebook Login and the Pages APIs.
3. In **App settings → Basic**, copy the App ID and App Secret into:
   `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET`.
4. Add the development hostname and production hostname to **App domains**.
5. Add the app's privacy policy URL and data deletion instructions/callback
   configuration required by Meta before requesting Live access.

### 2. Add the required product

Use **Facebook Login for Business** when the Meta dashboard presents that
product and create a Login for Business configuration. Put its configuration
ID in `FACEBOOK_LOGIN_CONFIG_ID`.

The adapter also supports the standard Facebook Login dialog when
`FACEBOOK_LOGIN_CONFIG_ID` is absent. In that mode it sends the permissions in
the next section as the OAuth `scope` value.

In the selected Facebook Login product settings:

1. Enable web/client OAuth login as applicable.
2. Enable HTTPS enforcement for non-local environments.
3. Add both exact Facebook callback URLs under **Valid OAuth Redirect URIs**.
4. Keep the app ID and secret server-side only.

### 3. Configure permissions

The implemented adapter requests these required permissions:

| Permission | Why Socialflow requests it |
|---|---|
| `pages_show_list` | Find the Pages the authorized Facebook user manages. |
| `pages_read_engagement` | Read the Page data needed to identify and verify the Page. |
| `pages_manage_posts` | Publish content to the selected Page. |

The adapter also requests this optional permission when it uses the standard
scope flow:

| Permission | Why |
|---|---|
| `business_management` | Helps find Pages owned through a Business Portfolio. |

If `FACEBOOK_LOGIN_CONFIG_ID` is set, configure the required permissions in
that Meta Login for Business configuration instead of relying on the URL
scope list.

The callback checks the permissions returned by Meta. If any required
permission is missing, the connection is rejected and no account token is
stored. Pages whose returned tasks do not allow content creation are shown as
non-selectable.

## App Review and access levels

### Development mode

For initial testing, keep the Meta app in Development mode. Add the person
testing the flow as an app Admin, Developer, or Tester, and have that person
manage at least one Facebook Page. Development mode is not a public customer
setup; non-role users cannot complete the flow normally.

### Live access

Before public users can authorize the app:

1. Request the access level required for each permission in Meta App Review.
2. Provide a screencast showing the complete flow: Socialflow connect button,
   Meta consent, Page selection, and the resulting connected Page.
3. Explain why each permission is needed and how Page content is used.
4. Complete Meta Business Verification if Meta requires it for the requested
   products or access levels.
5. Provide valid privacy policy and data deletion information.
6. Move the app to Live only after the requested permissions and business
   requirements are approved.

Meta may change review and access requirements. Check the current status shown
in the Meta dashboard before submitting an app review request.

## Instagram Professional accounts: implemented via Instagram Login

The Instagram adapter (`backend/api-server/src/lib/oauth/providers/instagram.ts`)
implements the **Instagram API with Instagram Login** product:

```text
INSTAGRAM_APP_ID
INSTAGRAM_APP_SECRET
instagram_business_basic
instagram_business_content_publish
```

The callback path is:

```text
<redirect-base>/api/connections/instagram/callback
```

registered separately from Facebook's redirect URIs, under the Instagram
product's own *Business login settings*.

Only Business and Creator (professional) accounts can complete the flow; a
personal account is rejected after the callback with a message telling the
user to switch account type in the Instagram app. One Instagram Login
authenticates exactly one account — the account being logged into — so there
is no multi-Page-style discovery step the way there is for Facebook.

The alternative path, **Instagram API with Facebook Login** (an Instagram
account linked to a Facebook Page, authorized through the Facebook Login
redirect list), is not implemented. Instagram Login and Facebook Login are
different products with different scopes, token behavior, and account
prerequisites; this guide does not claim the Facebook Login path works.

## Security architecture being verified

The Facebook and Instagram flows both use the shared OAuth architecture:

1. The start route creates a random state value, stores only its SHA-256 hash,
   gives it a ten-minute expiry, and binds it to the signed browser session
   and workspace.
2. The callback deletes the matching state before continuing, so it is
   single-use. A replay, expired state, or different browser session is
   rejected.
3. The server exchanges the code and upgrades the user token without returning
   tokens to the browser (long-lived user token for Facebook, long-lived
   access token for Instagram).
4. Candidates (Facebook Pages, or the single Instagram professional account)
   are held in an encrypted pending payload for fifteen minutes. The API
   response contains token-free summaries.
5. Selected Page tokens are stored as AES-256-GCM ciphertext. The additional
   authenticated data binds each ciphertext to its workspace, platform,
   account, and token type.
6. Connected account APIs never return access or refresh tokens.
7. Account ownership is checked against the current workspace for listing,
   verification, reconnect, and disconnect.
8. Facebook Graph requests use `appsecret_proof`; application secrets and
   token values are not logged for either platform.

## Development test procedure

This is the real-provider acceptance test. Do not use a Facebook or Instagram
password in Socialflow, and do not paste a token into Replit Secrets.

1. In Replit Secrets, set `TOKEN_ENCRYPTION_KEY`, `FACEBOOK_APP_ID`,
   `FACEBOOK_APP_SECRET`, `INSTAGRAM_APP_ID`, and `INSTAGRAM_APP_SECRET`.
   Keep `SESSION_SECRET` and `DATABASE_URL` configured.
2. Set `OAUTH_REDIRECT_BASE_URL` to the public development origin if the
   fallback domain is not the one registered in Meta. Instagram Login
   requires HTTPS even in Development mode — `http://localhost` is rejected,
   unlike Facebook Login.
3. Restart the API Server workflow.
4. Open:

   ```text
   https://<development-domain>/api/connections/providers
   ```

5. Confirm the Facebook and Instagram providers both report
   `implemented: true`, `configured: true`, and the expected `callbackUrl`.
   The response must contain no app secret or access token.
6. Add each exact callback URL to its matching Meta redirect URI list before
   starting OAuth — Facebook's under Facebook Login for Business, Instagram's
   under the Instagram product's Business login settings.
7. Open `/workspace`. For Facebook, choose **Facebook Pages → Connect
   account**, complete the Meta consent dialog, and select a Page. For
   Instagram, choose **Instagram → Connect account** and sign in with an
   Instagram Business or Creator account — it connects automatically with no
   picker step.
8. Confirm the connected account appears in the workspace. Use **Check** to
   re-verify against the provider.
9. Test cancel, a missing required permission, reconnect, and disconnect for
   both platforms. For Instagram, also test connecting a personal account and
   confirm it is rejected with a clear message. Disconnect removes the local
   encrypted token row; it does not revoke the Meta app for the whole
   Facebook or Instagram user.

## Production test procedure

1. Deploy the API and web workflows using the same database and a production
   `OAUTH_REDIRECT_BASE_URL`.
2. Copy the production callback URL exactly into Meta's valid redirect URI
   list:

   ```text
   https://<production-domain>/api/connections/facebook/callback
   https://<production-domain>/api/connections/instagram/callback
   ```

3. Confirm the production deployment has the same named secrets:
   `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `FACEBOOK_APP_ID`,
   `FACEBOOK_APP_SECRET`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, and, if
   used, `FACEBOOK_LOGIN_CONFIG_ID`.
4. Open the production `/api/connections/providers` endpoint and compare its
   `callbackUrl` to the URL registered in Meta.
5. With a real Meta app-role tester, run one complete connection, verify, and
   disconnect cycle before requesting Live access.
6. After App Review and Business Verification are complete, test with a
   separate authorized customer account. Never use a copied access token as a
   substitute for the OAuth callback.

## Current verification status

The code and tests cover the state binding, token encryption, workspace
ownership, Facebook and Instagram adapter behavior (against faked provider
HTTP), and route handling, including the full connect → pick → list → verify
→ reconnect → disconnect flow against a real Postgres database. Both
providers report `configured: true` with real app credentials in the local
development environment.

A real, browser-driven Meta OAuth consent screen has **not** been clicked
through in this environment — that step requires a human in a browser and
cannot be automated here. Do not mark Meta setup complete until the manual
development test procedure above has been run by hand for both Facebook and
Instagram, and the callback URL returned by `/api/connections/providers`
matches the URL registered in Meta for each platform.