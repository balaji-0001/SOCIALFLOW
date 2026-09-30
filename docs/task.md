# Tasks

Status of the work. Update it as things change.

## Done
- [x] Accounts: Facebook Pages, Instagram, LinkedIn, YouTube (OAuth, token encryption, reconnect states)
- [x] Composer: per-network text, media upload (image and video), emoji, hashtags, mention groups, UTM, tags, custom fields, first comment, network checks, previews
- [x] Scheduling: drafts, schedule, queues (with quick-start times), recurring posts, calendar, Manage Posts, publisher with missed-post handling
- [x] YouTube video upload
- [x] Password reset by email (SMTP)
- [x] Aurora dark redesign, light/dark/match-device toggle, marketing page
- [x] Team: roles, invitations, member management, workspace switcher, audit log
- [x] Analytics: snapshot collector, KPIs with comparison, per-platform, top posts, honest unavailable states
- [x] Approvals: settings, request/approve/reject/request changes, comments, publish gate, approver email
- [x] Inbox: comments (Facebook, Instagram, YouTube), reply, resolve, assign; DMs and mentions with 24-hour window handling
- [x] AI Studio: generate tasks, brand voices, daily limit, composer "AI assist"
- [x] Content library: captions, templates, snippets, media; folders, favourites; composer picker including media
- [x] Reports: PDF export and scheduled emailed reports
- [x] Link previews: pasted links become cards; Facebook and LinkedIn publish as link posts
- [x] Tests: 362 API tests, browser suites for composer, media, publishing, Aurora, theme, phase 1, and the newer pages

## Needs your action (external)
- [ ] Set `ANTHROPIC_API_KEY` to turn on AI Studio.
- [ ] Turn on `COMMENT_SCOPES_ENABLED`, `ANALYTICS_SCOPES_ENABLED` and `MESSAGING_SCOPES_ENABLED` once the matching permissions are enabled on each network's app; then reconnect accounts.
- [ ] Meta app review (comments, insights, messaging), LinkedIn products, Google verification for YouTube, needed before non-tester users can use these features.
- [ ] Add each new tunnel URL as a redirect URI in every network's developer console.

## Next
- [ ] Chrome extension to share a page, selection or image into the composer (composer prefill from query parameters + `extension/` folder).
- [ ] Deployment setup: Dockerfile, environment checklist, managed Postgres, persistent or S3 media storage, backups.
- [ ] Verify Facebook and LinkedIn link cards against the real networks. LinkedIn only shows a real, client-set thumbnail when `LINKEDIN_API_VERSION` is set (see `.env`); without it, LinkedIn's own crawl fills the card in, sometimes with a delay.
- [ ] Recurring posts carry their link.
- [ ] Instagram @mentions in other people's captions and comments (needs a Meta webhook).
- [ ] Notifications (bell is a placeholder).
- [ ] Billing, plans and seat limits.
- [ ] White labelling and client portals.
- [ ] More networks: X, TikTok, Pinterest, Threads, Google Business Profile.
- [ ] Load testing, monitoring and abuse controls before a public launch.
- [ ] Fix a flaky browser check in the phase-1 suite ("settings shows the tag" sometimes fails on timing).
- [ ] Docs cleanup: fold `docs/team-inbox-approvals-ai-library.md` into feature docs when stable.

## Known limits
- Scheduled posts and all collectors only run while the API process is running.
- Built-in PDF fonts cover Latin-1 only; other scripts print as "?".
- Facebook builds link cards from the site's own Open Graph tags; custom title or image overrides don't apply there.
- LinkedIn provides no post statistics to this app (partner-only).
