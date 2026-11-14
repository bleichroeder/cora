# Changelog

What changed in each release. Cora updates itself; each update's notes are on its release page too.

## 0.1.28

- **Cora's browser signs in to pages that ask with an HTTP sign-in** (Basic auth and the like, a proxy's too). Before,
  no form came up and the page just said you weren't authorised. Now Cora asks: the site, a username and a password.
  Tick "Keep for this site until Cora closes" and it's given again without asking (kept in memory only, never
  written anywhere); one that's refused is asked again. It warns when the password would cross the network readable.
- **A site whose certificate isn't trusted asks, instead of failing.** A dev server's self-signed certificate, or one
  from an authority this PC doesn't know: Cora says what's wrong with it, who issued it and whether the site is on
  this PC, and you choose. Continuing holds for that site with that certificate until Cora closes; a different
  certificate for the same site asks again, and a revoked one is never offered.
- **Downloads.** A file a page downloads goes to your Downloads folder, with no dialog. A button by the address bar
  lists them: progress, cancel, show in folder, copy its path, or give its path to the session. Cora never opens a
  downloaded file itself.
- **A page's errors, handed to the session.** When the page you're on logs errors or a request of its fails, a red
  count shows by the address bar. A click puts them all in the session's composer, with the page's address and where
  each came from, to send as it is or with your own words.
- **DevTools.** F12 or Ctrl+Shift+I in a page (or the button by the address bar) opens its DevTools in a window of
  their own.

## 0.1.27

- **The transcript reads as turns.** Each prompt is a turn: your words, the work as one line you can open ("Worked ·
  read 12 · ran 3 · 1 failed"), and Claude's answer first, where you look. What Claude Code's own terminal says and
  Cora used to drop now shows as rows: errors, a usage limit, a scheduled wakeup, a missed hook, leaving plan mode, a
  merge request's link (once, however often it's written).
- **What's live is in one place**, above the composer: what the session is doing now, its tasks, background commands
  still running, messages you've queued, a command you're running, and Claude Code's latest recap.
- **The composer knows what Claude is doing.** While it works the send button is a stop button, and says "Stopping…"
  until it has. The box says what sending will do (queue for its next step, wait for a limit, answer the question
  above). Claude Code's suggested next prompt shows over the box and Tab takes it. Its permission mode is a chip by
  the buttons: click to step it. A message you queued can be taken back into the box, to change or drop.
- **Live dashboards from data.** A session can keep a dashboard of its work by writing only a small data file: big
  numbers, steps, tables, charts, a timeline. Cora supplies the page and redraws it as the file changes, so the
  dashboard follows the work: a block appears when it starts to matter and goes when it's done. Sessions are told to
  keep one for multi-step work without being asked. A session can still write a page of its own for anything else.
- **Dashboard buttons.** A dashboard can offer the next steps as buttons ("Retry the failed tests", a link to a merge
  request): a click sends that prompt to the session as your message, or opens the link. One marked risky takes two
  clicks. A page a session wrote itself asks in Cora first, and someone watching your Cora can't press them.
- **A session hears at once when its dashboard's data is wrong** (not JSON, too big, a block the page can't draw),
  with what and where. Before, the page silently kept the last good data.
- **The session's card says more, more steadily.** A session a limit stopped reads "paused" with when it resets, and
  one compacting reads "compacting", where both read idle or working. One clock, the turn's, beside the state. Each
  figure keeps its side of the orb in every session.
- **A Journal tab**, beside Transcript, Explains and Changes: the session's journal as cards, newest first, each with
  its kind (a decision, a finding, something done), its time and what it points at. The tabs are centred under the
  card, and the transcript's filter bar shows only when there are agents to choose between or a search going.
- **A session hears about your network only once it asks**, then when it changes, instead of with every prompt; its
  environment tool names the VPN that's connected.
- Fixed: an idle session showing as working or compacting after Claude Code compacted it while idle; a message sent
  while Claude worked showing twice; one queued with the same words as an earlier message never showing as waiting;
  Claude Code's input box not being found in a named session (taking back, the mode chip and the suggestion all read
  it); long words, paths and links running off the transcript instead of wrapping.
- Fixed: a session's Playwright page going white when the browser was widened; Playwright reaching a file it wrote (a
  `file://` preview, a screenshot in its scratchpad), which Playwright MCP now blocks unless told otherwise; OpenVPN
  Connect's window staying up after a switch from Cora.

## 0.1.26

- **Whiteboard.** A new Cora tool: sketch on a board in the Tools drawer (Excalidraw, in Cora's colours), and Send a
  picture of it, or of what you've selected, to a session's composer. Scratch is always there, and you can keep named
  boards, pin them, and tie one to a session. Sessions can look at a board (a picture and an outline of what's on it)
  and draw on one themselves: a Mermaid diagram or simple boxes and arrows, in a frame of their own beside what you
  drew, never on top of it. Ctrl+Z takes it back, and a session can only ever remove what it drew. Boards are
  standard `.excalidraw` files in `~/.cora/boards`, so they open on excalidraw.com too. The expand button widens the
  drawer while you draw.
- **Switch your VPN from Cora.** With OpenVPN Connect on this PC, a pill at the bottom of the sessions list shows
  which profile is connected; click it to switch or disconnect. Sessions can't switch it: they ask (a card with
  Switch and Not now, telling you who a switch would cut off), and their commands that would drive OpenVPN are
  refused. Cora learns which environments each profile reaches. Settings › Environments turns it on or off.
- **Sessions that want you say so in the list.** One that needs you breathes red, with a red bar on its left; one
  that finished since you looked gets a blue dot that pings as it lands. When they're scrolled out of sight, a chip on
  the list's top or bottom edge says so ("↑ 2 need you · 1 done") and takes you to the nearest. Folded projects show
  finished ones in blue too.
- **Pictures in your prompts show as thumbnails** in the transcript, and **file paths you can look at**: a path in
  your prompt, or in a reply's `code`, opens a card with the picture, or a text file's first lines at the line named.
  Open puts a picture in your image viewer and text in VS Code (at its line, when the IDE panel has its folder) or
  Notepad; nothing else is ever opened. Show in folder, and Copy path.
- **A prompt with a picture sends on its own.** Pressing Enter in the composer with an image attached left it waiting
  in the terminal; now it goes once Claude Code has taken the picture in.
- **Tools take less room.** Your tools' names are on one line each, and Cora's own (Notes, Library, Whiteboard,
  Browser, Secrets) are a row of tiles in both views, each in its own colour made from yours. Security updates are a
  dot on the Settings gear, and the gear opens on them.
- **Secrets: find one, see what needs you.** Expired secrets, and ones expiring within a day, come first in a strip
  of their own, each a click from pasting a fresh one. With more than a few: search (`/` goes there), a kind filter,
  grouping by who may use them (all sessions, then each folder), and sorting by name, last used or newest. A row
  opens for the rest: how commands get it, a login's username to copy, its folders, and the session that last used it.
- Electron 44.11.2.

## 0.1.25

- **A session's Playwright works in Cora's browser.** When you use Playwright's MCP server, the sessions Cora hosts
  drive tabs of Cora's own browser instead of opening a browser of their own. They're your server, as you set it up,
  pointed at Cora: same tools, so your permissions still fit. Its tabs show in the session's browser with a bot on
  them, and you can watch or step in. They keep working while you look at another session or the overview. Playwright
  sees only that session's own tabs, never yours, another session's or Cora's window. They sign in as a profile of
  their own by default; Settings › Cora's browser can make them use the session's browser's logins instead, or give
  Playwright its own browser as before. Playwright's isolated mode isn't available there.
- **`/` commands that open a screen of Claude Code's work from the composer.** `/mcp`, `/config`, `/permissions` and
  the like bring the session's terminal up in full, with the keys, and the keyboard comes back to the composer when
  the screen closes. The Claude tab hides it again whenever you like. The `/` menu says what Enter does (run, or add
  arguments), and a command Claude Code answers itself (`/context`, `/cost`) shows in the transcript with what it said.
- **Esc right after sending takes the prompt back.** Within a few seconds of sending, Esc stops it and puts it back in
  the composer, attachments too, to change or send again. The transcript marks it cancelled. Before, the prompt went
  back into the hidden terminal's input, and your next one was added on to it.
- **A new session's "trust this folder?" is asked in Cora.** A card in the composer (Trust this folder, or Don't
  start), and "trust folder?" on its row. Before, it waited unseen in the hidden terminal until the session timed out.
- **Compacting shows while it happens.** A row under the transcript with how long it's taken, "compacting" on the
  session's row, and its orb pulsing in the scene.
- **Secrets can be a username and password.** Add one as Username + password and a command gets `$NAME_USER` and
  `$NAME_PASS`, both hidden in what it prints. Secrets you already have stay as they are.
- **Opening a Tool puts the cursor where you'd type**: the field you last used there, else a chat app's message box
  (Slack, Teams, Discord, Google Chat).
- **A ticket's key on a session's row is a label.** Clicking it opens the session, not the browser.
- Electron 44.11.1.

## 0.1.24

- **Library: everything your sessions made, in one place.** Tools › Cora › Library gathers explains, debriefs and
  their videos, journal artifacts, recaps and Cora's briefs, ended sessions' too. Grouped by project and session,
  with search, kind and time filters, and stars that stay on top. A click opens each one where Cora shows it, with a
  link back to its session.
- **Flag a session to come back to.** A bookmark at the end of a nav row (or its right-click menu, or the palette's
  "Come back to this") flags it, with an optional note of why and a reminder: later today, tomorrow at 9:00, or a time
  you pick. A reminder that's come brightens the bookmark and tells you once. A folded group shows how many it holds,
  and a flagged session stays in the list until you clear it.
- **Wakes in a team follow its routes.** A team has no wake limit of its own: its routes decide who may wake whom
  (on its own, with your OK, or never), and each seat's own limits hold it back. Information never wakes anyone: a
  note, a change, a decision or an item's ping. Work handed over does, and so does a task assigned or reassigned to a
  member, which wakes its new owner. A note on a task still doesn't. A project without a team gets a **Wake limit**
  setting instead (6 an hour by default, or none, which drops the pair guard too). Pings say which they are, an
  assignment or a note.
- **A wake carries only what it's for.** It marks just its own post as delivered, so a note that didn't wake its
  member is still news at the prompt that wake starts. A post to two members that a wake carried to one is still news
  for the other, and the board says delivered once every member has it.
- **Seats by their names.** A post's recipient or an item's owner can be a seat's id or its name however it's written,
  or its handle (a pool's `seat-2`); a pool's several members ask you to name one. A note, change or decision to a
  group goes to its members on the group's route (only work is offered to a group). What waited for a member who left
  with nobody in their place (a seat renamed away) goes to the team's fallback, never nowhere.
- **A renamed seat keeps its running sessions.** A seat given a new id, with the same name or instructions, is
  renamed, not replaced: its members stay running with what they run and know, and are told their new seat. Anything
  else that changed in it is a notice or a restart, as for any seat.
- **A seat restarted to take a change comes back as itself.** Its members resume with their memory on the seat's new
  definition, a pool at the size it had; only one that can't be resumed is replaced. A seat's new worktree starts from
  the branch its folder has checked out, not the repo's default.
- **Apply warns before it ends sessions.** Its sheet says that seats standing down end their sessions, and what those
  run (a `/loop`, a cron, a Monitor) and know, and which seats it keeps as renamed. A seat removed while it's stood down
  lets its members go at once, and what waited for them goes to the team's fallback.
- **A seat's first prompt waits until it lands.** It counts only once the prompt arrives. Typed into a terminal still
  starting and lost, it waits for the seat's mod to take it, and isn't given twice if it turns up after all. Several
  seats starting at once wait longer, and nothing is sent to a member being stopped.
- **Cora's agent never goes quiet unnoticed.** What it's given counts only once it's in its conversation. If it isn't,
  Enter is pressed once more, and then its console says it isn't responding, with Restart (and Start fresh after a
  restart that didn't help). What it was given waits for it and is never given twice. Each item goes in once the turn
  before is over. Without Cora's hooks it works as before.
- **A fresh start of Cora's agent starts in order.** Its first turn is the new-conversation notice with what the last
  one missed, as context: the latest lines, each with its own time, and the rest counted. Your words follow, each once.
  A call that has already started is "too late", and an assignment someone else took says who has it. `jira_start`
  sees a ticket already worked on in a session named for it or in the journal.
- **Live share keeps all of Cora's conversations private.** Guests never see an earlier conversation of Cora's agent,
  only its current one, and only when you share the console.
- **Team map: lit route labels sit on a pill** under their chip, clear of the route's line and of the tiles.
- **Tasks keep their history.** The team map's rail shows every step a task went through and who had it at each.
- **A task read in full.** `project_items` with an item's id gives its whole body and every note; the listing stays
  short.
- **A pool's member by its shown name.** "Engineer 2" works as an item's owner or a post's recipient.
- **An archived project takes its sessions with it.** Archiving ends its running sessions (asking once first, if there
  are any) and hides them all: none show under Ended. Bringing it back resumes them in it, with its team back up if it
  was. Resuming one of its sessions brings the whole project back.
- **Usage panels keep their numbers.** Your plan's usage is read every 5 minutes. If Anthropic turns it away (HTTP
  429), the last reading stays on show with when it was taken, and Cora waits before asking again. A test Cora never
  asks.
- **Cora's agent keeps its context small.** Once its context passes its cap (200k by default) and it has been idle
  for 5 minutes, it starts a fresh conversation between turns. What it remembers carries over, and each wake stops
  rewriting a huge context.
- **A session with a huge context is pointed out.** Past **Big context** (Settings, 300k by default), its header's
  context chip turns amber and says what each turn rereads, and one notice suggests a handover or `/compact`. A team
  seat's lead hears it on the board. Cora never acts on it herself.
- **A session's web change shows when you're watching.** In "Load it in the background", a change is shown if you're
  looking at that session's browser and haven't used it (clicked, typed or scrolled) for 30 seconds. Otherwise it
  loads behind your tab, marked "new · <session>" until you look.
- **Sessions another session started nest under it.** A folded line under the creator says how many and why, and opens
  on a click. Once one has ended and its folder is gone, it leaves the nav. Test Coras mark theirs. Rerun Setup to pass
  the new markers from your hooks.
- **Old sessions stop reappearing in the nav.** A live explain's page that was only read (a session searching the
  explains folder) no longer counts as a new version, which made an old session look active.
- **No false "transcript lines weren't recognised" warning.** Claude Code's newer bookkeeping lines are known, and only
  a message Cora can't read counts.
- **Project header:** the sessions line names the first three folders and +N (all of them on hover) and only it gives
  way, so the name and buttons keep their size however many members. In a narrow window the buttons keep their icons
  and lose their words, and the name, toggles and ⋯ menu always fit.
- **Narrow windows:** a tool (Library, Notes) opened from the nav's drawer closes the drawer, so nothing covers it.
- **Electron 44.10.2.**

## 0.1.23

- **The team builder.** Build a project's team on a canvas instead of writing it out: seats, groups and the routes
  between them, laid out for you and yours to drag. Open it from **Build a team** (or **Edit team**) in the project's
  header, from **Create with a team →** when you make a project, from **New project with a team…** in the palette, or
  from a new project's empty Crew. Start from a shape (hub and spokes, a pipeline, a pool) that asks a few questions,
  or a blank canvas, and a short tour shows you around.
- **Build it by talking.** **Build with Cora** opens a conversation of its own beside the canvas: describe the team and
  watch it take shape as she replies, each reply with its own Undo. Take over at any point; she sees your edits and
  works from them.
- **Read it back, try it, then apply it.** **In words** says what the team does in plain sentences. Checks flag
  problems as you go (a seat nobody can reach, a route to nowhere) and point at them on the canvas. **Try a message**
  traces where a message would go, labels included, before anything is live. **Apply** says what will change and which
  seats restart; **Apply and bring up** starts it. The draft is kept until you apply or discard it (Start over).
- **A lead's proposal on the canvas.** Open a lead's team proposal in the builder to see it laid out, edit it, and
  approve it with your edits. Leaving with unsaved edits asks first.
- **More in the builder:** Talk grows as you type, like the session composer, and shows what Cora is doing as she
  drafts. Talk and In words can be made wider by dragging their edge. The builder stays open while you work elsewhere,
  and a draft in progress shows on its project. A team can name its lead seat. Apply's sheet says what you're agreeing
  to (the team in numbers, the few things to check, one row per seat), and the checks warn about seat folders that
  aren't there and startup steps that can't run as written.

- **Teams.** Give a project a team: its **seats** (roles, each a Claude Code agent with its own instructions, tools,
  model and permission rules), **groups** of seats, **labels**, and **routes** (who may message whom, which kinds,
  and whether a message may wake an idle seat: on its own, with your OK, or never). Cora starts each seat as its own
  session from the team's own plugin, and a message no route allows is refused, telling the sender who it may message
  instead. Work posted to a group is offered to its free members (split by label down nested groups), and the first to
  claim it owns it. A busy pool grows when the work needs it and closes its extras once they've been idle for a while.
  Escalation rules re-offer unclaimed work, nudge stale owners and tell you about critical incidents. Each seat can
  have turn and cost limits and quiet hours. Needs Claude Code 2.1.287 or later.
- **Change a team while it runs.** Cora edits it when you ask (`team_get`, `team_edit`), or the project's lead
  proposes a change and you approve it. Either way you see exactly what it changes, line by line, with ⚠ on folders,
  permissions and risky modes. New seats start, removed ones stand down, a retasked seat is told its new role at once,
  and a seat whose tools or permissions changed offers a restart. Every version is kept, and you can roll back.
- **Bring up and Stand down** from the Team panel. Bring up brings stood-down seats back as the same sessions, with
  their memory; **Start fresh** replaces them. A seat that dies is restarted (resumed once, then fresh), and one that
  keeps dying lands in Needs you.
- **On the board:** Crew groups members by seat ("Encoder analysts 1 of 2"), Needs you shows team proposals, seats to
  restart, seats failing to start and a team that isn't running yet, and the Conversation shows work offered to a
  group and refused messages (quietly). Seats are named by their seat.
- **Conversation panel:** filter chips only for what the thread has, a one-line key, and a centred empty state.
- **A session that started before an upgrade** hears which of Cora's tools it doesn't have yet, and how to reconnect.
- **The Work panel.** A project's work queue as tasks, one row each in rank order (title, owner, state, branch, when
  it last changed), with the details a click away. The lead opens, ranks, assigns and closes them; the owner moves
  them through building, review and testing; anyone adds a note. A new board starts with it, under the Crew.
- **The team map.** A board panel that draws a team project's team live: each seat with a row per member (its state,
  what it's on, its branch) and the routes between them. A working member's dot breathes, one that waits on you shows
  a Needs you chip, and a route that just carried a message stays lit. An activity rail lists posts, refused messages,
  task moves and members starting and stopping. A member's row opens its drawer: a reply line, its work, and Resume,
  End or Restart. In a narrow panel the map is drawn as one compact column.
- **Voice:** a speech volume of Cora's own (Settings › Voice), and hearing a line again plays it in its session's voice.
- **Sessions know the time:** a session's first prompt says the day, date, time and zone, and again every ten minutes.
- Fixes: a session's model follows `/model` at once; Cora's messages to sessions arrive as plain prompts; ending a
  session whose check couldn't run says "couldn't tell" instead of ending it; a post to a member Cora can't reach is
  marked not delivered after ten minutes, and its sender is told; Resume here is one click for a session that has
  ended; team seats never stop at Claude Code's "trust this folder?" question; an edited decision post updates the
  card; a team's Inbox item says why for everything you haven't read; typing in a long composer is no longer slow;
  dropdowns take the app's colours; Cora's agent stays out of team projects' traffic.

## 0.1.22

- **Sessions talk to each other through Claude Code itself.** Cora now builds on Claude Code's own cross-session
  messaging. Each session Cora starts gets a name its project's other sessions can message it by (on its project
  card), and a small Cora plugin that shows their direct messages on the project's board. A message reaches a busy
  session at its next step, without interrupting it. One that would wake an idle session still waits for your OK (the
  wake card), unless the project lets its sessions wake each other. Needs Claude Code 2.1.287 or later
  (`claude update`); with an older one, sessions work as before.
- **No more typing into terminals:** a message from you or Cora, or a project post waiting for a session, reaches it
  through its plugin as a turn of its own.
- **The project board, redone:** **Crew** shows who's doing what and what each session last said, with a reply line on
  every session (it goes in as your prompt) and its questions answered right there. **Needs you** says plainly what
  waits on your word: wakes, questions, incidents nobody owns, known issues to approve. The **Conversation** shows who
  wrote to whom and what happened to each message (delivered, held for you, waiting for its turn). A new project's
  board starts with the three.
- **In the nav:** a **+** on each project starts a session in it, and dragging a session within its project reorders
  the project's sessions.
- **Project tools in every session,** so a session added to a project (or whose project starts coordinating) can post
  and claim at once, without a restart.
- Fixes: a session you ended and resumed is no longer marked ended when Cora restarts; a claim that loses names who
  has it; Cora's own sessions (its agent and helpers) don't take messages from other sessions.

## 0.1.21

- **Incidents in a project.** One per outage, shared by its sessions: severity, owner, state, the next step, a link,
  and dated notes, stamped as they change. A session claims one before working it, and a second claim is refused,
  saying who has it, so two never work the same outage. Whoever is assigned one, or has a note added to theirs, is
  told. Closing one asks for its cause and fix and puts it in the project's log; a duplicate merges into the other.
- **Known issues:** sessions propose what keeps coming back (a flapping check, a site dark overnight) with a rule for
  it; you approve them, and they join every session's project card until you retire them.
- **Seats and a lead:** give each session a role in a project, and make one its lead (it opens incidents, sets their
  severity and owner, merges duplicates). Both show on everyone's card.
- **Reports:** a steady stream (alerts, status changes) goes to the one session that handles it, and only it hears it.
- **Fix or withdraw your own posts,** sessions and you alike (a withdrawn post stays, struck through); the others hear
  of the change. Sessions can also read the thread by writer, or just the open questions.
- **Cora may route** (in a project's header): Cora posts and runs its incidents on standing orders, within its brief
  and decisions, without asking you each time. Off, she asks you first.
- **On the board:** new **Incidents** (most urgent first; assign, claim, note, close, merge; the log) and **Known
  issues** panels (add them from the panel picker). **Open loops** shows incidents nobody owns and known issues
  waiting for you; the **Conversation** has a reports filter and lets you edit yours; **Who's on what** shows seats
  and the lead.

## 0.1.20

- **Projects that coordinate.** A project's sessions mostly do their own work, and now know they're in one: each gets
  the project's card (its brief, decisions and pinned notes, who else is in it and what each is on, and when to post)
  on its first prompt and when it changes, then only what's new: what's addressed to it in full, other notes as a
  count. They post changes, questions (to another session or to you), handoffs, notes and decisions, and answer a
  question in place. A handoff to a busy session waits, and becomes a "deliver it?" card when its turn ends (waking a
  session always asks you). New projects coordinate by default; turn it on for older ones in their header.
- **The project board:** the Constellation shows what's waiting (a marching line, a badge per orb); **Who's on what**;
  **Open loops** (deliver a handoff, answer your questions, close one, changes some haven't heard); **Shared notes**
  (a pinboard: pinned notes join every session's card); the **Conversation** (filter by kind, answers under their
  question, write to the project or one session).
- **Cora keeps you posted on projects:** questions and handoffs for you reach her, and your Cora DM when you're away;
  she posts your answers back when you tell her to.
- **Sessions may wake each other on their own**, if you let them: **Wake each other** in a project's header (six
  times an hour per session at most, and back to asking you if two keep waking each other).
- **Email watches trust your internal senders.** Gmail's SPF result for the sender's own domain now counts (alert
  servers rarely sign their mail), you can list domains to trust in Settings › Gmail, and a watch that won't act says
  what Gmail found (spf, dkim, dmarc).
- In the Constellation, an orb speaks only when its own session is read aloud (every orb used to speak at once).
- **A plain message on request:** ask Cora (or a session) for no banner, and a message comes without one, to you too.

## 0.1.19

- **Updates no longer break a running terminal host.** An update removed the folder of the terminal host still
  running from an older version, and Cora reconnected to it: every new terminal then exited at once, and Cora's agent
  kept stopping. An old host's folder now goes only once nothing runs from it; a host from an older version is
  replaced when it has no terminals, else kept, its folder mended if it lost its files.
- **Sessions can message you, and it pings you.** A session's message to you goes through Cora's own bot, in your
  Cora DM, under the session's name and banner (it used to land, silent, in your own DM). Reply in its thread and the
  reply goes back to the session. (The banner needs the bot's files:write scope.)
- **The away digest says what happened.** One line per session, saying what it did (its journal since you left, or
  its last reply), instead of a line per turn; each turn now counts once.
- **Cora checks back when you ask her to** ("let me know what it finds"): when a session's turn ends, at a time, or
  every so often, a few times at most. Shown, and cancellable, in her console.
- **Cora puts sessions in projects:** start a session in a project, or move one in or out.
- **Slack:** "Start a session on this" and "Ask Cora about this" in any message's menu (your clicks only); messages
  for later (Slack holds them until the time you give); Cora posts in a channel as herself and pins a message, only on
  your word or your OK; your status says "In a call" during calls (nothing about the call). Paste the app's updated
  manifest (Settings › Slack) into Slack to get the new scopes and shortcuts.
- **Calls:** an alert as a call starts too (a notification that joins it, Cora's one line, your phone when you're
  away).
- **No more GitLab sign-in popups from Cora:** its background fetches use glab's sign-in when glab is signed in, one
  at a time, retrying once before saying anything.
- A session you removed from the list is off its project's rows in the nav too.

## 0.1.18

- **Cora knows your day.** She reads your Google calendar (read only, through the same Google sign-in as Gmail; add
  the calendar permission and reconnect in Settings › Gmail). A **Today** panel for Cora's board: a strip of the day,
  the next call as one card with a countdown, Join and Prep notes, then the rest of today and tomorrow. Before each
  call (15 minutes by default): an Inbox item with Join and Prep notes, Cora's brief (who it's with, what it's
  about, what's connected to it; spoken or written), and a standup's notes drafted from the Standup template. All of
  it in Settings › Calendar.
- **Journals that point at things.** Each journal entry keeps the tickets, merge requests, issues, explains and
  artifacts it's about, its repo and branch, and a kind (done, decision, finding, blocker). Sessions and Cora can
  search them (`journal_search`), and standup and meeting notes are drafted from them first.
- **Sessions can talk to Cora.** When you ask a session to tell Cora something, or it answers what she asked, it
  can (`tell_cora`); never on its own. Cora's messages to sessions now say they're hers. A session telling Cora
  something sends its orb to hers and back.
- **Fewer "Git sign-in needed" notes.** Cora's background fetches run one at a time (several at once raced Git
  Credential Manager's refresh of a GitLab sign-in) and try once more before saying anything.
- **Closing a shell no longer takes every terminal with it.** A second kill of the same terminal could crash the
  terminal host; a terminal is now ended once, ever. When a host does go away, its logs are kept (ptyhost.prev.log).
- **No more console hosts left behind.** Each terminal that exited used to leave a Windows console host running
  (about 8 MB each); terminals now use their own console, which goes with them. A session's shells close when the
  session really ends.
- **Slack messages from sessions look like theirs.** A session's message carries a small banner in its own colour,
  with its orb and its icon (and never anything private); Cora's says just CORA. If the banner can't be drawn, a
  still orb is used instead. Replies in a DM thread stay in that thread.

## 0.1.17

- **A new left nav.** Drag its edge to make it wider or narrower (240 to 440px, 300 to start, kept per device;
  double-click for the default). Session rows are calmer and line up: each session's colour as a swatch holding its
  own icon, a word for its state only when something's happening (working and for how long, needs you, done,
  speaking), its ticket in a column of its own, the repo's folder (and worktree), and its pipeline only when it's
  running or failed.
- **Sessions pick their own icon** when they're named, from a few hundred, and names come in Title Case. Change an
  icon with right-click › Icon. Open sessions from before get one shortly after Cora starts.
- **No more GitLab sign-in pop-ups.** Cora's background fetch never opens a sign-in window. When Git's saved sign-in
  runs out you get one note in the Inbox, with a Sign in button, and it clears itself once it works.
- **Finding a past session sees inside them.** Ask Claude gets where what you describe was said, each session's recap,
  and Cora's own conversations by name; the search reads what came late in a long session too.
- **Long prompts.** The composer takes up to a million characters, as Claude Code does.
- **Debriefs in long sessions work.** A session's transcript can outgrow what one string holds; it's read a piece at a
  time now.
- **Debrief videos can show pictures.** A step can carry a screenshot or a short clip, pushed in toward the part it's
  about: a tour of a feature, not just code.

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
