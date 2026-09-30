# Architecture

## Overview
A pnpm monorepo with one API server, one React single-page app and shared libraries.

```
Browser (React SPA, Vite)  --/api-->  Express API  -->  PostgreSQL
                                        |  \--> filesystem (uploaded media)
                                        |--> Facebook / Instagram / LinkedIn / YouTube APIs
                                        |--> SMTP (email)
                                        \--> Anthropic API (AI Studio)
```

## Packages
| Path | What it is |
|---|---|
| `artifacts/api-server` | Express 5 API, background workers, tests (vitest + supertest) |
| `artifacts/socialflow` | React 19 + Vite + wouter + react-query frontend |
| `artifacts/mockup-sandbox` | Design sandbox, not part of the product |
| `lib/db` | Drizzle schema, additive SQL migrations, migration runner |
| `lib/api-spec` | `openapi.yaml`, the single source of truth for the API, and the orval config |
| `lib/api-client-react` | Generated react-query hooks and types |
| `lib/api-zod` | Generated zod validators used by the server |
| `scripts` | Small maintenance helpers, `tunnel.ps1` |

## API contract flow
1. Edit `lib/api-spec/openapi.yaml`.
2. Run `pnpm --filter @workspace/api-spec run codegen` (orval writes the client and zod, then type-checks the libraries).
3. The server validates with the generated zod; the frontend uses the generated hooks.

## Server structure (`artifacts/api-server/src`)
- `routes/`: one router per area (auth, connections, posts, media, organize, queues, recurrences, team, analytics, approvals, inbox, ai, library, link-preview, reports, health). `routes/index.ts` mounts them under `/api`.
- `lib/`: the logic behind the routes. Notable pieces:
  - `permissions.ts`: the one role-to-permission table. Routes call `requireAccess(req, res, permission)` from `access.ts`; they never compare role names.
  - `session.ts`: cookie session, active workspace.
  - `publisher.ts`: claims due posts with `FOR UPDATE SKIP LOCKED` and publishes; fails posts that are far past their time.
  - `oauth/`: provider adapters for each network (connect, refresh, publish, metrics, comments, messages), token storage and encryption.
  - `analytics.ts`, `inbox.ts`, `reports.ts`: background collectors and schedulers.
  - `approvals.ts`: the publish gate (`publishBlockedSql`) used by the publisher and the publish-now route.
  - `link-preview.ts`: SSRF-safe page fetcher.
  - `mail.ts`: nodemailer SMTP wrapper (with a log-only mode for development).
  - `audit.ts`: audit trail.
- `middlewares/`: rate limiting and other request middleware.

## Background workers (all run inside the API process)
| Worker | Interval | Env switches |
|---|---|---|
| Publisher | about 15 s | `PUBLISH_*` |
| Media sweeper | periodic | media config |
| Analytics collector | every 6 h | `ANALYTICS_POLL_HOURS`, `ANALYTICS_DISABLED` |
| Inbox collector | 10 min (first run 90 s after start) | `INBOX_POLL_MINUTES`, `INBOX_DISABLED` |
| Report scheduler | 5 min | `REPORTS_POLL_MINUTES`, `REPORTS_DISABLED` |

If the API process stops, none of these run. Scheduled posts wait, then fail as missed after the grace window.

## Data model (main tables, all prefixed `socialflow_`)
- Identity and workspaces: `users`, `workspaces`, `workspace_members`, `sessions`, `oauth_states`, `password_resets`, `invitations`, `audit_log`.
- Accounts: `connected_accounts`, `pending_connections`.
- Posts: `posts`, `post_targets` (one row per account, with its own status), `post_platform_content`, `media`, `post_media`, `tags`, `post_tags`, custom fields, mention groups.
- Scheduling: `account_queues`, `queue_slots`, `recurrences`.
- Analytics: `account_metrics`, `post_metrics` (snapshots; null means "not reported").
- Approvals: `approval_settings`, `post_approvals`, `post_approval_comments`.
- Inbox: `inbox_items`, `inbox_replies`, `inbox_sync`.
- AI: `brand_voices`, `ai_usage`.
- Library: `library_items`, `library_folders`.
- Reports: `report_schedules`, `report_runs`.

Migrations are ordered SQL (`0001` to `0017`) recorded in `socialflow_migrations` and applied at API start under an advisory lock. They are additive only.

## Frontend structure (`artifacts/socialflow/src`)
- `App.tsx`: marketing site, auth pages and the route table (pages lazy-loaded).
- `app/`: the signed-in product. `AppShell.tsx` (sidebar, top bar, workspace switcher), one file per page (calendar, posts, queue, recurring, team, analytics, approvals, inbox, ai, library, settings), the composer split across `composer*.tsx`, and shared primitives in `ui.tsx`.
- Styling: CSS tokens in `index.css`, the Aurora dark theme in `aurora.css`, per-page CSS files. Components use `hsl(var(--token))` only, so light and dark both work. See `design-system.md`.

## Security model
- Session cookie; sign-up and other sensitive routes are rate limited.
- Social tokens are encrypted at rest with `TOKEN_ENCRYPTION_KEY` (a previous key can be kept for rotation).
- Permissions are checked server-side on every route; the UI only hides what a role can't do.
- Link preview and any server-side fetch refuse private, loopback and metadata addresses.
- Invitation and reset tokens are stored only as SHA-256 hashes.

## Local development
- Postgres 18 on port 5433 (`.postgres_data`), API on 5000, Vite on 3000 (proxies `/api`).
- A public HTTPS tunnel (Cloudflare quick tunnel or a dev tunnel) is needed for the network logins; its URL goes in `OAUTH_REDIRECT_BASE_URL`.

## Deployment notes
Needs an always-on Node process, managed Postgres with backups, persistent storage for uploads, a fixed HTTPS domain, and production secrets. See `PRD.md` section 7 and `TRD.md`.
