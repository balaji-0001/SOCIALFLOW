# Create Post composer

The composer (`frontend/socialflow/src/app/composer.tsx`, with `composer-parts.tsx`, `composer-utils.ts`, `composer.css`) is a single dialog for writing, previewing, scheduling, publishing and saving posts. Everything it does is backed by a real API or by real text operations on what you type. Nothing is mocked.

## What it does today

| Area | Behavior |
|---|---|
| Accounts | Multi-select across every connected account, with Select all / Clear. Accounts that need reconnecting are shown but can't be picked. |
| Editor | Plain text. Live character count against the strictest selected network. |
| Emoji | Picker (built in, no dependency) that inserts at the cursor. |
| Hashtags | Inserts a cleaned `#tag` at the cursor. Suggests the hashtags you have actually used in your own earlier posts, most used first. Detected hashtags are listed under the editor. |
| UTM tracking | Adds or replaces `utm_source/medium/campaign/term/content` on every link in the text, keeping other query parameters. Shows the resulting URL before applying. |
| Links | Links in the text are detected and listed by domain. The composer does **not** fetch a page preview; the network builds its own preview when the post is published. |
| Previews | Live Facebook, LinkedIn, Instagram and YouTube previews driven by your text and the real account name/avatar. They show the first attached image or video (with a "+N" count); Instagram and YouTube show the "media required" state until something is attached. Previews are approximate. |
| Network checks | Per-network character meter and rules: over-limit error, near-limit warning, media required, Instagram 30-hashtag limit, account needs reconnecting. |
| Schedule | Date/time pickers with quick slots (in an hour, tomorrow 9:00, next Monday 9:00). |
| Actions | Save as draft, Schedule post, Publish now (asks for confirmation), Retry failed accounts, Delete. |
| Autosave | An unsent **new** post is autosaved to this browser only (localStorage, per signed-in user) and offered back on the next open. It is never written to the server and is cleared when you save, schedule, publish or discard. Posts you are editing are not autosaved. |
| Keyboard | `Ctrl/Cmd+Enter` schedules, `Ctrl/Cmd+S` saves a draft, `Esc` closes. |
| Layout | Two columns on desktop, stacked on tablet, a bottom sheet on phones. |

## Not available yet (intentionally not faked)

These need backend work that doesn't exist, so the composer shows an honest "not available" state or omits the control:

- Per-network text, first comment, tags, custom fields, mention groups, Add to queue and Repeat are documented in `docs/publishing-features.md`.
- **Media editing (crop, trim, filters).** Images and video are published to Facebook Pages, Instagram, LinkedIn and YouTube (one video per post); see `docs/media.md` for per-network rules.
- **Link preview fetching / editing.** Would need a server endpoint that fetches arbitrary URLs. That must be built with SSRF protection (block private/loopback addresses, limit redirects, size and time) before it exists.
- **AI writing, rewrite and hashtag suggestions.** No AI provider is configured in this project.
- **Canva integration.** No Canva integration exists.
- **Post tags.** There is no tags field in the database or API.
- **Platform-specific text.** A post has one body shared by all its accounts; per-network overrides would need a schema change.
- **Autosave to the server.** Drafts are saved with an explicit action. Silent server-side drafts would create clutter, so autosave is local.
