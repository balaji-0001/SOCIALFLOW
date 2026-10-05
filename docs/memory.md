# Project Memory

Context that isn't obvious from the code. Read this first when picking the project up again. It contains no secrets.

## Environment (Windows, this machine)
- Repo root: `C:\BALAJI\SocialFlow-Manager\SocialFlow-Manager` (nested; the outer `C:\BALAJI\SocialFlow-Manager` also has an old `.env`). The API reads the `.env` inside the inner folder (`--env-file-if-exists=.env` and `../../.env` relative to `backend/api-server`). Keep the inner one authoritative.
- Shell is Git Bash or PowerShell. Python isn't installed. Large inline `node -e` or heredocs with quotes tend to break; write `.cjs` files instead.
- vitest can't run natively on some Windows setups (Linux-only native binaries); the API tests do run here via `pnpm --filter @workspace/api-server run test`.
- MySQL 8.4 in `local-mysql\` (server unpacked from the official Windows ZIP in `server\`, data in `data\`; not in git), port **3307**, user `root` without a password (local only). `run-dev.ps1` starts it. The data folder's name must not start with a dot or InnoDB refuses to start.
- The old PostgreSQL 18 cluster in `.postgres_data` (port **5433**, `pg_ctl -D .postgres_data -o "-p 5433" start`) holds the data from before the move to MySQL. Keep it until the MySQL copy has been in use for a while.
- Databases: `socialflow` (real data) and `socialflow_test` (tests only). `DATABASE_URL` is not set globally; pass it per command.
- Ports: API 5000, Vite 3000 (proxies `/api`). The API dev script builds then starts, so restart it after backend changes and expect about 45 s.
- Public URL: Cloudflare quick tunnel (`cloudflared tunnel --url http://localhost:3000`). The URL changes every time it restarts; update `OAUTH_REDIRECT_BASE_URL` in `.env` and the redirect URIs in each network's console. A Microsoft dev tunnel also works but shows a consent page first.

## Real data present
The dev database holds two real user accounts and a real connected Facebook Page and Instagram account. Never mutate or publish against them. Browser tests create temporary `@socialflow.test` users and delete them; check with `node ~/leftover.cjs` (expects no leftovers).

## Gotchas and decisions
- Sign-up is rate limited to 10 per hour per IP. Repeated browser test runs cause 429; restart the API to reset.
- After changing `backend/db` types run `pnpm run typecheck:libs` before typechecking the API, or you'll see false errors.
- Orval collisions: don't name a schema `<Operation>Body` or `<Operation>Params`, don't use inline request bodies, and don't mix path and query parameters on one operation when a same-named type would be generated (`getInboxThread` has no `accountId` query for that reason).
- OpenAPI schema indentation: schemas live at 4 spaces under `components.schemas`; merging fragments at the wrong indent gives "Property X is not expected here".
- Approvals gate publishing in SQL (`publishBlockedSql`); both the scheduler claim and the missed-post sweep use it.
- Library-referenced media is exempt from the orphan-media sweeper.
- The analytics collector, inbox collector and report scheduler run inside the API. `*_DISABLED=true` turns each off.
- Permissions: owner and admin have everything; approver = read + `approvals:decide`; viewer = read.
- Comment, insight and messaging scopes are only requested when `COMMENT_SCOPES_ENABLED`, `ANALYTICS_SCOPES_ENABLED`, `MESSAGING_SCOPES_ENABLED` are true, because Meta and Google reject unapproved scopes at sign-in.
- Password-reset browser tests must use `MAIL_TRANSPORT=log`; with SMTP configured they would send real email.
- A flaky browser check exists in `phase1-ui` ("settings shows the tag"); a rerun passes.
- Grid pages need `minmax(0, 1fr)` columns or wide children stretch the page on mobile.

## User preferences
- No fake or demo data, ever; document unsupported things instead.
- Don't break working OAuth or code; never expose secrets.
- Work autonomously and test after each phase; ask only when blocked on credentials or access.
- The user tends to say "run project" or "give website link": start MySQL, API, Vite (and the tunnel if asked) and report the URL.

## Where things are documented
`PRD.md` (what), `architecture.md` (how it fits), `TRD.md` (technical requirements), `implementation.md` (how to build, run and test), `Rules.md`, `design.md` and `design-system.md`, `task.md` (status), plus feature docs `composer.md`, `media.md`, `oauth-setup.md`, `meta-setup.md`, `password-reset.md`, `publishing-features.md`, `team-inbox-approvals-ai-library.md`.
