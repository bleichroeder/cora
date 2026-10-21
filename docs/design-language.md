# Cora's design language

Set on 2026-10-15 with the left nav (`packages/client/src/components/nav.css`). Every part of the UI is brought into it chunk by chunk, each prototyped first.

## Principles

- **Calm.** Colour means something or it isn't there. One signal per fact: a session's state is its tile's
  corner, not a dot *and* a border *and* a badge.
- **Rows, not cards.** Lists are rows of one fixed height, with no box: a soft highlight on hover and on the
  selected one. Boxes are for things you act on (buttons, cards that ask you something).
- **Things never move on their own.** Order is yours; state shows in place.
- **Alignment and rhythm.** A 4px grid; 12px gutters; equal space either side of a divider. Columns of meta
  line up all the way down a list.
- **Less, findable.** Show what you look at; the rest is a hover, a click or the detail view away.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--nav` | `#0b0e14` | panel background |
| `--raise` / `--raise2` | `#11151d` / `#161b25` | buttons, selected rows, cards; hover |
| `--hair` / `--hair2` | slate at 9% / 14% | hairlines and inset 1px outlines (no solid borders) |
| `--ink` … `--ink4` | `#e6ebf2` `#a4afbf` `#6b7686` `#465061` | text: primary, secondary, tertiary, labels |
| `--work` | `#3ddc97` | working, passed, the primary action |
| `--need` | `#ff6b6b` | needs you, failed |
| `--cora` | `#2dd4bf` | Cora's things |
| `--run` | `#60a5fa` | running, in progress, drop targets |

## Type

- **Figtree** (bundled, `@fontsource-variable/figtree`) for words: 13px/500 names, 12.5px body and buttons.
- **JetBrains Mono** (bundled) for paths, keys, numbers and labels: 10–10.5px.
- **Section labels:** mono 10px, weight 600, uppercase, letter-spacing .16em, `--ink4`, then a count in `--ink3`
  and a hairline rule to the edge.

## Components

- **Button:** 30px high, 8px radius, `--raise` with an inset hairline; primary is tinted `--work`.
- **Row:** 46px; 28px leading tile (8px radius, the item's colour at 16% with a 35% inset outline, its initial);
  state on the tile's corner (10px dot ringed in the background colour); two lines: name (Figtree 13/500) and
  context (mono 10.5, `--ink4`) with right-aligned meta.
- **Status glyphs:** one per fact: a spinning ring (running), a filled dot with a soft halo (passed or failed).
- **Panels:** `--raise` with an inset hairline, 14px radius for large ones; 12px inside padding.

## Chunks

1. Left nav: **done** (2026-10-15).
2. Scene header: **done** (2026-10-15).
3. Right panel (tabs, transcript, explains, changes): **done** (2026-10-15).
4. Terminal and composer: **done** (2026-10-15).
5. Timeline strip: **done** (2026-10-15).
6. Cora's console and command mode: **done** (2026-10-15).
7. Modals: New session, Resume, the palette, End session: **done** (2026-10-15).
8. Settings: **done** (2026-10-15).
9. Overview (grid and galaxy, and its top strip): **done** (2026-10-15).
10. Tools drawer and the built-in browser: **done** (2026-10-16).
11. Toasts, Needs-you cards and notifications: **done** (2026-10-16).
12. The session scene's labels (the 3D is unchanged): **done** (2026-10-16).
13. The explain Viewer and the diff review: **done** (2026-10-16).
14. Menus and popovers: the session menu, Jira and pipeline cards, Slack drafts, push-to-talk, the empty state: **done** (2026-10-16).
15. The splash (its 3D unchanged), and what it says while Cora starts: **done** (2026-10-16).
16. Cora's Inbox (the row under Cora's card, the view; brand logos for Jira, Slack, Gmail, GitLab): **done** (2026-10-19).
17. First-run setup and Settings › Setup (with each feature page's status banner): **done** (2026-10-19).
