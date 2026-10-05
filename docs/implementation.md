# Implementation Guide

How to set up, run, change and test the project.

## 1. Prerequisites
- Node.js 24 and pnpm.
- MySQL 8.0.19 or later (developed and tested on 8.4). See `mysql.md` for why and what the code expects of it.
- Chrome, for the browser test scripts.
- `cloudflared` (or another tunnel) for testing network logins.

## 2. First-time setup
```bash
pnpm install
cp .env.example .env         # then fill it in (never commit it)
```
Minimum `.env`: `DATABASE_URL`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `OAUTH_REDIRECT_BASE_URL`, `PORT=5000`. Generate the key with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
Add each network's credentials as you set them up (`oauth-setup.md`, `meta-setup.md`).

## 3. Running locally
1. MySQL on port 3307 with databases `socialflow` and `socialflow_test` (`CREATE DATABASE socialflow CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`). On Windows, `run-dev.ps1` starts the server unpacked in `local-mysql\` (see `mysql.md`).
2. API: `DATABASE_URL=mysql://root@127.0.0.1:3307/socialflow PORT=5000 pnpm --filter @workspace/api-server run dev` (builds, then starts; the tables are created or updated at start).
3. Frontend: `pnpm --filter @workspace/socialflow run dev` (Vite on 3000, proxies `/api` to 5000).
4. Optional public URL: `cloudflared tunnel --url http://localhost:3000`, then put the printed URL in `OAUTH_REDIRECT_BASE_URL` and restart the API. Add `<url>/api/connections/<platform>/callback` as a redirect URI in each network's console (`facebook`, `instagram`, `linkedin`, `youtube`).

`run-dev.ps1` automates steps 1 to 3 on Windows.

## 4. Making changes

### Add or change an API endpoint
1. Edit `lib/api-spec/openapi.yaml` (named request schemas, `required` lists, nullable as `type: ["string","null"]`).
2. `pnpm --filter @workspace/api-spec run codegen`.
3. Add the route in `artifacts/api-server/src/routes/<area>.ts`, guard it with `requireAccess`, and mount it in `routes/index.ts` if it's a new router.
4. Add tests next to it.

### Add a permission
Add it to the `Permission` type and `ALL_PERMISSIONS` in `lib/permissions.ts`, then to the role lists (`READ`, `EDIT`, or specific roles). The frontend reads `permissions` from `useAuthMe()`.

### Change the database
Append a migration to `lib/db/src/migrations.ts`: a name and a list of single MySQL statements (the comment at the top of the file has an example and the column types to use). Additive only. Update the Drizzle schema in `lib/db/src/schema` and export it from `schema/index.ts`. Then run `pnpm run typecheck:libs`. Write queries with Drizzle where possible; `mysql.md` lists what to use instead of PostgreSQL habits (`returning()`, upserts, `ilike`, arrays, NULL ordering).

### Add a background worker
Follow `lib/analytics.ts` (`startX` / `stopX`, interval env var, `*_DISABLED` switch), and call `startX()` from `src/index.ts`. A worker that claims rows (reports, automations) uses `FOR UPDATE SKIP LOCKED` and moves the row's next run time in the same transaction.

### Add a network capability
Extend the adapter in `lib/oauth/providers/<network>.ts` behind a scope flag if the permission needs app review, and return an honest unavailable state when the scope isn't granted.

### Add a page
Create `app/<name>-page.tsx` and `<name>.css` (class prefix `sfa-<name>-`, theme tokens only), lazy-import it in `App.tsx`, add a route inside `AppShell`, and a nav item in `AppShell.tsx`.

## 5. Testing
| What | Command |
|---|---|
| Typecheck everything | `pnpm run typecheck` |
| API tests | `DATABASE_URL=mysql://root@127.0.0.1:3307/socialflow_test pnpm --filter @workspace/api-server run test` |
| One API test file | `... pnpm --filter @workspace/api-server exec vitest run src/routes/team.test.ts` |
| Frontend build | `pnpm --filter @workspace/socialflow run build` |
| Browser suites | `node <script>.cjs` against `http://localhost:3000` (Playwright-core with Chrome) |

Browser scripts sign up a temporary `@socialflow.test` user, exercise the UI, screenshot it, and delete the user. Do not run them against a database whose real data you can't afford to touch beyond that temporary user. If they return 429 on sign-up, restart the API.

## 6. Build and deploy outline
- `pnpm run build` builds all packages; the API bundle is `artifacts/api-server/dist/index.mjs` and starts with `pnpm --filter @workspace/api-server run start` (`pdfkit` is kept external and must be installed in production).
- The frontend builds to `artifacts/socialflow/dist/public`; serve it as static files behind the same origin as `/api`, or proxy `/api` to the API.
- Production checklist: always-on Node process, managed MySQL 8 with backups, persistent storage for uploads, fixed HTTPS domain, strong `SESSION_SECRET`, backed-up `TOKEN_ENCRYPTION_KEY`, SMTP, network app approvals, log collection.

## 7. Troubleshooting
| Symptom | Fix |
|---|---|
| "0 slots" on Queue | Nothing has been saved. Use a quick-start button or add times and press Save. |
| Network login says redirect URI mismatch | The URI in that console doesn't match `OAUTH_REDIRECT_BASE_URL` exactly (check host and trailing slash). |
| Sign-up returns 429 | Rate limiter; restart the API. |
| MySQL won't start ("UNDO tablespace ... already exists") | The data folder's name must not start with a dot. Use `local-mysql\data`. |
| False type errors after schema edits | `pnpm run typecheck:libs` first. |
| AI Studio says not configured | Set `ANTHROPIC_API_KEY` and restart the API. |
| Inbox, analytics or DMs empty | The needed scope flag is off, the network permission isn't approved, or the account wasn't reconnected. The page shows which. |

## 8. Hosting on Render + a MySQL host
`render.yaml` (repo root) describes two Render services: `socialflow-api` (always-on Node service with a 5 GB disk for uploads at `/var/data/media`) and `socialflow-web` (static site that forwards `/api/*` to the API, so the browser sees one address). The database is any MySQL 8 server: set `DATABASE_URL` to `mysql://user:password@host:3306/database`. Hosted servers want encryption: add `?ssl-mode=REQUIRED` to the address or set `DATABASE_SSL=true` (`verify` also checks the certificate). Startup migrations hold a named lock (`GET_LOCK`), so connect directly or through a pooler that keeps one session per connection. Choosing a host and moving existing data: `mysql.md`. Set `OAUTH_REDIRECT_BASE_URL` to the website's address and add `<address>/api/connections/<platform>/callback` in each network's developer console. The free Render plan sleeps when idle, which stops scheduled posts, so the API uses the paid `starter` plan.

**Fresh databases.** `lib/db/src/baseline.ts` holds every table (as of PostgreSQL migration `0020`, the last one before the move to MySQL). `runMigrations()` applies it to a database that has not recorded it yet, then any later migrations from `migrations.ts`.

**Deployed on the free tiers (Vercel website, Render API, Supabase database), from `main`, which still runs on PostgreSQL.** The website is on Vercel (`vercel.json` forwards `/api/*` to the Render API); `OAUTH_REDIRECT_BASE_URL` on the API is the Vercel address. The API is the Render service `socialflow-api` (free plan) and the website is `socialflow-web` (static site, forwards `/api/*` to the API). The free plan has no disk, so uploads are lost on each restart or deploy, and the service sleeps after about 15 minutes without traffic, which pauses scheduled posts and the background collectors until the next request. Keep it awake with an uptime pinger on `/api/healthz` (for example UptimeRobot, every 5 minutes). Moving to the paid Starter plan plus a disk (see `render.yaml`) removes both limits.

## 9. Automations and CSV bulk import
Three ways of creating posts without the composer. The API contract is in `lib/api-spec/openapi.yaml` (tags `automations` and `bulk-imports`).

**Page.** `artifacts/socialflow/src/app/automations-page.tsx` and `automations.css`, at `/automations` (sidebar: Publish, Automations). Two tabs; the tab is kept in the address (`?tab=import`).
- Automations: summary tiles, one card per automation (status, accounts, mode, last run and its outcome, next run, posts created, the last error and what to do about it) with Pause/Resume, Run now, Edit, History and Delete. The create and edit dialog tests the source and previews the template with the newest real item. History is a drawer with the runs and the recorded items.
- Bulk import: choose a file, options (mode, default accounts, time zone), a preview of every row as the server read it, then the result and the recent imports.
- Nothing on the page is sample data. The check intervals shown come from `pollMinutes` in `GET /automations`. When the workspace requires approval, a note explains that posts made here wait until someone sends them for approval; no request is filed automatically.

**Files.** `lib/feeds.ts` (fetching and parsing: RSS 2.0, RSS 1.0, Atom, WordPress REST), `lib/automations.ts` (the runner and poller), `lib/post-create.ts` (the checks and inserts shared with `POST /posts`), `lib/bulk-import.ts` (CSV parsing, validation, import), `routes/automations.ts`, `routes/bulk-imports.ts`. Tables (in `lib/db/src/baseline.ts`): `socialflow_automations`, `socialflow_automation_items`, `socialflow_automation_runs`, `socialflow_bulk_imports`.

**Sources.** A WordPress automation reads `{site}/wp-json/wp/v2/posts?per_page=10&orderby=date&order=desc&_embed=1&status=publish` and falls back to `{site}/feed/` when the REST API is off (404, 401, not JSON). An RSS automation reads the feed address as given. Every request goes through `safeGet` (`lib/link-preview.ts`): http/https, ports 80 and 443, public addresses only on every redirect hop, 10 s timeout, 2 MB cap. Plainly internal addresses are also refused when an automation is saved. XML entity declarations are refused, and entities are decoded by our own code, so a feed can't expand anything.

**Runs.** The poller (`startAutomations()`, called from `src/index.ts`) wakes every minute and claims up to 10 due, active automations with `FOR UPDATE SKIP LOCKED`, moving `next_run_at` forward in the same transaction. WordPress is checked every `WORDPRESS_POLL_MINUTES` (default 15), RSS every `RSS_POLL_MINUTES` (default 60); `GET /automations` returns both as `pollMinutes`. `AUTOMATIONS_DISABLED=true` stops the poller.
- The first successful fetch is a baseline: every item already there is recorded as `seen` and nothing is posted. With `postExistingOnFirstRun`, only the newest item is posted. Changing the source address takes a new baseline.
- Later runs take the items not yet recorded, newest first, up to `maxPostsPerRun` (1 to 10, default 3), and post the older of those first. The rest stay unrecorded and follow on the next run.
- Duplicate protection: the item row is inserted first (`ON CONFLICT DO NOTHING` on the unique `(automation_id, item_key)`) and only the run that inserted it creates the post. The key is the item's guid or id, else its link, normalised. Concurrent runs create one post.
- The post is created by `insertPost` after the same `validateTargets` and media rules as the composer. Text comes from the template (`{title} {url} {excerpt} {author} {site}`); the link, title, excerpt and picture go into the post's link columns, so Facebook and LinkedIn publish a link card and Instagram uses the picture as its photo. Mode `publish` schedules the post for now (the publisher sends it on its next pass and the approvals gate still applies), `queue` takes the next free slot (or saves a draft with the reason when there is none), `draft` saves a draft. YouTube channels are refused when saving an automation (a video is required).
- A failed fetch raises `consecutive_failures` and backs off: interval x 2^failures, at most 24 hours. Five in a row set the status to `error`, which stops polling until the automation is resumed. A failed item (an account that needs reconnecting, a network rule) is retried on later runs, three attempts in all. A successful fetch resets the failure count.
- The last 50 runs per automation are kept. Create, update, delete, pause and resume are written to the audit log.

**Limits.** 25 automations per workspace; name up to 120 characters; address up to 2,048; template up to 2,000 and it must contain `{title}` or `{url}`; at least one account.

**Permissions.** `automations:read` (every role) and `automations:manage` (owner, admin, editor). Bulk import uses `posts:write`; its history uses `posts:read`.

**CSV bulk import.** `POST /bulk-imports/preview` validates and saves nothing; `POST /bulk-imports` validates again on the server and creates the valid rows, 50 per transaction. The CSV travels as text in the JSON body (1 MB, 500 rows; comma separated; quoted fields may contain commas, quotes and line breaks; BOM and CRLF are fine). Columns, case-insensitive: `content` (required), `scheduled_at`, `accounts`, `link`, `first_comment`, `tags`, `image_url`.
- `scheduled_at`: `YYYY-MM-DD HH:mm` is read in the request's `timezone`; an ISO date with `Z` or an offset is taken as written. Required and in the future for mode `schedule`; ignored (with a warning) for `queue` and `draft`.
- `accounts`: names, usernames or IDs separated by `;` or `|`; empty falls back to `defaultAccountIds`.
- `tags`: existing tag names separated by `;`.
- `image_url`: downloaded on import through the SSRF-safe fetcher and stored as normal media attached to the post. Instagram's copy is converted to JPG, WebP is converted to JPG for the other networks. A download that fails fails only that row. Workspace media quota applies.
- Row checks: content present and within each selected network's character limit, at least one usable account, no duplicate of an earlier row (same content, accounts and time), Instagram needs an `image_url` (no page is fetched for `link`, so the link has no picture), YouTube is refused (a CSV can't attach a video).
- Row numbers are spreadsheet rows: the header is row 1.
- Each import is recorded in `socialflow_bulk_imports` with its counts and per-row errors (`GET /bulk-imports` returns the latest 20) and in the audit log.

**Rate limits** (per address, 10-minute window, overridable): run now 10 (`AUTOMATION_RUN_RATE_LIMIT`), test source 30 (`AUTOMATION_TEST_RATE_LIMIT`), import 10 (`BULK_IMPORT_RATE_LIMIT`), preview 60 (`BULK_IMPORT_PREVIEW_RATE_LIMIT`).

**Tests.** `src/lib/automations.test.ts`, `src/routes/automations.test.ts`, `src/routes/bulk-imports.test.ts`. Websites are stubbed at `linkPreviewDeps.request` / `lookup`; no test reaches the network.

## 10. WordPress plugin
A fourth way of creating posts: the SocialFlow plugin on a WordPress site sends each post the moment it is published, instead of the site being checked every 15 minutes. It is an automation of kind `wordpress_plugin` and reuses everything in section 9 (the template, the modes, `createPostForItem`, the item table's duplicate protection, the history). Only what differs is described here.

**Files.** Plugin: `wordpress-plugin/socialflow-auto-share/` (`socialflow-auto-share.php`, `assets/editor.js`, `uninstall.php`, `readme.txt`). Server: `lib/wordpress-plugin.ts` (keys, signatures, reading what the plugin sends), `routes/wordpress-plugin.ts` (the four endpoints the plugin calls), `ingestPushedItem()` in `lib/automations.ts`, the plugin parts of `routes/automations.ts`. Table `socialflow_wordpress_connections` (in `lib/db/src/baseline.ts`). The download is packed by `artifacts/socialflow/scripts/build-wordpress-plugin.mjs` into `public/downloads/socialflow-auto-share.zip` before the dev server and every build (the zip is not committed).

**Connecting.** Creating a plugin automation (`POST /automations` with `kind: "wordpress_plugin"`, no `sourceUrl`) also creates its connection and returns `connectionKey` once: `sfwp1_` + base64url of `<api address>\n<key id>\n<secret>`. The address is `OAUTH_REDIRECT_BASE_URL`; the request's Origin is used instead only when it is this installation's own host or a localhost address (development), so a key can never point a site's posts at another server. The secret is stored encrypted (`lib/crypto.ts`) and never returned again; `POST /automations/{id}/plugin-key` replaces the key, which cuts the old plugin off at once. The user pastes the key under Settings > SocialFlow in WordPress; the plugin calls `connect` and the automation shows the site.

**The plugin's requests.** `POST /wordpress-plugin/connect | status | posts | disconnect`, JSON, no session. Each carries `X-SocialFlow-Key` (the key id), `X-SocialFlow-Timestamp` (Unix seconds) and `X-SocialFlow-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the secret>`. The server keeps the raw body for these routes (`app.ts`), compares in constant time and allows 10 minutes of clock difference. 401 `unknown_key` means the key was replaced or its automation deleted; `bad_signature` and `stale_timestamp` say what they are; 409 `not_connected` means the plugin was disconnected.

**A published post.** `posts` takes `{ post: { id, guid, title, excerpt, url, imageUrl, author, publishedAt }, manual? }` and answers 200 with `result`:
- `created`: the item was recorded and its post made through the automation's settings (`post.status` is `scheduled` or `draft`).
- `duplicate`: the automation already has this post. Identity is the WordPress guid, normalised like a feed item's key, so a retry, a second editor, a changed permalink or publishing again never makes a second post. The unique `(automation_id, item_key)` index holds for requests that arrive together.
- `skipped`: the automation is paused in SocialFlow. Nothing is recorded.
- `failed`: the post can't be made as it is (for example Instagram without a picture); `message` says why. It is tried again when the plugin sends it again, three times automatically; `manual: true` ("Share now" in WordPress) lifts that limit.
A site may send 30 new posts an hour (`WORDPRESS_PLUGIN_POSTS_PER_HOUR`); beyond that the answer is 429 and the plugin retries later. Nothing is fetched when a post arrives; pictures are fetched when the post is published, through the SSRF-safe fetcher.

**What the plugin does.** On `transition_post_status` to `publish` it notes the post, and at the end of that request (so the featured image and the per-post choice are saved) it decides and sends. Not shared automatically: other post types than the ticked ones, imports, password-protected posts, posts dated more than 3 days ago, posts with "Share on social media" unticked, anything while auto-sharing is switched off, and posts it has already sent. If SocialFlow can't be reached it tries again after 1, 5, 30 and 120 minutes (WP-Cron). The Posts list has a SocialFlow column and a "Share now" row action; Settings > SocialFlow shows the connection, what SocialFlow says became of the latest posts, and a log. Everything the plugin stores is removed when it is deleted.

**Never polled.** A plugin automation has no next run: the poller skips the kind, `run-now` answers 400 `nothing_to_check`, and resuming it only makes it accept posts again. Two automations on one site (a connected plugin and a polled one) would each post an article; the page flags the pair on both cards.

**Tests.** `src/routes/wordpress-plugin.test.ts` signs requests the way the plugin does. The plugin itself was run in a real WordPress (WordPress Playground on the development machine) against the local API: WordPress 7.1.2 on PHP 8.3 and WordPress 6.2.13 on PHP 7.4, including installing it from the zip with WordPress's own installer. It has not been run on a hosted WordPress site.
