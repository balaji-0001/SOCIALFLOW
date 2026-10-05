# SocialFlow Manager

A social media management app: connect your social accounts once, then write, schedule and publish posts to all of them from one calendar. It is a web app with its own user accounts and workspaces, and it talks to each network only through that network's official sign-in (OAuth) and API.

There is no demo or sample data anywhere in the project. A network that isn't set up shows "Setup required" and names the settings it is missing.

## 1. Project overview

The project is one repository (a pnpm workspace) with two programs you run:

- **The API** (`backend/api-server`): an Express server. It owns the database, signs users in, holds the encrypted tokens of connected social accounts, publishes posts on schedule and runs the other background jobs.
- **The website** (`frontend/socialflow`): a React single-page app. It only ever calls `/api` on its own address; in development the dev server forwards `/api` to the API, and in production the host or a reverse proxy does.

Data lives in a MySQL 8 database. Uploaded pictures and videos are stored on the API's disk.

## 2. Features

- **Accounts and teams**: email and password sign-up, password reset by email, workspaces, team invitations and roles, an approval step before publishing.
- **Connected networks**: Facebook Pages, Instagram professional accounts, LinkedIn profiles and company Pages, YouTube channels, X (Twitter).
- **Publishing**: text, pictures and video; a different text per network; scheduling, drafts, posting queues, recurring posts, a first comment, tags and custom fields; a calendar with drag to reschedule; "publish now" and retry.
- **Media library** with upload limits per workspace.
- **Analytics** and scheduled PDF reports by email.
- **Inbox** for comments (direct messages and mentions where the network has granted the permission).
- **Automations**: share new WordPress posts or RSS items automatically, CSV bulk import, and a WordPress plugin (`wordpress-plugin/`) that shares each post the moment it is published.
- **AI Studio** for drafting text (only when an Anthropic API key is set).
- **Legal pages** (`/privacy`, `/terms`, `/data-deletion`) and Meta's data deletion callback.

What each area supports, and what it deliberately doesn't, is described in `docs/`. X support has been tested only against a stand-in for X's API, not against X itself (`docs/twitter-setup.md`).

## 3. Tech stack

Everything is written in **TypeScript 5.9** and runs on **Node.js 24**, in one **pnpm workspace**.

**Frontend** (`frontend/socialflow`)

| Purpose | Technology |
|---|---|
| User interface | React 19 |
| Dev server and build | Vite 7 |
| Styling | Tailwind CSS 4, plus the project's own `sfa-*` classes and design tokens |
| Pages and navigation | wouter 3 |
| Loading data from the API | TanStack Query 5, through a generated client (`frontend/api-client-react`) |
| Dialogs, menus, tooltips | Radix UI |
| Charts | Recharts 2 |
| Icons, dates | lucide-react, date-fns |

**Backend** (`backend/api-server`)

| Purpose | Technology |
|---|---|
| Web server | Express 5 |
| Database access | Drizzle ORM 0.45 on the `mysql2` driver (`backend/db`) |
| Request and response checking | Zod schemas generated from the API description (`backend/api-zod`) |
| Sign-in | Email and password (scrypt, built into Node), signed session cookie |
| Social networks | Each network's OAuth 2.0 sign-in and official API; tokens encrypted with AES-256-GCM |
| Email | nodemailer (any SMTP account) |
| Pictures, PDF reports, feeds, CSV | sharp, pdfkit, fast-xml-parser, papaparse |
| Logs | pino |
| AI text (optional) | Anthropic API |

**Database**: MySQL 8 (8.0.19 or later; developed on 8.4).

**Shared and tooling**

| Purpose | Technology |
|---|---|
| API description | OpenAPI (`backend/api-spec/openapi.yaml`); client and schemas generated with Orval 8 |
| Tests | Vitest 5 and supertest, against a real MySQL test database; the networks are replaced by local stand-ins |
| Build | esbuild (backend, one bundled file), Vite (frontend) |
| WordPress plugin | PHP (`wordpress-plugin/`) |
| Hosting configs included | Render (`render.yaml`), Vercel (`vercel.json`) |

## 4. Project structure

The code is in two folders: everything that runs in the browser is under `frontend/`, and everything that runs on the server is under `backend/`.

```
frontend/
  socialflow/          the website (src/App.tsx, src/app/)
  api-client-react/    the generated client the website uses to call the API
  mockup-sandbox/      a separate sandbox for design mockups; not part of the product
backend/
  api-server/          the API (src/routes, src/lib, src/lib/oauth/providers/<network>.ts)
  db/                  database connection, table definitions (src/schema), migrations (src/baseline.ts, src/migrations.ts)
  api-spec/            the OpenAPI description of the API; the client and the schemas are generated from it
  api-zod/             the generated request and response schemas
  scripts/             maintenance commands (migrate, the one-time PostgreSQL to MySQL copy), tunnel.ps1
wordpress-plugin/      the "SocialFlow Auto Share" WordPress plugin (PHP; runs on the WordPress site)
docs/                  setup guides and design notes
.env.example           every setting, with comments
render.yaml            Render blueprint (API + static site)
vercel.json            Vercel config for the website
run-dev.ps1            starts everything on Windows
```

Each folder inside `frontend/` and `backend/` is a package of one pnpm workspace, so there is a single `pnpm install` and one lockfile at the root. The files at the root (`package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, the hosting configs) belong to both sides.

## 5. Prerequisites

- **Node.js 24**.
- **pnpm** (tested with 12.3). npm and yarn are refused by the install script.
- **MySQL 8.0.19 or later**, local or hosted. MariaDB has not been tested.
- **Windows x64 or Linux x64.** `pnpm-workspace.yaml` leaves out the native build tools for other systems (macOS, ARM); to build there, remove the matching lines under `overrides` and run `pnpm install` again (not tested).
- On Windows, **Git for Windows**, with its `bin` folder on the PATH: the install script runs `sh`.
- A developer app on each network you want to connect (sections 13 to 15). The app runs without any of them.

## 6. Installation steps

```bash
git clone <this repository's address>
cd <the folder it created>
pnpm install
```

Then set up the environment (section 7) and the database (section 8), and start it (section 10).

## 7. Environment variable setup

Copy `.env.example` to `.env` in the repository root and fill it in. The API reads `.env` when it starts, so restart it after a change. On a hosting service, set the same names in its environment or secrets page instead. **Never commit `.env`**; git ignores it.

These are required. Everything else in `.env.example` is optional and explained there.

| Name | What to put |
|---|---|
| `DATABASE_URL` | `mysql://user:password@host:3306/database`. For a hosted server add `?ssl-mode=REQUIRED` or set `DATABASE_SSL=true`. |
| `SESSION_SECRET` | Any long random text. `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes in base64. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Keep a backup: without it the stored social tokens can't be read and every account has to be connected again. |
| `OAUTH_REDIRECT_BASE_URL` | The address people open the site at, no trailing slash: `http://localhost:3000` in development, `https://app.example.com` in production. |
| `PORT` | The port the API listens on. `5000` in development. |

Each network needs its own pair of values (for example `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET`); see sections 13 to 15. Email needs `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`; without them password reset says email isn't set up.

## 8. Database setup

Create an empty database and a user for it (any names; put them in `DATABASE_URL`):

```sql
CREATE DATABASE socialflow CHARACTER SET utf8mb4;
CREATE USER 'socialflow'@'localhost' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON socialflow.* TO 'socialflow'@'localhost';
```

Then create the tables:

```bash
pnpm --filter @workspace/scripts run migrate
```

This prints `Applied: 0001_mysql_baseline` and `The database has 44 tables.` You can skip the command: the API runs the same step every time it starts.

There is no seed data and none is needed. Open the site, choose **Sign up**, and the first account and its workspace are created. The repository contains no database contents; never add a dump of a real database to it.

The API sets each connection up itself (UTC time zone, `READ COMMITTED`, strict mode), so the MySQL server needs no special configuration. More detail: `docs/mysql.md`.

## 9. Database migrations

- `backend/db/src/baseline.ts` creates every table (43 tables and their 74 foreign keys) in an empty database.
- `backend/db/src/migrations.ts` holds later changes, in order, each as a list of single SQL statements. Add new changes there; they must only add things, never drop data.
- `backend/db/src/migrate.ts` applies whatever a database hasn't had yet and records it in the `socialflow_migrations` table. It is safe to run at any time and from several processes at once.
- Run it with `pnpm --filter @workspace/scripts run migrate`, or just start the API.
- `backend/db/src/schema/` is the same structure as TypeScript, for writing queries. Keep it in step with the migrations by hand. **Never run `drizzle-kit push`**: it would try to rebuild the tables from the TypeScript files.

## 10. Local development commands

Two terminals, from the repository root:

```bash
pnpm --filter @workspace/api-server run dev     # builds the API and starts it on PORT (5000)
pnpm --filter @workspace/socialflow run dev     # the website on http://localhost:3000
```

Open <http://localhost:3000>. The API does not watch files: after changing API code, stop it and run the command again.

On Windows, `./run-dev.ps1` starts MySQL (if a portable server is unpacked in `local-mysql\server`, see `docs/mysql.md`, or one is already listening on port 3307), the API and the website.

Other commands:

| Command | What it does |
|---|---|
| `pnpm run typecheck` | Type-checks every package |
| `pnpm --filter @workspace/api-server run test` | API tests. Set `DATABASE_URL` to a database whose name ends in `_test`; the tests create its tables |
| `pnpm --filter @workspace/api-spec run codegen` | Regenerates the client and schemas after editing `openapi.yaml` |
| `pnpm run build` | Type-checks, then builds every package |

Running the tests:

```bash
# once, in MySQL:  CREATE DATABASE socialflow_test CHARACTER SET utf8mb4;
DATABASE_URL="mysql://user:password@127.0.0.1:3306/socialflow_test" pnpm --filter @workspace/api-server run test
```

In PowerShell, set the variable first: `$env:DATABASE_URL = "mysql://..."`. Tests that create and publish posts only run against a `_test` database; never point them at a database with real posts.

## 11. Frontend setup

- Source: `frontend/socialflow`. Development: `pnpm --filter @workspace/socialflow run dev`.
- The website has no API address built into it. It calls `/api/...` on whatever address it is served from, so the website and the API must appear under one address.
- In development the dev server forwards `/api` to `http://localhost:5000`. These are read from the shell, not from `.env`:

  | Name | Default | Meaning |
  |---|---|---|
  | `VITE_PORT` | `3000` | Port of the dev server |
  | `API_PROXY_TARGET` | `http://localhost:5000` | Where `/api` is forwarded |
  | `BASE_PATH` | `/` | Path the site is served under |

- Production build: `pnpm --filter @workspace/socialflow run build`. The result is static files in `frontend/socialflow/dist/public`. The build also packs the WordPress plugin into `downloads/socialflow-auto-share.zip` and writes the legal pages as plain HTML.

## 12. Backend setup

- Source: `backend/api-server`. It reads `.env` from the repository root.
- `GET /api/healthz` answers 200 when it is up.
- `GET /api/connections/providers` lists every network: whether its settings are present, which are missing, and the exact callback address to register.
- **CORS**: only the address in `OAUTH_REDIRECT_BASE_URL` is allowed, with cookies. The website and API share an address, so no other origin is ever needed.
- The API trusts one proxy in front of it (`trust proxy`), so it must run behind exactly one in production (the host's router or your reverse proxy) for HTTPS cookies and per-address limits to work.
- Uploads are stored in `MEDIA_STORAGE_DIR` (default `backend/api-server/.data/media`). On a server this must be a disk that survives restarts.

## 13. OAuth setup for Meta (Facebook and Instagram)

Full guides: `docs/meta-setup.md` and `docs/oauth-setup.md`.

**Facebook Pages**

1. At <https://developers.facebook.com/apps>, create an app (use case "Manage everything on your Page").
2. App settings, Basic: copy the App ID and App Secret into `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET`. Add your domain, a privacy policy address (`<site>/privacy`) and the data deletion callback (`<site>/api/data-deletion/meta`).
3. Add the product **Facebook Login for Business** (or Facebook Login) and add the callback address under **Valid OAuth Redirect URIs**.
4. Permissions requested: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` (and `business_management`, optional).
5. In Development mode only people with a role on the app can connect, which is enough for your own accounts. Use by anyone needs App Review and Business Verification.

**Instagram** (Instagram Login; no Facebook Page needed)

1. In the same Meta app, add the **Instagram** product and open "API setup with Instagram login".
2. Copy the Instagram app ID and secret into `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET`. These are not the Facebook app's values.
3. Add the Instagram callback address under Business login settings, OAuth redirect URIs. **Instagram requires https**, even for testing (see Troubleshooting for a tunnel).
4. Only Business or Creator accounts can connect. Permissions: `instagram_business_basic`, `instagram_business_content_publish`.

## 14. OAuth setup for LinkedIn

1. At <https://www.linkedin.com/developers/apps>, create an app linked to a LinkedIn company Page.
2. Auth tab: copy the Client ID and Secret into `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`, and add the callback address under Authorized redirect URLs.
3. Products: add **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn**. That is enough to post as a member.
4. Company Pages are optional: they need LinkedIn's **Community Management API** (a separate review, on its own app). Then set `LINKEDIN_ORG_ENABLED=true` and `LINKEDIN_API_VERSION` (format `YYYYMM`).
5. Tokens last 60 days; most apps get no refresh token, so the account then shows **Reconnect**.

## 15. OAuth setup for Google / YouTube

1. At <https://console.cloud.google.com>, create a project and enable **YouTube Data API v3**.
2. OAuth consent screen: External; add the scopes `.../auth/youtube.readonly` and `.../auth/youtube.upload`.
3. Credentials, Create OAuth client ID, type **Web application**: add the callback address under Authorized redirect URIs and copy the values into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. While the consent screen is in **Testing**, add your Google account as a test user; sign-ins then expire after 7 days and the channel shows **Reconnect**.
5. Until Google has audited the project, uploaded videos are forced to private. `YOUTUBE_DEFAULT_PRIVACY` chooses private, unlisted or public afterwards.

**X (Twitter)** is set up the same way with `TWITTER_CLIENT_ID` and `TWITTER_CLIENT_SECRET`; X charges for every post. See `docs/twitter-setup.md`.

## 16. Required redirect/callback URLs

`<site>` is the value of `OAUTH_REDIRECT_BASE_URL`. Each network compares the address exactly (scheme, host, path, no trailing slash), so register one for every address you use (local, tunnel, production). The API prints the exact values at `GET /api/connections/providers`.

| Network | Address to register |
|---|---|
| Facebook | `<site>/api/connections/facebook/callback` |
| Instagram | `<site>/api/connections/instagram/callback` |
| LinkedIn | `<site>/api/connections/linkedin/callback` |
| Google / YouTube | `<site>/api/connections/youtube/callback` |
| X (Twitter) | `<site>/api/connections/twitter/callback` |
| Meta data deletion callback | `<site>/api/data-deletion/meta` |

## 17. Production deployment instructions

What any deployment needs:

- A MySQL 8 database with backups.
- **One** copy of the API, always running, on Node 24, with a disk that survives restarts for uploads.
- The website's static files and the API under **one https address**: requests to `/api/*` go to the API, everything else to the website's `index.html`.
- The settings from section 7, with `NODE_ENV=production` and `OAUTH_REDIRECT_BASE_URL` set to that address.

Steps on your own server:

1. `pnpm install --frozen-lockfile`
2. `pnpm --filter @workspace/api-server run build` and `pnpm --filter @workspace/socialflow run build`
3. Set the environment, then `pnpm --filter @workspace/scripts run migrate` (optional; the API also does it at start).
4. Start the API with `pnpm --filter @workspace/api-server run start` under a process manager (systemd, pm2).
5. In your web server (nginx, Caddy): serve `frontend/socialflow/dist/public`, forward `/api/` to the API's port, and send unknown paths to `/index.html`.
6. Register the production callback addresses with each network (section 16).

Ready-made configurations:

- **Render**: `render.yaml` describes the API (with a disk) and the static website. Render has no MySQL, so `DATABASE_URL` points at a MySQL service elsewhere. Secrets are entered in Render's dashboard, never stored in the file.
- **Vercel**: `vercel.json` builds and serves the website and forwards `/api` to the API hosted elsewhere.

**Both files contain the address of one particular API service (`socialflow-api-n3e0.onrender.com`). Replace it with your own API's address before deploying.**

Free hosting plans have limits that matter here: a service that sleeps does not publish scheduled posts, a service without a disk loses uploads on every restart, and some hosts block outgoing email ports (25, 465, 587).

## 18. Build/start commands

| Purpose | Command |
|---|---|
| Install exactly what the lockfile says | `pnpm install --frozen-lockfile` |
| Build the API | `pnpm --filter @workspace/api-server run build` (output `backend/api-server/dist/index.mjs`) |
| Start the API | `pnpm --filter @workspace/api-server run start` |
| Build the website | `pnpm --filter @workspace/socialflow run build` (output `frontend/socialflow/dist/public`) |
| Preview the built website locally | `pnpm --filter @workspace/socialflow run serve` |
| Create or update the tables | `pnpm --filter @workspace/scripts run migrate` |
| Type-check and build everything | `pnpm run build` |

## 19. Scheduler/worker setup

There is no separate worker to deploy. The background jobs are timers inside the API process and start when it starts:

| Job | Default interval | Turn off with |
|---|---|---|
| Publishing due posts | every 15 seconds (`PUBLISH_POLL_INTERVAL_MS`) | `PUBLISHER_DISABLED=true` |
| Automations (WordPress, RSS) | WordPress 15 min, RSS 60 min | `AUTOMATIONS_DISABLED=true` |
| Analytics collection | every 6 hours (`ANALYTICS_POLL_HOURS`) | `ANALYTICS_DISABLED=true` |
| Inbox collection | every 10 minutes (`INBOX_POLL_MINUTES`) | `INBOX_DISABLED=true` |
| Sending emailed reports that are due | checked every 5 minutes (`REPORTS_POLL_MINUTES`) | `REPORTS_DISABLED=true` |
| Removing unused uploads | hourly | (always on) |

Consequences:

- The API must be running for anything scheduled to happen. A post that is more than 60 minutes late (`PUBLISH_MISSED_GRACE_MINUTES`) is marked failed instead of being sent late.
- A post is sent at most once. If the API stops in the middle of publishing, that post is marked failed and can be retried by hand; it is never re-sent automatically.
- Run one API process. If you ever run a second, switch the jobs off on it with the settings above; the request limits are also counted per process.

## 20. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `pnpm install` says "Use pnpm instead" | It was started with npm or yarn. Use pnpm. |
| `pnpm install` fails on Windows at the `preinstall` step because `sh` can't be found | Add Git for Windows' `bin` folder to the PATH. |
| Build fails with a missing `@esbuild/...`, `@rollup/...` or `lightningcss` package | You are on macOS or ARM. See Prerequisites. |
| API stops with `PORT environment variable is required`, `SESSION_SECRET must be set` or `DATABASE_URL must be set` | The value is missing from `.env`, or `.env` is not in the repository root. |
| API stops with `DATABASE_URL must be a MySQL address` | The address starts with something other than `mysql://`. |
| Website loads but every request fails | The API isn't running, or it isn't on port 5000. Start the site with `API_PROXY_TARGET=http://localhost:<port>`. |
| A network's card says "Setup required" | Its settings are missing; the card names them. Restart the API after adding them. |
| The network says the redirect address is not allowed | The registered address differs from the real one. Copy `callbackUrl` from `/api/connections/providers`. |
| Instagram refuses to sign in locally | Instagram only accepts https. Install cloudflared (`winget install --id Cloudflare.cloudflared`), run `powershell -File backend/scripts/tunnel.ps1 -Port 3000` (a free tunnel to the website), set `OAUTH_REDIRECT_BASE_URL` to the address it prints, restart the API and register that callback. The address changes each time the tunnel starts. |
| Forgot password: "isn't set up on this server" | The SMTP settings are missing. |
| Forgot password: "We couldn't send the email right now" | The mail server refused. The reason is in the API log. With Gmail, error 535 means the app password is no longer valid. See `docs/password-reset.md`. |
| A reset email bounces | The account was created with a mistyped address. There is no change-email screen; correct it in the `socialflow_users` table. |
| A scheduled post didn't go out | The API was not running at that time, or was more than 60 minutes late. Use **Retry** on the post. |
| Uploaded media disappears after a restart | `MEDIA_STORAGE_DIR` is not on a disk that survives restarts. |
| YouTube shows "Reconnect" every week | The Google consent screen is still in Testing (7-day sign-ins). |
| An error message is replaced by a generic one behind Cloudflare | Cloudflare replaces answers with status 502 or 504 by its own page. |
| Tests fail at once, or many are skipped | `DATABASE_URL` is not set (they fail), or the database name doesn't end in `_test` (the ones that write posts are skipped). |

## 21. Security notes

- **Secrets live only in the environment.** `.env` is ignored by git; `.env.example` holds names and comments only. Nothing secret is sent to the browser.
- **Social tokens are encrypted** in the database (AES-256-GCM) with `TOKEN_ENCRYPTION_KEY`, bound to their workspace and account, and never returned by the API or written to logs. To change the key, put the old one in `TOKEN_ENCRYPTION_KEY_PREVIOUS`.
- **Passwords** are hashed with scrypt. The session cookie is HttpOnly, SameSite=Lax and Secure in production; only its hash is stored.
- **Sign-in to networks** uses a single-use, hashed `state` tied to the browser session, and PKCE where the network supports it. Callback addresses come from `OAUTH_REDIRECT_BASE_URL`, never from the request.
- **CORS** allows only the site's own address.
- **Request limits** protect sign-in, sign-up, password reset and the heavier endpoints. They are counted in memory, per process.
- **Link previews and feed reading** refuse local and private network addresses.
- **Never commit** `.env`, database dumps, uploaded media, or key files; `.gitignore` covers them. If a secret is ever committed or pasted somewhere, replace it at its source (the network's developer console, the mail provider, the database) rather than only deleting the line.
- Keep **production data out of development**: tests run only against a database whose name ends in `_test`.
