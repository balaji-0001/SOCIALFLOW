# Advanced publishing (Phase 1)

What the composer, queue, recurring posts and post organisation do, where the code lives, and what is honestly not covered.

## Migrations

`backend/db/src/migrations.ts` holds numbered SQL migrations; `runMigrations()` (`backend/db/src/migrate.ts`) applies pending ones at API start and before the test suite (`backend/api-server/src/test/global-setup.ts`). Applied names are recorded in `socialflow_migrations`. Migrations are additive only. The Drizzle schema files describe the same tables for the ORM.

## Per-network content

- Table `socialflow_post_platform_content (post_id, platform, content)`. No row = the base `posts.content` is sent.
- API: `platformContent: { facebook?, instagram?, linkedin?, youtube? }` on create/update/read. Empty strings are dropped. Each version is checked against its network's character limit; scheduling requires text (base or own) for every selected network.
- Publisher (`lib/publisher.ts`) resolves `effectiveContent()` per target; the recurrence template carries the same map.
- Composer: "Customize per network" → one tab per selected network. Counters, checks and previews use each network's effective text.

## Posting queues

- Tables `socialflow_account_queues` (time zone, paused) and `socialflow_queue_slots` (weekday 0–6, minute of day). Up to 70 slots per account.
- `POST /posts` or `PATCH /posts/:id` with `queue: true` picks the next free slot. A "free" slot is one no scheduled/publishing post targeting that account already occupies. For several accounts, the earliest free slot among their queues is used, so the post goes to all of them at one time. Eight-week look-ahead.
- `GET/PUT /queues/:accountId`, `GET /queues`, `GET /queues/:accountId/posts`, `POST /queues/:accountId/reorder` (posts keep the same set of times, handed out in the new order). Removing from the queue = set `scheduledAt: null` (back to draft).
- Code: `lib/queue.ts`, `lib/time.ts` (Intl-based zone conversion, DST-safe), `routes/queues.ts`, UI `app/queue-page.tsx`.

## Recurring posts

- Table `socialflow_recurrences`: rule (daily/weekly/monthly, interval, weekdays, day of month, time, time zone, start/end date, max occurrences) plus the template (content, per-network content, first comment, accounts, media, tags).
- Every occurrence is an ordinary post (`posts.recurrence_id`, `posts.occurrence_index`). The publisher cycle's materializer creates occurrences due within the next 7 days; a unique index on `(recurrence_id, occurrence_index)` makes duplicates impossible even with concurrent servers. Occurrences more than an hour in the past (server was down) are created as failed, matching missed-post handling.
- Pausing removes unsent occurrences; resuming (or editing) recreates them from the current template. Deleting keeps published occurrences as history.
- Monthly day 29–31 falls back to the month's last day. Weekly interval counts weeks from the start date's week.
- API: `GET/POST /recurrences`, `POST /recurrences/preview`, `GET/PATCH/DELETE /recurrences/:id` (`PATCH { paused }` alone toggles pause). Composer "Repeat" section creates one; the Recurring page lists, edits, pauses and deletes.
- Code: `lib/recurrence.ts`, `routes/recurrences.ts`, `app/recurring-page.tsx`, `app/composer-extras.tsx`.

## First comment

- `posts.first_comment`; per target `first_comment_status` (published | failed | unsupported), `first_comment_error`, `first_comment_external_id`.
- Posted right after the post succeeds; a failed comment never fails the post.
- Network support and the permission each needs (accounts connected before this feature lack it and show "Reconnect to grant"):

| Network | API | Permission |
| --- | --- | --- |
| Facebook Page | `POST /{post-id}/comments` | `pages_manage_engagement` (requested only when `COMMENT_SCOPES_ENABLED=true`) |
| Instagram | `POST /{media-id}/comments` | `instagram_business_manage_comments` (same switch) |
| LinkedIn | `POST /v2/socialActions/{urn}/comments` | `w_member_social` (already granted) |
| YouTube | `commentThreads.insert` | `youtube.force-ssl` (same switch) |

Sign-in requests do **not** ask for these permissions by default, so the connect flows are unchanged. To enable first comments: add each permission to its developer app (Meta: App Review / Permissions and features; Google: Data Access scopes), set `COMMENT_SCOPES_ENABLED=true`, restart, then reconnect the accounts. Until then the composer shows "needs a permission" and a post with a first comment still publishes, with the comment reported as failed.

`GET /connections` returns `firstComment: supported | needs_permission | unsupported` per account; the composer shows it next to the field. None of the four has been exercised against the live network yet.

## Tags, custom fields, mention groups

- `socialflow_tags` + `socialflow_post_tags`; `GET /posts?tag=<id>` filters; `?q=` searches base and per-network text. Composer creates tags inline; Settings → Tags manages them.
- `socialflow_custom_fields` (text | number | date | select | url, options, required, position) + `socialflow_post_custom_values`. Values are validated by type; `required` is enforced only when scheduling or publishing, never for drafts.
- `socialflow_mention_groups` (name, handles). The composer's @ tool inserts the handles as text; whether a handle links to a profile is up to the network (no network's API accepts text mentions from third-party apps without extra IDs).
- Routes: `routes/organize.ts`. UI: `app/settings-page.tsx`.

## Not built / limits

- Queue slots are weekly patterns only (no one-off exceptions or per-day pause).
- Recurrences don't skip a specific occurrence; delete that occurrence's post instead.
- A recurrence's media is shared by its occurrences; removing a file from one occurrence doesn't remove it from the rule.
- Custom fields are per post; no per-network fields.
