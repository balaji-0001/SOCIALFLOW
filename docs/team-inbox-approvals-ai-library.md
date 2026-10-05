# Team, Analytics, Inbox, Approvals, AI Studio, Content Library

All data comes from real sources. Where a network or provider can't supply something the UI says so and why; nothing is sample data.

| Area | Where | Needs |
|---|---|---|
| Team | /team, /accept-invite | Roles owner/admin/editor/approver/viewer, email invitations (SMTP), audit log |
| Analytics | /analytics | Numbers stored from each network. Facebook insights and Instagram insights need `ANALYTICS_SCOPES_ENABLED=true` plus the app permission and a reconnect. LinkedIn exposes no stats (partner-only). |
| Approvals | /approvals | Owner/admin turn on "Require approval before publishing". Posts then wait (scheduler skips them, Publish now returns 409) until an approver approves. Editing an approved post sends it back to pending. Requesters can never approve their own request. |
| Inbox | /inbox | Comments on published posts (Facebook Pages, Instagram, YouTube) with reply, resolve, assign. Needs `COMMENT_SCOPES_ENABLED=true`, the comment permission approved for the app, and reconnecting the account. LinkedIn: no comment API access. |
| AI Studio | /ai, composer "AI assist" | `ANTHROPIC_API_KEY` on the server. Per-workspace daily limit `AI_DAILY_LIMIT`. Brand voices are per workspace. Over-limit text is flagged, never truncated. |
| Content Library | /library, composer library button | Captions, templates (`{{placeholders}}`), snippets, saved media; folders, favourites, labels. Deleting a library entry never deletes an upload used by a post. |

Permissions live in `backend/api-server/src/lib/permissions.ts` (one table). Migrations `0009`-`0014` are additive and run at API start.

Not built: PDF/scheduled reports, direct messages/mentions in the inbox, approval email to approvers on new requests, AI image generation.
