# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/api-server run test` — API tests (vitest; set `DATABASE_URL` to a database whose name ends in `_test`)
- Required env: `DATABASE_URL` — MySQL 8 connection string (`mysql://user:password@host:3306/database`), `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` (32 bytes base64). Platform credentials: see `docs/oauth-setup.md`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: MySQL 8 + Drizzle ORM (`docs/mysql.md`)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `docs/oauth-setup.md` — user accounts + OAuth setup per platform (developer apps, scopes, redirect URLs, approval) and how to test
- `lib/db/src/schema/` — Drizzle schema (users, workspaces, workspace members, sessions, oauth states, connected accounts, pending connections)
- `lib/api-spec/openapi.yaml` — API contract; run codegen after editing
- `artifacts/api-server/src/lib/password.ts` — scrypt password hashing (no third-party hashing dependency)
- `artifacts/api-server/src/lib/session.ts` — auth sessions + workspace resolution (`resolveUser`, `resolveWorkspace`, `createSession`, `clearSession`)
- `artifacts/api-server/src/routes/auth.ts` — signup/login/logout/me
- `artifacts/api-server/src/middlewares/rate-limit.ts` — in-memory per-IP rate limiting (auth routes)
- `artifacts/api-server/src/lib/oauth/` — shared OAuth core: `types.ts` (adapter interface), `registry.ts`, `accounts.ts`, `config.ts`; platform adapters in `providers/` (all four platforms implemented)
- `artifacts/api-server/src/routes/connections.ts` — connect/callback/pick/list/verify/disconnect routes, all requiring an authenticated session
- `artifacts/socialflow/src/App.tsx` — landing page, `SignIn`, and the accounts page (`AccountsContent`, channel cards + account picker)
- `artifacts/socialflow/src/app/` — signed-in app, lazy-loaded from `App.tsx`: `AppShell` (sidebar, top bar, user menu, mobile bottom nav, auth gate), `calendar.tsx` (month/week/day/list, hover previews, drag to reschedule), `composer.tsx` (create/edit/schedule dialog), `posts-pages.tsx` (dashboard, manage posts, drafts), `ui.tsx` (Button, IconButton, Skeleton, PageHeader, EmptyState, ErrorState, Spinner), `confirm.tsx` (`useConfirm()`, use instead of `window.confirm`), `app.css`
- `docs/design-system.md` — SocialFlow Aurora dark theme: tokens, how it is applied, shell/composer/dashboard layout, what is intentionally shown as unavailable
- `docs/publishing-features.md` — Phase 1 advanced publishing: migrations runner, per-network content, posting queues, recurring posts, first comment (per-network permissions), tags, custom fields, mention groups
- `docs/media.md` — the media uploader (images/video), storage, limits, env vars, and what is not built (sending media to networks, object storage)
- `docs/composer.md` — what the Create Post composer supports (accounts, emoji, hashtags, UTM, live previews, network checks, local autosave, shortcuts) and what is intentionally unavailable (sending media to networks, link-preview fetching, AI, Canva, tags, per-network text)
- Design tokens (colors, type scale, spacing, radius, shadows, motion) live in `:root` in `artifacts/socialflow/src/index.css`; one font family (Inter). New UI should use the `sfa-*` classes and tokens, not raw colors
- `artifacts/api-server/src/routes/posts.ts` — posts CRUD (`socialflow_posts`, `socialflow_post_targets`); drafts have no time, scheduled posts need content, ≥1 healthy account and a future time
- `artifacts/api-server/src/lib/publisher.ts` — the publishing engine. A scheduler (`startPublisher`, started from `index.ts`, every 15s) atomically claims due posts (`FOR UPDATE SKIP LOCKED`), sends each to its accounts through the adapter's `publishPost`, and records per-account results. **At-most-once**: a post interrupted mid-publish is failed (never auto-retried) because retrying could post twice; a due post more than `PUBLISH_MISSED_GRACE_MINUTES` (60) late is failed instead of sent late. `POST /api/posts/:id/publish` ("Publish now" / Retry) runs the same code synchronously and only re-sends accounts that haven't published.
- Publishing is implemented for **Facebook Pages** (verified against the Graph API shape and tested with a fake) and **LinkedIn** (member and organization text posts via UGC Posts; tested with a fake only, not yet exercised against LinkedIn). Media (images/video) publishing is implemented for Facebook, Instagram and LinkedIn (tested with fakes; Instagram/LinkedIn media not yet exercised live; Instagram needs a public https `OAUTH_REDIRECT_BASE_URL`). YouTube publishes one video per post via the resumable upload API (private by default; tested with a fake only).

## Architecture decisions

- OAuth tokens are AES-256-GCM encrypted with AAD bound to workspace+platform+account; never returned by the API.
- Redirect URIs come from `OAUTH_REDIRECT_BASE_URL` / Replit domain env vars, never the Host header.
- After the callback, provider accounts go to an encrypted "pending connection" so the user picks which Pages/orgs/channels to connect.
- Real user accounts: email + scrypt-hashed password, a session cookie identifies the user, and the workspace they act on is resolved through `socialflow_workspace_members` (never a client-supplied workspace ID) — see `api-server/src/lib/session.ts`. Every connection route requires a session; the browser-facing `/connections/:platform/start` route redirects a signed-out visitor to `/signin?next=<url>` and resumes that exact URL after login.
- CORS is locked to `OAUTH_REDIRECT_BASE_URL` (or Replit's own domain) with credentials, since the frontend and API always share an origin; there's no legitimate cross-origin caller.
- All four platforms (Facebook, Instagram, LinkedIn, YouTube) are implemented behind the shared `OAuthProviderAdapter` interface. A future platform not yet built would be registered as a placeholder reporting `implemented: false`; nothing is ever mocked.

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Orval generates colliding names for operations with both path and query params, and for component schemas named `<OperationId>Body`. The OAuth start/callback redirect routes are therefore not in the OpenAPI spec. A component schema literally named `<PascalCase(operationId)>Response` also collides with orval's own generated per-operation response type — the auth routes use operation IDs like `authSignup` (not `signup`) specifically to dodge this against schemas named `SignupResponse` etc.
- Facebook Page tokens don't expire; Instagram (60 days), LinkedIn (60 days) and Google tokens do. Use `ensureFreshToken` before calling provider APIs.
- Instagram Login requires HTTPS redirect URIs even in Development mode — unlike Facebook Login, `http://localhost` is rejected. Use a tunnel (`cloudflared tunnel --url http://localhost:5000`, see `scripts/tunnel.ps1`) or a Replit domain for local Instagram testing.
- Instagram has no separate refresh token; the long-lived access token is refreshed in place via `ig_refresh_token` and stored as its own "refresh token" so it reuses the shared `ensureFreshToken` logic unchanged.
- LinkedIn organization discovery is opt-in (`LINKEDIN_ORG_ENABLED`) and needs `LINKEDIN_API_VERSION` (`YYYYMM`) for the versioned `/rest/` endpoints; the member flow needs neither. Refresh tokens are only issued to approved Marketing Developer Platform partners — most apps won't get one, and that's expected, not a bug.
- Google's `invalid_grant` error means different things depending on which call failed: a bad/expired authorization code during exchange, or a dead refresh token during refresh. `youtube.ts`'s error mapping handles each call site separately rather than trying to infer it generically.
- The publisher tests (`lib/publisher.test.ts`) create due, overdue and stuck posts and the publisher acts on *every* due post in the database, so they only run when `DATABASE_URL` points at a database whose name ends in `_test` (they skip otherwise). Create one with `createdb socialflow_test`, push the schema to it, and run the api-server tests with that URL. Never point them at a database holding real posts.
- `AUTH_LOGIN_RATE_LIMIT` / `AUTH_SIGNUP_RATE_LIMIT` are set very high in `vitest.config.ts` — tests create many accounts from one IP within a single process and would otherwise trip the real per-IP limiter.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
