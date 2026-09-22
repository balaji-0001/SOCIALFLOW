# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run test` — API tests (vitest; route tests skip until the DB schema is pushed)
- Required env: `DATABASE_URL` — Postgres connection string, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` (32 bytes base64). Platform credentials: see `docs/oauth-setup.md`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `docs/oauth-setup.md` — OAuth setup per platform (developer apps, scopes, redirect URLs, approval) and how to test
- `lib/db/src/schema/` — Drizzle schema (workspaces/sessions, oauth states, connected accounts, pending connections)
- `lib/api-spec/openapi.yaml` — API contract; run codegen after editing
- `artifacts/api-server/src/lib/oauth/` — shared OAuth core: `types.ts` (adapter interface), `registry.ts`, `accounts.ts`, `config.ts`; platform adapters in `providers/`
- `artifacts/api-server/src/routes/connections.ts` — connect/callback/pick/list/verify/disconnect routes
- `artifacts/socialflow/src/App.tsx` — `Workspace` page (channel cards, account picker)

## Architecture decisions

- OAuth tokens are AES-256-GCM encrypted with AAD bound to workspace+platform+account; never returned by the API.
- Redirect URIs come from `OAUTH_REDIRECT_BASE_URL` / Replit domain env vars, never the Host header.
- After the callback, provider accounts go to an encrypted "pending connection" so the user picks which Pages/orgs/channels to connect.
- No user auth yet: a workspace is bound to a signed session cookie (`api-server/src/lib/session.ts`); swap `resolveWorkspace` when auth lands.
- Unimplemented platforms are registered as placeholders and report `implemented: false`; nothing is mocked.

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Orval generates colliding names for operations with both path and query params, and for component schemas named `<OperationId>Body`. The OAuth start/callback redirect routes are therefore not in the OpenAPI spec.
- Facebook Page tokens don't expire; LinkedIn/Google tokens do. Use `ensureFreshToken` before calling provider APIs.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
