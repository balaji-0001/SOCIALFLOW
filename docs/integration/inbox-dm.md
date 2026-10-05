# Inbox: direct messages and mentions

## Register (integrator)

- Migration: `0015_inbox_messages_mentions` on PostgreSQL; since the move to MySQL these columns are part of `lib/db/src/baseline.ts`. It was additive: new nullable/defaulted columns on `socialflow_inbox_items` (`kind` default `comment` with a check, `thread_id`, `participant_id`, `from_page` default false, `permalink`) and on `socialflow_inbox_sync` (`messages_error`, `mentions_error`, `messages_synced_at`, `mentions_synced_at`), plus two indexes. Existing rows become `kind='comment'`.
- Schema (`lib/db/src/schema/inbox.ts`) is already updated and exported through the existing `export * from "./inbox"`.
- No router change: the routes are in the existing `routes/inbox.ts`. No new startup hook: the existing collector (`startInbox`) reads messages and mentions.
- Permissions: unchanged (`inbox:read`, `inbox:reply`, `inbox:manage`).
- OpenAPI: `lib/api-spec/openapi.yaml` is edited (inbox parts only). Run `pnpm --filter @workspace/api-spec run codegen` after registering.
- Add to `.env.example`: `MESSAGING_SCOPES_ENABLED=false`.

## Env flag and scopes

`MESSAGING_SCOPES_ENABLED=true` turns on, together: requesting the messaging scopes at sign-in, collecting messages, collecting mentions. Off, sign-in requests, the collector and every existing response are as before.

Scopes added (only when the flag is on):

- Facebook: `pages_messaging`, `pages_manage_metadata` (`FACEBOOK_MESSAGING_SCOPES`)
- Instagram: `instagram_business_manage_messages` (`INSTAGRAM_MESSAGING_SCOPE`)
- YouTube, LinkedIn: none (no API).

Both Meta scopes need Meta app review. Accounts must be reconnected after the flag is on.

## What each network offers

| | Messages | Mentions |
|---|---|---|
| Facebook Page | `GET /{page-id}/conversations?fields=participants,updated_time,messages.limit(25){id,message,from,created_time}`; reply `POST /{page-id}/messages` (`messaging_type=RESPONSE`) | `GET /{page-id}/tagged` (posts the Page is tagged in; `pages_read_engagement`, already granted). Answered as a Page comment under the tagged post (`pages_manage_engagement`). |
| Instagram | `GET graph.instagram.com/me/conversations?platform=instagram`, then `GET /{conversation-id}?fields=participants,messages{...}`; reply `POST /me/messages` | `GET /me/tags` (media the account is **tagged** in; `instagram_business_basic`, already granted). |
| YouTube | Unavailable: no DM API | Unavailable: no mentions API |
| LinkedIn | Unavailable | Unavailable |

Limits, stated honestly:

- Meta's standard messaging window: a reply is allowed only within 24 hours of the person's last message. `canReply` and `replyWindowEndsAt` are computed from the last inbound message; after that `POST /inbox/{id}/reply` returns 409 `window_closed` and nothing is sent. No message tags or human-agent extensions are used.
- Instagram `/me/tags` returns tagged media only. It does NOT return @mentions written in other people's captions or comments (Meta delivers those only by webhook, which this app doesn't receive), so those are not shown. Nothing is inferred or invented.
- Instagram mentions can't be answered from here (the API doesn't let you comment on posts you're tagged in): reply returns 409 `unavailable` with the reason.
- Attachment-only messages (images, stickers) have no text and are skipped.
- Caps per account per pass: 20 conversations, 25 messages per conversation, 25 mentions; only the last 30 days are kept. Upsert by the network's message/post ID.
- Live Graph calls are tested against faked responses only.

## Behaviour

- Messages are stored one row per message (`kind='message'`, grouped by `thread_id`); the account's own messages are stored (`from_page=true`) so the thread is complete, but are never inbox work.
- `GET /inbox?kind=comment|message|mention` (default all): one row per conversation (its latest message from the other person), with `kind`, `threadId`, `permalink`, `canReply`, `replyWindowEndsAt`, `replyBlockedReason`.
- `PATCH /inbox/{id}` on a message applies read/status/assignment to the whole conversation. A new inbound message shows the conversation as open again in the list (the latest row is the one shown).
- `GET /inbox/threads/{threadId}[?accountId=]`: ordered messages plus `canReply` / `replyWindowEndsAt`.
- `GET /inbox/summary`: adds `kinds` (open/unread per kind) and per account `messaging` (`state`: available / permission_needed / unavailable / reconnect, `reason`, `replyWindowHours`) and `mentions` (`state`, `reason`, `canReply`, `replyNote`).
- `POST /inbox/{id}/reply`: messages max 2000 (Facebook) / 1000 (Instagram) characters; 409 error codes: `permission_needed`, `unavailable`, `reconnect`, `window_closed`.
- `POST /inbox/refresh` results add `newMessages`, `newMentions`, `messagesReason`, `mentionsReason` only when the flag is on.

## Tests

`src/routes/inbox-dm.test.ts` (adapters against faked Graph responses, window inside/outside 24h, gating states, filters, workspace isolation, reply success/failure). It needs migration 0015 to be registered (global setup applies it).
