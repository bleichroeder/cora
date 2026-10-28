# Changelog

What changed in each release. Cora updates itself; each update's notes are on its release page too.

## Unreleased

## 0.1.16

- **A video's Send in Slack works.** It said "Bad Request"; so did deleting a video, and deleting, leaving or wrapping
  up a project.

## 0.1.15

- **Debrief videos: pick the voice model.** The video maker (and Settings) choose which ElevenLabs model voices it.
  The best one, v4, is the default: videos aren't live, so quality comes first.
- **The title card's orb moves.** It's recorded moving and looped under the push-in, instead of one still picture.

## 0.1.14

- **Cora recovers when its terminal host goes away.** The host (it keeps your sessions running across Cora restarts)
  could die while Cora kept running; after that, every session and Cora's own agent started into nothing: Cora stuck
  on "Waking up", new sessions vanishing. Cora now starts a new host by itself, and anything launched meanwhile runs
  there. If none can start, the launch says why instead of nothing.
- Cora's agent stopping is logged with its last words on screen.

## 0.1.13

- **Cora's first start in a new folder can say yes.** Claude Code's "trust this folder?" has options without numbers
  and "No, exit" highlighted, so Cora's conversation only offered Enter and Esc. It now has **Yes, trust this folder**,
  and ↑/↓ for any other choice without numbers.

## 0.1.12

- **Debrief videos.** 🎬 on a debrief opens **Make a video**: narrated slides of the walkthrough, in your Cora's look
  (a ferrofluid orb on the title card, each step's code with its lines lit).
  - Leave steps out, drag them into another order, change what each one says, with a live preview.
  - Pick the voice (hear a sample), its pace, the title card's words, size, code, subtitles, and your colour or the
    session's.
  - Watch it in a popup or the Videos panel; save it, send it in Slack, or let it go after a day (or an hour, or a
    week). The first video offers to download ffmpeg if you haven't got it.
- **Voice mutes, one job each:** a session's speaker mutes that session; the speaker by Sessions in the nav mutes every
  session; Cora's card has its own, for Cora.
- **Board layouts:** every work page has the Spotlight; Coding and Reviewing are led by the IDE (a debrief plays
  there); a new session's board is the Spotlight full height.
- **Cora's alerts about sessions are accurate:** no more old failures replayed after a restart, no "ended mid-turn" for
  sessions that were simply idle, one root failure isn't counted three times, and "stuck" is said once. Cora can mute a
  session's alerts when you ask.
- **Restarts are lighter:** transcripts aren't stored again each time Cora starts, and very large transcripts read
  reliably.
- **Faster and leaner:** a session's history loads far faster, the window re-renders much less, orbs pause when they
  can't be seen, and several small memory leaks are fixed.
- **Fixes:** a "queued" message that never went away; asking to use a secret now says what it's for, not its name.

## 0.1.11

- **Cora's Slack banner.** A message Cora sends for you opens with an animated banner: your orb in your Cora colour,
  "CORA · your assistant", and the message's ticket (else its first line), with the message quoted beneath so the two
  read as one column, and your sign-off line at the end. The desktop app makes it out of sight as you get the draft.
  - It says only what its readers should see: never a session's automatic name or Cora's own folders.
  - "Cora banner" on the confirm card (on by default); ask in chat for a plain message and it goes without.
- **Laid-out Slack messages.** A structured message (a report, a rundown, release notes) goes out in Slack's own
  blocks: a header, dividers, a grid of facts, small grey notes. Ordinary messages stay plain.
- **Send shows it's working:** the Slack and mail cards' Send button spins and says "Sending…".
- **Projects:** "Shade its sessions" is a switch: while it's on, sessions that join get their shade, and a new colour
  reshades them all.
- **Phones:** the nav makes room for your sessions (Cora's card a slim row, Tools one row of icons).

## 0.1.10

- **Project board:** its header moves the window again, and its buttons no longer sit under the window's own (minimise, maximise, close).

## 0.1.9

- **Projects.** Group sessions that belong to one piece of work: a Projects section in the nav, each project's own
  board (its sessions' orbs together in a Constellation, Members, a Thread, Brief & decisions, Across repos,
  Activity, and any session panel pointed at one member or all of them), Resume all and Wrap up. Name, colour, order
  and archive from the nav; "Shade its sessions" gives each member a shade of the project's colour.
  - Coordination is opt-in per project: each session hears nothing, the brief and decisions, or everything on its next
    turn; it may post only if you let it, and a handoff wakes an idle session only after you say yes.
- **Go live: share your Cora with a teammate.** A link anyone can open in a browser (through Tailscale Funnel, to a
  guests-only door; only that share is public), or your tailnet only. They see your sessions with your look, follow
  your view, and you see each other's pointers.
  - View, Interactive (they prompt sessions; their answers to a session's prompts wait for yours) or Drive.
  - Follow only: guests stay on your view, and a click of theirs pulses on your screen where they pointed.
  - Your Inbox, Notes, Slack and mail and Cora's console stay private unless you open them; Settings and Secrets never.
- **Your Cora from your other devices.** Cora on your tailnet (Settings › Devices): pair an iPad or a laptop by QR code
  or a 6-digit code; Cora is in use on one device at a time, and taking it over asks for your PIN.
  - Your look follows you: layout, boards, tools, colours and what's folded, the same on every device.
- **Made for the iPad (and phones).** Away from the desktop app: a slim rail of your sessions, the session full screen
  with Board · Transcript · Explains · Changes · Browser as tabs, touch sizes, and the full nav as a drawer.
  - The IDE panel works there too: your PC's VS Code, relayed through Cora.
  - A session's Browser, live from your PC: its pages render on your PC with its logins and stream to the tablet, taps
    and typing sent back.
- **Debrief: a walk through the work.** Ask a session for one (Quick or Teach me) and it plays in the IDE panel, step by
  step, lighting the lines it's about with a bubble saying what changed and why, read aloud if you like; listed in
  Changes, linked to the turns it covers.
- **Cora's board and worktrees.** The Overview is a Board of its own, with your sessions grouped by project and every
  worktree of your repos: who's in each, how far it has got, what can go. A session about to edit a checkout another
  session is changing is moved into a fresh worktree first.
- **Cora Secrets.** Tokens and keys kept sealed in Cora that sessions use by name (the command runs with them, and they're
  masked in its output), with your OK on each session's first use and every use logged.
- **Slack:** what Cora sends for you carries a small grey line underneath saying so.
- Also: Resume shows each session's latest recap; a thinking block's notes show in the transcript; new sessions get one
  of your least-used voices; stickers on the Vibes wall can be dragged; the nav's foot says what's wrong in words;
  GitLab and cluster reads pause for a minute (said once) when the PC is short of memory.

## 0.1.8

- **An IDE panel: your own VS Code, in the Board.** + Panel › Tools › IDE runs your installed VS Code (its own web
  interface, served on this PC only) opened at the session's folder: your extensions, the debugger, git, its terminal.
  - It wears Cora: a Cora colour theme in your Cora colour, calmer defaults, and its own extensions and settings
    (your desktop VS Code is untouched).
  - Claude Code's VS Code extension comes in it, and sessions Cora starts connect to it by themselves (`--ide`): their
    edits show as diffs there, and they see your selection and VS Code's problems.
  - Cora and VS Code talk: a Changes row's IDE button (and the diff viewer's Open) shows Claude's change to a file as
    a diff there; lines Claude wrote get a quiet mark; select some code and "Ask the session about this" puts it in
    that session's prompt box; the status bar shows the session working there.
  - It stays as you left it when you switch sessions or Board pages, and full size works too.
- **Each session's own card**, at the top of the right column as a band in its own glow: its orb (Cora's, in the
  session's colour, with all its moves; hold it to talk to the session), its branch, ticket, pipeline, context, model
  and turn around it, what it changed and for how long it's been going under it, and Allow / Deny right there when it
  asks. The Transcript, Explains and Changes tabs and the terminal and composer below it match: the right side reads
  as one piece.
- **Sessions' own voices.** Pick any of your voices on a session's card, or have new sessions each given one from a
  set you choose (Settings › Voice).
- **Cora's orb, in charge.** Your sessions ride rings round it as small orbs in their own colours (working ones pulse;
  one that needs you glows red and comes closer), it's lit from within, and a ripple goes out when it directs one.
  When Cora works with the session you have open, a small copy of it flies out of its card, circles that session's orb
  and brings the answer home (and the other way round when a session has news); a session's row glows while they
  talk.
- **Send email from a session, on your say-so.** A session can ask for an email to be sent: it waits in Cora for you to
  change it, Send it, finish it in Gmail, or discard it. Nothing goes without your click (off unless you turn it on:
  Settings › Gmail).
- **See what sessions change on the web.** A Jira comment, a moved ticket, a merge request's note: Cora loads it in
  the session's browser at the change (in the background, or shown), notes it on the session's card, and lists it in
  Changes under On the web.
- **Links between notes:** `[[a note's title]]` links to it (typing `[[` offers your notes), a note shows what links
  to it, and renaming one carries the links along.
- **Each session's journal**, a markdown file in Documents\Cora\Journal: its milestones and wrap-up as it works, and
  the Board's Journal panel to watch it.
- **Deep freeze.** After the PC restarts, Cora offers to bring back the sessions and terminals that were open.
- **The Board's bar** never runs its page tabs under its controls: narrow, they scroll in their own strip. The
  timeline, turned off, is gone (Settings › Scene › Timeline brings it back).
- **1Password** answers at once and stops suggesting over a page it just filled. Gmail drafts open, signed in as the
  profile your Gmail is on.
- A session's orb and card no longer show a finished command as still running after a restart. Packages updated.

## 0.1.7

- **Lockdown.** Lock Cora behind a PIN when you step away: the lock button beside Settings, Ctrl+Alt+L, the tray, or
  the palette, and (if you like) whenever Windows locks or sleeps. The lock screen is the splash's star stream with
  Cora's orb keeping watch. While it's locked, your pages get nothing from Cora's server, notifications say only that
  something needs you, and quitting from the tray never ends a session; your sessions keep running, and Cora stays
  locked over a restart. Set the PIN in Settings › Lockdown.
- **The Board, reworked.** A page always fills the area, like split panes: no holes, nothing hanging below.
  - Every line between panels drags like a split bar, from either side; a dot where lines meet moves them all.
  - Dragging a panel keeps the mouse to the end. The Board stays still meanwhile, with an outline showing where it
    will land and what that does (swap, or take a half). Drop it on the Board's own edge to run the full width or
    height there.
  - A finer grid (24 by 24). The narrow one-column view reorders by dragging. Esc brings back a panel filling the
    Board.
- **Board layouts.** Pages laid out for a kind of work (Investigating, Coding, Reviewing, Shipping, Writing), or your
  own saved ones. As the work moves on, a session can add the page for it (Settings › Sessions › Board: off, add, or
  add and show, with Undo); it never changes your own pages.
- **The Board's bar:** pages as named tabs (double-click to rename; their ⋯ menu renames, saves as a layout,
  duplicates, moves and removes, with Undo), ＋ for a new page, and a ⋯ menu for the Board as a whole.
- **The Terminal panel** holds terminals of its own, in tabs: it opens PowerShell (or your default) at once, ＋ adds
  another of any kind, × ends one.
- **The session's browser slides over the Board** like a drawer instead of pushing it aside, and the Spotlight no
  longer pulls it onto the Board.
- **Vibes:** take a sticker off the wall, or clear them all; the wall is a pinboard now.
- **Resume names sessions as the nav does** (your name, its ticket's or issue's, Cora's suggestion), even once a
  session has left Cora's history.
- **Vibes** is the Memes panel's new name; its stickers always fit inside the panel, and a meme Claude drew opens large
  properly.
- **From the splash straight into the app:** the second loader shows only when a start is slow.
- **One scrollbar everywhere**, explains and terminals included.

## 0.1.6

- **Memes.** A board panel the session fills itself: a wall of memes from popular templates captioned by Claude,
  GIFs (with your Giphy key), and memes Claude draws itself (kept in memory only, never on disk), when something
  happens. Off until you turn it on (Settings › Sessions › Memes).
- **+ Panel is readable:** each panel with its icon and two lines on what it shows, grouped and tinted, with a search.
- **Session switcher:** Ctrl+Tab, or Alt+← / Alt+→, as Windows' Alt+Tab, with a picture of each session as you last
  saw it. The palette groups sessions as the nav does.
- **GitLab:** its own Settings page (connected or not), and an issue assigned to you can be offered or started.
- **Start a session from a GitLab issue.** New session › **From a GitLab issue** lists your open issues (or take a
  pasted link), starts in your checkout of its project, and begins with the issue summed up and the code diagnosed,
  changing nothing until you say. The session is named after it, with its `#number` to open it; GitLab to-dos about
  issues start the same way from the Inbox.
- **The board's Browser panel is a browser of its own**, with its own tabs and profile switcher; the session's browser
  keeps its place and its links.
- **Recaps.** Claude Code's recaps (the "where it stands, what's next" it writes when you come back to a session) are
  kept as long as Cora keeps history. The latest shows between the transcript and the composer, on the session's
  Overview card, and beside the nav when you rest on a session; the board has a **Recap** panel (and the Spotlight
  shows a fresh one). Cora starts its briefs and wrap-ups from them.
- **The morning brief comes when you open Cora**, not at your first click, and isn't lost when Cora is still starting.
- **Voice direction** goes to ElevenLabs as a short audio tag (a whole description was sometimes read aloud);
  Settings shows what's sent.
- **Google sign-in works in Cora's browser.** It shows itself as Chrome does (Electron 44 had left Chrome out of its
  user agent, and Google turned it away as an embedded browser), so each profile can sign in to Google.
- **Settings › Updates & security.** An installed Cora shows the version you're on, the latest release (with its
  notes), what it runs on (Electron, Chromium, Node.js) and **Restart to update** when one is ready: security fixes
  come with Cora's updates. Running from source, the page says its checks are about your checkout, and that a fix
  reaches installed copies when you publish a release.
- **A simpler session list.** It holds what's open: Working, Idle, and what ended in the last four hours. Older
  sessions and ones you removed are in **Resume**, which can now **View** one without resuming it and marks the ones
  you removed. No more **Show earlier** or hidden group.
- **Nothing open, nothing shown.** End or remove the session you're watching and Cora moves to a live one, or says
  **Nothing open** when there's none, instead of keeping the last transcript up.
- **First run.** A new install goes straight to setting Cora up (no flash of the app first), with Cora's orb on it;
  **Restart to update** no longer covers the sessions in the nav.
- **Starting up** shows Cora's live orb, in your colour, with what it's waiting on.
- **Nothing open** is a page in your colour: Cora's orb, New session, and your last few sessions a click away.
- **Explains panel:** its cards size themselves to fit the panel (no scrolling when they can fit), with Pop out on
  each card's corner.

## 0.1.5

- **Switching sessions is calmer:** the new one fades in, with no zoom.
- **3D off: the live board.** Settings › Scene › 3D scene off swaps the scene for a flat board of each agent and what
  it's doing now, what they're touching, the tasks and the explains, with no graphics engine. Its panels sit on a grid
  that fills the area at any window size: drag one onto another to swap or split, drag an edge like a split bar, close
  and add them back, and spread them over pages. Each session keeps its own board. Explains show as cards with a
  preview, who wrote them and when; pop one out to keep it (live) on the board. Sixteen more panels to add: Goal,
  Context, Changes, Git, Tests, Background, Pipeline & MR, Deploys, Ticket, Needs you, Mentions, Notes, All sessions,
  Usage, Terminal and Browser. And a **Spotlight** panel that Claude decides about: the explains it writes land there (not
  over the board), and its new `spotlight` tool asks for a panel; the latest stays until the next (an approval cuts in).
- **Your plan's usage, as `/usage` shows it**: on the session's context meter card (session and week), a click away
  from the full view (every limit, extra usage, what your sessions used this week), and as a board panel.
- **Tidier nav and board.** The board's page and panel buttons are one even bar (bottom right); the board sits in a
  well of its own with room around its panels; the expanded Tools list resizes from its top edge (and scrolls); the
  session list says "Show 5 earlier" for older ended sessions, and keeps the ones you dismissed in a folded **hidden**
  group at the bottom; the Inbox sits under Cora's card as part of the same section.
- **Cora's eye is alive**: an orb like a main agent's (Settings › Scene), with all its moves driven by Cora's own
  agent, and it notices you: it looks toward your pointer, swells and ripples under it, jiggles when clicked, listens
  while you hold it, breathes, and sleeps in Away mode or late at night.
- **Nothing talks over anything else**: spoken lines wait their turn (announcements, summaries, Cora's replies,
  pipeline and Jira news), short ones waiting together are said as one, and a line left waiting too long is dropped
  rather than said late. A "read aloud" you click cuts in; Esc and mute stop it all; talking to it pauses the rest.
- **The timeline folds away** with a tab on its edge, and does no work while folded; it starts folded with the live board.
- **The mic is in the composer** now (the one over the scene is gone; Ctrl+Shift+Space still talks from anywhere); the
  board's own buttons are bottom right.
- **The speaker under the transcript mutes all voice updates**, not just replies: finished commands, pipelines,
  failures, "needs you" and Cora's own news are quiet too while it's off.
- **Fewer 3D restarts and black flashes.** A 3D view being closed (leaving the overview, restarting it by hand) no
  longer counts as the graphics failing and rebuilds the scene for nothing. Real restarts are written to Cora's log.
- **Answer from anywhere.** While you're away, everything that waits for your OK comes to your phone through Cora's
  Slack bot: a session's Slack drafts (**Send** / **Discard**) and Cora's own cards (**Yes** / **No**, or its suggested
  answers), as well as permission prompts. What was already waiting when you left comes then. Away mode counts as away.
- **Asking is your OK.** Ask Cora in your own words to start, tell or end a session and it does it, with no card.
- **Messages to yourself go at once.** A session that DMs you (a follow-up while you're away) doesn't wait for your OK.
- **Background agents don't bury replies.** After a turn ends, a background agent's work folds into one row in the
  transcript's **All** view.
- **Cora's Browser.** A browser of its own in Tools (`Ctrl+Shift+B`), not tied to any session, with tabs, find,
  1Password and your bookmarks. Inbox links with no Tool for their site open there instead of a separate window.
- **Every browser in Cora:** drag tabs to reorder them, and a bookmarks bar under the address bar.
- **Browser profiles.** Bring in your Chrome and Edge profiles (Settings › Tools): each has its own sign-ins, bookmarks
  bar and tabs, and Cora's Browser switches between them like Chrome. Sessions use the one you pick.
- **Home** in a Tool's header takes it back to its page.
- **Signing in with Google in Cora's browser** works again: staying signed in no longer sets a sign-in's cookies back
  to older values mid-way (Google answered "400, malformed").
- **Cora's sign-ins** (Settings › Tools › Cora's browser): pick the profile that keeps the sign-ins Cora had before
  profiles.
- **Your GitLab to-dos.** MRs and issues assigned to you, review requests, mentions and approvals needed come into
  the Inbox and to Cora, and to your phone while you're away, as Jira tickets do.
- **Messages you send while Claude works** show as **queued** under the transcript until Claude takes them, then where
  it did. (One sent mid-turn used to replace the turn's own prompt in the transcript.)
- **Open in Jira from the Inbox** lands on the ticket, even when the Jira Tool wasn't open yet.
- **The README** shows Cora's scene in full swing, and every screenshot in Cora's pink.

## 0.1.4

- **Live explains.** For work that runs for minutes, Claude keeps a dashboard that updates in place as it works: tests
  passing, a build's stages, a deploy. Every HTML explain also gets Cora's colours, so it looks like part of Cora.
- **Explains have versions.** Written again under the same title, an explain gets a new version instead of a copy;
  step back through them in the viewer.
- **Quieter Slack.** Slack's own notifications only while you're away from Cora, not for every message while you're
  in it.
- **Share an explain.** Its session publishes a copy as a claude.ai artifact, and you get a link to send; update it
  to the newest version later, at the same link.
- **Cora is pink**, its default colour, icon and installer.

## 0.1.3

The first public release. Cora now updates from this repository's releases.

- **Find in Tools.** Ctrl+F works in the Tools drawer and in Tool windows. Esc in the page closes find, and its
  highlights always clear.
- **Your own work tools.** In Settings › Cora › Work tools you tell Cora about your MCP servers and which of their tools
  only read.
- **Clearer views.**
  - In the 3D scene, a subagent's helpers keep clear of each other, and the "waiting for you" ring no longer covers the
    text under it.
  - The galaxy groups sessions by folder.
  - An explain's card in the transcript reads as plain text.
  - Checklists show one box per item.
  - The Changes tab counts each file once.

## 0.1.2

- **1Password at the field.** A key in a page's login field opens your 1Password logins right under it. Focusing one
  suggests the site's logins while 1Password is unlocked. This works in session tabs, Tools in the drawer, and Tool
  windows.
- **Questions with more answers.** Claude's question cards take several answers and an **Other…** of your own. MCP forms
  check their required fields.
- **Long sessions.** A session's earlier events load from the timeline.
- **Kept in bounds.** Logs roll over, old terminals are let go, and Cora's database compacts itself.
- **Fixes.** Setup's install buttons open their window again. Esc in the composer keeps your draft. Failures that used
  to be silent now say so. Electron security patches install reliably.
- **The user guide**, in `docs/guide`.

## 0.1.1

- **Security hardening** across the board:
  - separate keys for the dashboard, hooks, Cora's agent and the terminal host;
  - sign-ins sealed with Windows DPAPI;
  - other people's words always marked as data;
  - the agent's commands checked more strictly;
  - the built-in browser fenced in.
- **Drafts and approvals survive a restart.**
- **Chrome and Edge bookmarks and history** in the browser's address bar.
- **1Password** in Cora's browser.

## 0.1.0

The first release: sessions, the 3D scene, transcripts and explains, permission prompts in one place, terminals that
survive restarts, Cora's assistant, voice, and the Jira, Slack, Gmail, GitLab and deploy integrations.
