# Implementation Guide

How to set up, run, change and test the project.

## 1. Prerequisites
- Node.js 24 and pnpm.
- PostgreSQL 18 (any 14+ should work).
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
1. Postgres: `pg_ctl -D .postgres_data -o "-p 5433" start` (create the cluster with `initdb` first if it doesn't exist; create databases `socialflow` and `socialflow_test`).
2. API: `DATABASE_URL=postgresql://postgres@localhost:5433/socialflow PORT=5000 pnpm --filter @workspace/api-server run dev` (builds, then starts; migrations apply at start).
3. Frontend: `pnpm --filter @workspace/socialflow run dev` (Vite on 3000, proxies `/api` to 5000).
4. Optional public URL: `cloudflared tunnel --url http://localhost:3000`, then put the printed URL in `OAUTH_REDIRECT_BASE_URL` and restart the API. Add `<url>/api/connections/<platform>/callback` as a redirect URI in each network's console (`facebook`, `instagram`, `linkedin`, `youtube`).

`run-dev.ps1` automates steps 1 to 3 on Windows, but its schema-push step doesn't work locally; the API applies migrations on its own.

## 4. Making changes

### Add or change an API endpoint
1. Edit `lib/api-spec/openapi.yaml` (named request schemas, `required` lists, nullable as `type: ["string","null"]`).
2. `pnpm --filter @workspace/api-spec run codegen`.
3. Add the route in `artifacts/api-server/src/routes/<area>.ts`, guard it with `requireAccess`, and mount it in `routes/index.ts` if it's a new router.
4. Add tests next to it.

### Add a permission
Add it to the `Permission` type and `ALL_PERMISSIONS` in `lib/permissions.ts`, then to the role lists (`READ`, `EDIT`, or specific roles). The frontend reads `permissions` from `useAuthMe()`.

### Change the database
Append a migration to `lib/db/src/migrations.ts` (or a `migrations-<name>.ts` file imported and spread there). Additive only. Update the Drizzle schema in `lib/db/src/schema` and export it from `schema/index.ts`. Then run `pnpm run typecheck:libs`.

### Add a background worker
Follow `lib/analytics.ts` (`startX` / `stopX`, interval env var, `*_DISABLED` switch), and call `startX()` from `src/index.ts`.

### Add a network capability
Extend the adapter in `lib/oauth/providers/<network>.ts` behind a scope flag if the permission needs app review, and return an honest unavailable state when the scope isn't granted.

### Add a page
Create `app/<name>-page.tsx` and `<name>.css` (class prefix `sfa-<name>-`, theme tokens only), lazy-import it in `App.tsx`, add a route inside `AppShell`, and a nav item in `AppShell.tsx`.

## 5. Testing
| What | Command |
|---|---|
| Typecheck everything | `pnpm run typecheck` |
| API tests | `DATABASE_URL=postgresql://postgres@localhost:5433/socialflow_test pnpm --filter @workspace/api-server run test` |
| One API test file | `... pnpm --filter @workspace/api-server exec vitest run src/routes/team.test.ts` |
| Frontend build | `pnpm --filter @workspace/socialflow run build` |
| Browser suites | `node <script>.cjs` against `http://localhost:3000` (Playwright-core with Chrome) |

Browser scripts sign up a temporary `@socialflow.test` user, exercise the UI, screenshot it, and delete the user. Do not run them against a database whose real data you can't afford to touch beyond that temporary user. If they return 429 on sign-up, restart the API.

## 6. Build and deploy outline
- `pnpm run build` builds all packages; the API bundle is `artifacts/api-server/dist/index.mjs` and starts with `pnpm --filter @workspace/api-server run start` (`pdfkit` is kept external and must be installed in production).
- The frontend builds to `artifacts/socialflow/dist/public`; serve it as static files behind the same origin as `/api`, or proxy `/api` to the API.
- Production checklist: always-on Node process, managed Postgres with backups, persistent storage for uploads, fixed HTTPS domain, strong `SESSION_SECRET`, backed-up `TOKEN_ENCRYPTION_KEY`, SMTP, network app approvals, log collection.

## 7. Troubleshooting
| Symptom | Fix |
|---|---|
| "0 slots" on Queue | Nothing has been saved. Use a quick-start button or add times and press Save. |
| Network login says redirect URI mismatch | The URI in that console doesn't match `OAUTH_REDIRECT_BASE_URL` exactly (check host and trailing slash). |
| Sign-up returns 429 | Rate limiter; restart the API. |
| Postgres "rejecting connections" after a crash | Wait for recovery (about 20 s), or delete a stale `postmaster.pid` and start again. |
| False type errors after schema edits | `pnpm run typecheck:libs` first. |
| AI Studio says not configured | Set `ANTHROPIC_API_KEY` and restart the API. |
| Inbox, analytics or DMs empty | The needed scope flag is off, the network permission isn't approved, or the account wasn't reconnected. The page shows which. |

## 8. Hosting on Render + Supabase
`render.yaml` (repo root) describes two Render services: `socialflow-api` (always-on Node service with a 5 GB disk for uploads at `/var/data/media`) and `socialflow-web` (static site that forwards `/api/*` to the API, so the browser sees one address). The database is Supabase: set `DATABASE_URL` to its **Session pooler** (port 5432) or **Direct** connection string, never the Transaction pooler (port 6543), because startup migrations hold an advisory lock. SSL is switched on automatically for Supabase addresses (or with `DATABASE_SSL=true`). Set `OAUTH_REDIRECT_BASE_URL` to the website's address and add `<address>/api/connections/<platform>/callback` in each network's developer console. The free Render plan sleeps when idle, which stops scheduled posts, so the API uses the paid `starter` plan.
