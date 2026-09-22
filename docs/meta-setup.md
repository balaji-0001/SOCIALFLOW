# Meta OAuth setup for Socialflow

This guide describes the Meta integration that exists in the current codebase.
It does not ask Socialflow for a Facebook or Instagram password. The browser is
sent to Meta's consent screen, and the API server handles the authorization
code and encrypted tokens.

## Current implementation status

| Integration | Current status | Account type |
|---|---|---|
| Facebook Login | **Implemented** | Facebook Pages |
| Instagram Login | **Not implemented** | No Instagram accounts can be connected yet |
| Instagram through Facebook Login | **Not implemented** | No Instagram adapter exists yet |

The existing Meta adapter is `artifacts/api-server/src/lib/oauth/providers/facebook.ts`.
It uses Facebook Login and the Facebook Graph API to list Facebook Pages. The
Instagram entry in the provider registry is a placeholder with
`implemented: false`; its start route deliberately returns `not_configured`.

Do not copy an Instagram account ID or an access token into an app ID or app
secret field. Socialflow only accepts Meta app credentials in the secrets
listed below.

## Exact OAuth routes

The routes are implemented in
`artifacts/api-server/src/routes/connections.ts`:

| Purpose | Exact path |
|---|---|
| Start Facebook OAuth | `GET /api/connections/facebook/start` |
| Facebook callback | `GET /api/connections/facebook/callback` |
| Start an Instagram flow in the future | `GET /api/connections/instagram/start` |
| Instagram callback path reserved by the shared router | `GET /api/connections/instagram/callback` |

The Instagram paths are not currently usable because the Instagram adapter is
not implemented.

For Facebook, the full redirect URI is:

```text
<redirect-base>/api/connections/facebook/callback
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

Read the `callbackUrl` for the `facebook` provider and copy that exact value
into Meta's redirect URL configuration.

## Replit Secret names

Copy only the corresponding values from Meta Developer Dashboard into Replit
Secrets. Never put these values in frontend code, `docs/`, or logs.

### Required for the implemented Facebook adapter

| Replit Secret | Copy from Meta | Required |
|---|---|---|
| `FACEBOOK_APP_ID` | Meta Developer Dashboard → App settings → Basic → App ID | Yes |
| `FACEBOOK_APP_SECRET` | Meta Developer Dashboard → App settings → Basic → App Secret | Yes |

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

## Instagram Professional accounts: current limitation

The current code does **not** implement Instagram Login or Instagram
Professional account discovery. The provider registry currently lists the
following placeholder values only:

```text
INSTAGRAM_APP_ID
INSTAGRAM_APP_SECRET
instagram_business_basic
instagram_business_content_publish
```

Those names are not enough to make Instagram work today. There is no
Instagram adapter that exchanges the code, calls the Instagram API, verifies
the account, or stores an Instagram account through the shared connection
architecture. Do not add Instagram credentials and assume that the flow is
working.

When Instagram support is implemented, the intended callback path reserved by
the shared router will be:

```text
<redirect-base>/api/connections/instagram/callback
```

The exact Meta product and permissions must be selected with the adapter
implementation. Instagram Login and Instagram API with Facebook Login have
different products, scopes, token behavior, and account prerequisites. This
guide intentionally does not claim either path is implemented.

## Security architecture being verified

The existing Facebook flow uses the shared OAuth architecture:

1. The start route creates a random state value, stores only its SHA-256 hash,
   gives it a ten-minute expiry, and binds it to the signed browser session
   and workspace.
2. The callback deletes the matching state before continuing, so it is
   single-use. A replay, expired state, or different browser session is
   rejected.
3. The server exchanges the code and upgrades the user token without returning
   tokens to the browser.
4. Facebook Page candidates are held in an encrypted pending payload for
   fifteen minutes. The API response contains token-free summaries.
5. Selected Page tokens are stored as AES-256-GCM ciphertext. The additional
   authenticated data binds each ciphertext to its workspace, platform,
   account, and token type.
6. Connected account APIs never return access or refresh tokens.
7. Account ownership is checked against the current workspace for listing,
   verification, reconnect, and disconnect.
8. Graph requests use `appsecret_proof`; application secrets and token values
   are not logged.

## Development test procedure

This is the real-provider acceptance test. Do not use a Facebook or Instagram
password in Socialflow, and do not paste a token into Replit Secrets.

1. In Replit Secrets, set `TOKEN_ENCRYPTION_KEY`, `FACEBOOK_APP_ID`, and
   `FACEBOOK_APP_SECRET`. Keep `SESSION_SECRET` and `DATABASE_URL` configured.
2. Set `OAUTH_REDIRECT_BASE_URL` to the public development origin if the
   fallback domain is not the one registered in Meta.
3. Restart the API Server workflow.
4. Open:

   ```text
   https://<development-domain>/api/connections/providers
   ```

5. Confirm the Facebook provider reports `implemented: true`,
   `configured: true`, and the expected `callbackUrl`. The response must
   contain no app secret or access token.
6. Add that exact callback URL to Meta before starting OAuth.
7. Open `/workspace`, choose **Facebook Pages → Connect account**, complete
   the Meta consent dialog, and select a Page in Socialflow.
8. Confirm the selected Page appears as connected. Use **Check** to call
   Meta's token verification path.
9. Test cancel, a missing required permission, reconnect, and disconnect.
   Disconnect removes the local encrypted token row; it does not revoke the
   Meta app for the whole Facebook user.

## Production test procedure

1. Deploy the API and web workflows using the same database and a production
   `OAUTH_REDIRECT_BASE_URL`.
2. Copy the production callback URL exactly into Meta's valid redirect URI
   list:

   ```text
   https://<production-domain>/api/connections/facebook/callback
   ```

3. Confirm the production deployment has the same named secrets:
   `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `FACEBOOK_APP_ID`,
   `FACEBOOK_APP_SECRET`, and, if used, `FACEBOOK_LOGIN_CONFIG_ID`.
4. Open the production `/api/connections/providers` endpoint and compare its
   `callbackUrl` to the URL registered in Meta.
5. With a real Meta app-role tester, run one complete connection, verify, and
   disconnect cycle before requesting Live access.
6. After App Review and Business Verification are complete, test with a
   separate authorized customer account. Never use a copied access token as a
   substitute for the OAuth callback.

## Current verification status

The code and tests cover the state binding, token encryption, workspace
ownership, Facebook adapter behavior, and route handling. A real Meta OAuth
callback has **not** been verified in this environment because the Meta
credentials are currently not configured. The Instagram callback cannot be
verified because its adapter is not implemented.

Do not mark Meta setup complete until the real-provider development procedure
has completed successfully and the callback URL returned by
`/api/connections/providers` matches the URL registered in Meta.