# Changelog

What changed in each release. Cora updates itself; each update's notes are on its release page too.

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
