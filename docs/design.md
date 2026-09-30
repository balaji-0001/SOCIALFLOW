# Design

Short guide to how SocialFlow looks and behaves. The full token and component reference is in `design-system.md`.

## Principles
- **Calm and honest.** Dense information without noise; states explain themselves ("No comments yet. Connect an account first").
- **One rhythm.** Every page uses the same header, spacing and card treatment.
- **Both themes.** The default is the dark "Aurora" look; light and "match device" are available from the toggle in the top bar, stored in `localStorage` as `socialflow:theme`.
- **Accessible by default.** Visible focus, labelled controls, sensible tab order, `prefers-reduced-motion` respected.

## Theming
- `html[data-theme='aurora' | 'light']` is set by an inline script in `index.html` before first paint, then by `applyTheme()`.
- Tokens are defined in `index.css` (light) and overridden in `aurora.css` and `aurora-landing.css`.
- Components use `hsl(var(--token))` only. Common tokens: `--background`, `--surface`, `--surface-2/3`, `--foreground`, `--muted-foreground`, `--border`, `--primary`, `--success`, `--warning`, `--error`.

## Layout
- **Shell:** collapsible left sidebar (workspace switcher, Create Post, grouped navigation: Publish, Grow, Workspace, Help), top bar (title, global search, theme toggle, notifications, account menu). On phones a bottom bar with a central Create button and a "More" sheet.
- **Pages** sit in `.sfa-page` (max width 1240 px, `PageHeader` with title and description, then content in cards).
- **Composer** is a three-column dialog: content, preview and checks, accounts and scheduling. It collapses to one column on tablet and phone.

## Components (from `app/ui.tsx` and friends)
Button (primary, secondary, outline, ghost), IconButton, PageHeader, EmptyState, ErrorState, Skeleton, status pills, tag chips, segmented control, dialogs (Radix), toast, confirm dialog, tooltip and dropdown menus.

## Patterns
- **Empty state:** icon, one-line title, one-sentence explanation and, where it helps, quick actions (for example, the Queue page's starting-point buttons).
- **Unavailable state:** always names the reason and the next step (permission needed, reconnect, not supported by the network).
- **Destructive actions** ask for confirmation and say what happens to related data.
- **Unsaved changes** are called out inline with a Save button beside the message.
- **Numbers:** tabular numerals; changes vs the previous period shown with a direction and value; nulls shown as "not reported", never zero.

## Responsive rules
- Test widths: 1440, 1024, 768 and 390.
- No horizontal page scroll; wide tables scroll inside their own wrapper.
- Touch targets at least 40 px on phones.

## Brand
- Name: SocialFlow. Wordmark with a paper-plane mark. Primary colour is violet in dark and blue in light; supporting cyan and coral accents on the marketing site.

## Visual QA
Browser scripts capture screenshots in both themes and at 390 px (see `implementation.md` for how to run them).
