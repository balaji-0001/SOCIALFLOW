# Technical Requirements (TRD)

## 1. Stack
| Layer | Choice |
|---|---|
| Runtime | Node.js 24, TypeScript ~5.9, pnpm workspaces |
| API | Express 5, drizzle-orm, `mysql2`, zod (generated), pino logging, nodemailer, pdfkit, sharp (image conversion) |
| Database | MySQL 8.0.19+ (developed on 8.4); see `mysql.md` |
| Frontend | React 19, Vite 7, wouter, @tanstack/react-query, Radix UI primitives, lucide icons, date-fns |
| API contract | OpenAPI 3 + orval (client and zod generation) |
| Tests | vitest + supertest (API), playwright-core scripts driving Chrome (UI) |

## 2. Functional requirements
See `PRD.md`. Technically, the system must:
- FR1. Authenticate users with a cookie session; support several workspaces per user.
- FR2. Authorise every route by permission, per workspace.
- FR3. Connect network accounts via OAuth, store tokens encrypted, refresh them, and surface revoked or expired states.
- FR4. Publish to each network with per-target results, allowing partial success, and never send a post twice.
- FR5. Claim and publish scheduled posts safely under concurrency, and fail posts that miss their time by more than the grace window.
- FR6. Collect analytics, comments, messages and reports on a schedule using only permissions the account granted.
- FR7. Gate publishing behind approvals where required.
- FR8. Generate AI text through the Anthropic API when configured, with per-workspace limits.
- FR9. Fetch link previews without exposing internal network resources.

## 3. Non-functional requirements
- **Security:** encrypted tokens; hashed invitation and reset tokens; rate limits on sign-up, sign-in, reset, invitations, refreshes, previews and AI; SSRF protection; no secrets in logs or responses; permissions enforced server-side.
- **Data integrity:** additive migrations under a named lock (`GET_LOCK`); row locks (`FOR UPDATE`) around claim and edit races; unique constraints on natural keys (for example inbox items per account and external id).
- **Reliability:** background loops catch and log errors and continue; a failed collector run for one account doesn't stop others; publishing records a truthful per-target error.
- **Performance targets (single instance):** typical API requests under 300 ms excluding network calls; publisher batches with a fixed size; list endpoints paginated (cursor for inbox and library).
- **Honesty:** unavailable data is `null` plus a reason, never zero or invented.
- **Accessibility and responsiveness:** keyboard access, labelled controls, works from 390 px to desktop.
- **Observability:** structured pino logs with request ids; no addresses or tokens logged.

## 4. External integrations
| Service | Used for | Needs |
|---|---|---|
| Facebook Graph API | Page publishing, insights, comments, Messenger | App ID/secret; scopes gated by env flags; app review for live use |
| Instagram Login API | Publishing, insights, comments, DMs, tagged media | Instagram app ID/secret; public HTTPS media URLs |
| LinkedIn | Member and organisation posting, article shares | Client ID/secret, `w_member_social`; no statistics API |
| Google / YouTube Data API | Uploads, channel and video stats, comments | OAuth client; upload scope; verification for public use |
| SMTP | Reset, invitations, approver notices, reports | `SMTP_*`, `MAIL_FROM` |
| Anthropic API | AI Studio | `ANTHROPIC_API_KEY` |

## 5. Configuration (environment variables)
Required: `DATABASE_URL`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` (32 random bytes, base64; losing it makes stored tokens unreadable), `OAUTH_REDIRECT_BASE_URL`, `PORT`.

Per network: `FACEBOOK_APP_ID/SECRET` (optional `FACEBOOK_LOGIN_CONFIG_ID`, `FACEBOOK_GRAPH_API_VERSION`), `INSTAGRAM_APP_ID/SECRET`, `LINKEDIN_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`.

Optional: `SMTP_HOST/PORT/SECURE/USER/PASS`, `MAIL_FROM`, `MAIL_TRANSPORT=log`, `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_DAILY_LIMIT`, `COMMENT_SCOPES_ENABLED`, `ANALYTICS_SCOPES_ENABLED`, `MESSAGING_SCOPES_ENABLED`, `ANALYTICS_POLL_HOURS`, `INBOX_POLL_MINUTES`, `REPORTS_POLL_MINUTES`, `*_DISABLED`, several `*_RATE_LIMIT` values, `YOUTUBE_DEFAULT_PRIVACY`, `LOG_LEVEL`. See `.env.example`.

## 6. Data requirements
- All rows belong to a workspace (directly or through a parent) and are deleted with it (cascade).
- Time is stored as UTC `timestamptz`; schedules carry an IANA time zone.
- Uploaded media is stored on disk with a storage key and served through signed public URLs.
- Metrics are snapshots over time so trends and comparisons can be computed.

## 7. Testing requirements
- Every route has tests for success, validation, permissions and workspace isolation.
- External calls are faked; nothing in tests reaches a real network.
- Tests run only against `socialflow_test`; migrations are applied in global setup.
- UI behaviour is checked with browser scripts at desktop and 390 px in both themes.
- Definition of done: typecheck clean, API tests green, frontend build passes, relevant browser suite passes.

## 8. Limits and assumptions
- Single API instance. Multiple instances would work for publishing (row-locked claims) but rate limiting is in-memory per process, and media on local disk would need shared storage.
- Instagram content publishing needs the media to be reachable over public HTTPS.
- Meta enforces a 24-hour standard messaging window; replies outside it are refused by the app.
- LinkedIn statistics are not available to this app.

## 9. Risks
- Network app approvals are outside our control and gate real-world use.
- Some network call shapes are implemented from documentation and not yet exercised live (Facebook insights and messaging, YouTube comments).
- LinkedIn article shares (link cards): a real thumbnail image can only be set through LinkedIn's newer versioned Posts + Images APIs, which need `LINKEDIN_API_VERSION` configured. Without it, the app falls back to the older UGC Posts API, which has no field for a client-supplied image — LinkedIn crawls the link itself and fills the card in afterwards, sometimes with a short delay, and can render it smaller on personal profiles or on its mobile app than on Company Pages or desktop.
- Losing `TOKEN_ENCRYPTION_KEY` or the database without backups is unrecoverable for connected accounts.
