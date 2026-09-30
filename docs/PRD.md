# SocialFlow Manager: Product Requirements (PRD)

## 1. Product summary
SocialFlow Manager is a web app for planning, publishing and measuring social media posts across several networks from one workspace. It is built for small teams, agencies and creators who today juggle each network's own tools. It is comparable in scope to tools such as SocialPilot, at a smaller size.

## 2. Goals
- Let a team connect its real social accounts and publish to them reliably, on a schedule.
- Keep everyone on the same page: roles, approvals, a shared content library and an inbox.
- Show real numbers from the networks, and say plainly when a network can't provide something.
- Be honest by design: no sample data, no invented metrics, clear "not available, and why" states.

## 3. Non-goals (today)
- Billing, plans and seat limits.
- White labelling and client-facing portals.
- Networks other than Facebook Pages, Instagram, LinkedIn and YouTube (X, TikTok, Pinterest, Threads and Google Business Profile are not built).
- A mobile app.
- AI image generation.

## 4. Users and roles
| Role | Can do |
|---|---|
| Owner | Everything, including managing the team. One per workspace. |
| Admin | Everything except owning the workspace: connect accounts, manage people, publish. |
| Editor | Create, edit, schedule and publish posts; manage queues, tags, media, library, reports; reply in the inbox; use AI. |
| Approver | Read everything; approve or reject posts sent for approval. |
| Viewer | Read-only. |

A person can belong to several workspaces and switch between them.

## 5. Features and requirements

### 5.1 Accounts
- Connect Facebook Pages, Instagram (Instagram Login), LinkedIn and YouTube through each network's OAuth.
- Show each account's status and when it was last verified; prompt to reconnect when a token expires or is revoked.
- Tokens are stored encrypted and never shown.

### 5.2 Publishing
- Composer with shared text plus optional per-network text, media upload (images and video), emoji, hashtags, mention groups, UTM tagging, tags, custom fields and a first comment.
- Link preview: pasting a link shows a card (image, title, description). Facebook Pages and LinkedIn publish it as a link post, so clicking the card opens the site. Instagram can't hold a clickable link, so a link post with no photo or video attached uses the link's preview picture as the post's photo instead: the picture is downloaded, converted to a JPEG within Instagram's size and shape limits, stored as media in the workspace, and published from there (the caption is unchanged). YouTube ignores the link.
- Save as draft, schedule, add to a queue, or publish now.
- Calendar (month, week, day, list), Manage Posts, Drafts.
- Queues: weekly posting times per account; "Add to queue" takes the next free time.
- Recurring posts.
- Per-network checks before scheduling (character limits, media rules).
- Scheduled posts are sent automatically while the server is running; missed posts are failed rather than sent late.

### 5.3 Team
- Email invitations (single-use link, 7-day expiry), role changes, removing members, leaving a workspace.
- Workspace switcher and an activity (audit) log.

### 5.4 Approvals
- Owner or admin can require approval before publishing.
- An editor sends a post for approval; an approver approves, rejects or requests changes, with comments.
- Requesters can't approve their own request. Editing an approved post sends it back to pending. Unapproved posts are not published.
- Approvers are emailed when a request arrives.

### 5.5 Analytics and reports
- Followers, posts, likes, comments, shares, saves, views, impressions and reach, with comparison to the previous period, per-platform and top posts.
- Only numbers the network actually reports. Missing ones show why (for example, a permission is needed).
- PDF export of the same data and scheduled emailed reports (weekly or monthly).

### 5.6 Inbox
- Comments on published posts from Facebook Pages, Instagram and YouTube, with reply, resolve, assign and read state.
- Direct messages (Facebook, Instagram) with Meta's 24-hour reply window respected, and mentions where the API allows.

### 5.7 Content library
- Captions, templates with `{{placeholders}}`, snippets and saved media; folders, favourites and labels; insert from the composer, including media.

### 5.8 AI Studio
- Caption, rewrite, shorten, expand, hashtags, variations, repurpose and first-comment ideas, with brand voices and a daily per-workspace limit. Requires an Anthropic API key on the server; without one the page says it isn't configured.

### 5.9 Account and settings
- Sign up and sign in, password reset by email, light/dark/match-device theme, settings and help.

## 6. Success measures
- A scheduled post is published within a minute of its time when the server is up.
- No secret or token ever appears in a response or log.
- Every unavailable metric or feature shows an explanation, never a fake value.
- The API test suite and browser suites stay green.

## 7. Dependencies and constraints
- Each network requires its own app approvals before non-test users can connect (Meta app review, LinkedIn products, Google verification). This is the main external constraint on going public.
- Instagram needs publicly reachable HTTPS media URLs.
- Email (SMTP) is needed for password reset, invitations, approver notices and scheduled reports.

## 8. Open items
See `task.md`.
