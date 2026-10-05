# SocialFlow Aurora (design system)

The signed-in app and the sign-in pages use a dark theme called Aurora. The marketing page keeps the light theme.

## How it is applied
- `frontend/socialflow/src/aurora.css` overrides the design tokens (`index.css` `:root`) under `html[data-theme='aurora']`, then adds the few rules tokens can't express (glass surfaces, hairline borders, gradient primary buttons, the two soft background lights).
- The router (`App.tsx`) sets `document.documentElement.dataset.theme` to `aurora` on every route except `/`. Setting it on `<html>` means Radix portals (dialogs, popovers, menus, toasts) get the theme too.
- Every component reads tokens (`hsl(var(--surface))`, `--border`, `--primary`, ...), so a new component is themed by using them. No colours are hard-coded except platform brand colours and status hues.

## Tokens
- Surfaces: `--background` near-black, `--surface`, `--surface-2`, `--surface-3` in steps; borders are 1px, low opacity (`hsl(0 0% 100% / .07)` on glass).
- Accent: violet/indigo `--primary` for actions; cyan `--accent` only for eyebrows and interactive detail. Gradients appear on the primary button, the active nav item, the quick-create card and the sign-in panel, nowhere else.
- Type: Geist (fallback Inter), `--text-*` scale, tabular numbers via `.sfa-num`.
- Depth: `--shadow-xs/sm/md/lg` (dark, with a hairline top light), `--glass` and `--glass-strong` translucent surfaces with backdrop blur.
- Motion: `--dur-1/2/3` and `--ease-out`; page enter (`sfa-enter`), sheet and dialog transitions, sidebar width transition. All animation is disabled under `prefers-reduced-motion`.

## Layout
- Shell (`app/AppShell.tsx`, `shell.css`): collapsible sidebar (remembered in localStorage, tooltips when collapsed), workspace selector, grouped navigation, top bar with breadcrumb, global search (`app/search.tsx`; `/` or Ctrl+K), user menu; on phones a bottom bar plus a "More" sheet.
- Composer (`composer.tsx`, `composer.css`): three columns (write / preview and checks / accounts, schedule, repeat, first comment); two columns under 1240px; one column under 900px.
- Dashboard (`posts-pages.tsx`, `dashboard.css`): bento grid built from real data only.

## Honesty rules
- Areas that are not built (Content Library, Analytics, Inbox, Approvals, AI Studio, Team) open `app/soon-pages.tsx`: what it will do, what exists today, what it needs. They show no sample data. The nav marks them "Soon".
- The bell in the top bar is inert and says so; there is no notification centre yet.
- The workspace selector lists the one workspace; switching arrives with team support.
- The dashboard "Insights" card says analytics and AI are not connected.

## Adding to it
Use `Button`, `IconButton`, `PageHeader`, `EmptyState`, `ErrorState`, `Skeleton` from `app/ui.tsx`, the `sfa-card` surface, and tokens. Give interactive elements a `data-testid`.
