# Project Rules

Rules for anyone (people or AI assistants) changing this project. They exist because the app holds real accounts and real tokens.

## Honesty
1. No fake, demo, mock or seed data in the product. If a network or provider can't supply something, show an "unavailable" state that says why, and document it.
2. Unreported metrics are `null` and shown as unavailable, never as zero.
3. Say what is unverified. Don't claim a network behaviour works until it has been tried against that network.

## Safety
4. Never print, log, commit or paste secrets or tokens (`.env` values, OAuth tokens, API keys, `TOKEN_ENCRYPTION_KEY`). Report only whether a value is set, or its length.
5. Never run tests, scripts or experiments against the real dev database `socialflow`. Use `socialflow_test` (`postgresql://postgres@localhost:5433/socialflow_test`).
6. The dev database holds real users and real connected accounts. Do not delete, publish, or mutate them. Temporary browser-test users use `@socialflow.test` emails and must be cleaned up afterwards.
7. Do not break or replace existing OAuth (Facebook, Instagram, LinkedIn, YouTube) or other working code.
8. Server-side fetching of user-supplied URLs must be SSRF-safe (see `lib/link-preview.ts`).

## Database
9. Schema changes are additive migrations in `lib/db/src/migrations*.ts`: new tables, new nullable columns, new indexes. Never drop or rewrite existing data.
10. Keep the Drizzle schema in `lib/db/src/schema` in step with the SQL.
11. `drizzle-kit push` does not work locally; use migrations.

## API and permissions
12. `lib/api-spec/openapi.yaml` is the source of truth. Change it, run codegen, then use the generated hooks and zod.
13. Request bodies are named component schemas (inline bodies collide in orval). Avoid schema names that equal operation-derived names (for example `<Operation>Body`, `<Operation>Params`).
14. Routes check permissions with `requireAccess(req, res, "<permission>")`. Never compare role names in a route. Change what a role may do only in `lib/permissions.ts`.
15. Every route is workspace-scoped; never return another workspace's data.

## Frontend
16. Use theme tokens (`hsl(var(--token))`) only, so dark and light both work. No hard-coded colours.
17. Pages must work down to 390 px wide with no horizontal page scroll, be keyboard accessible, and have loading, error and empty states.
18. Respect permissions in the UI (hide or disable), but never rely on it; the server enforces.
19. Key controls carry `data-testid` attributes.
20. Grid layouts that hold wide content need `grid-template-columns: minmax(0, 1fr)` so they don't grow past the viewport.

## Testing and definition of done
21. After each change run: typecheck (`pnpm run typecheck`), API tests on the test DB (`DATABASE_URL=...socialflow_test pnpm --filter @workspace/api-server run test`), the frontend build, and the relevant browser suite.
22. New behaviour ships with tests. Tests that call external networks must fake them (`vi.stubGlobal("fetch", ...)`); never call real networks from tests.
23. The sign-up rate limiter is 10 per hour per IP. If browser tests get 429, restart the API dev server.

## Process
24. Work autonomously: inspect, plan, implement, test, fix. Stop and ask only for credentials or access that can't be obtained.
25. Confirm before anything hard to reverse or outward-facing (deleting data, sending real email, publishing to real accounts).
26. Keep changes focused and match the surrounding code's style and comment density.
