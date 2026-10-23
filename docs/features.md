# Cora: feature inventory

Everything Cora does as of 2026-10-20 (build/v1), grouped the way a user meets it. Each feature says how you reach it,
what it needs, and its state: **done**, **partial** (works, with gaps listed in [the audit](audit-2026-10-20.md)) or
**dev only**. The audit's gaps are fixed on the build branch (see its Status), so nothing is marked partial now. This is
the source for the user docs; the code paths are for maintainers.

Paths are under `packages/`.

---

## 1. Sessions

| Feature | What you get | How you reach it | State |
|---|---|---|---|
| **Session list** | Every Claude Code session on this PC, from Cora or any terminal: Working (and Needs you), Idle and Ended groups with counts; Ended shows the last hour ("+ N older" for the rest). A red count jumps to what needs you; "fresh" marks sessions that finished while you were away. Order is yours (drag, or Move up/down); nothing reshuffles by itself. | Left nav | done |
| **Session row** | Colour tile with a state corner, name (alias, ticket, auto name, title or folder), short folder, Jira chip, pipeline glyph; rings for "Cora started this". | Left nav | done |
| **Rename, colour, suggest a name** | Right-click a row: name, "Suggest a name" (Haiku), colour, Move up/down, "Not about KEY", Remove from the list, End session. Optional automatic names from the first prompt. | Right-click; Settings › Sessions | done |
| **Dismiss and clear** | × on an ended session hides it until it's active again; "clear" hides all ended ones; "N dismissed · show". | Left nav | done |
| **End a session** | Ends it where it runs: Ctrl+C twice in Cora's terminal, or the external process; offers "Remove from the list" when it isn't running. | × on a live row; right-click | done |
| **New session** | Folder (browsable, recent ones), model, effort, permission mode, one-click starters; or **from a Jira ticket** (your open issues, or a pasted key/link); or with a first message (from the Inbox). | New (nav), Ctrl+K, tray | done |
| **Resume and fork** | The newest 500 transcripts, by day; search titles, folders and what was said (every transcript), or describe it and Ask Claude (it picks from the newest 300); resume (hosted in Cora) or fork a copy. A session started in another terminal can be resumed or forked from its panel. | Resume (nav); the session's terminal area | done |
| **Command palette** | One search over sessions, older transcripts, starters, folders, explains, notes, transcript text and commands (settings pages, overview, voice, browser, tools…). | Ctrl+K | done |
| **Session header** | State, background commands, a context meter (with compactions and model), the ticket card, the pipeline strip, the deploy journey, the email-watch chip, the browser toggle, and Jump (to an external terminal window). | Top of a session | done |
| **Hosted terminal** | Claude Code runs inside Cora; it keeps running when Cora restarts or updates. Paste, copy, images (Alt+V), an input-only compact view. | A session started or resumed in Cora | done |
| **Composer** | Write prompts in a text box: Enter or Ctrl+Enter sends, ↑/↓ history, drafts kept, Esc interrupts Claude and keeps your draft, `/` commands (built-ins and your skills), pasted or dropped files and screenshots. Claude's terminal appears by itself when it asks you something. | Under a hosted session; Settings › Terminal | done |
| **Shell tabs** | Shells next to a session's Claude, in its folder: PowerShell, Command Prompt, Git Bash, WSL distros. Named by what runs; they survive restarts. | + beside the Claude tab; Ctrl+Shift+\` | done |
| **Permission prompts** | Allow, allow with changes, deny with a reason, or hand back to the terminal; Edit/Write show a diff; held 2 minutes; every decision is logged. Questions (AskUserQuestion) too: several answers where Claude allows it, and "Other…" for your own words. MCP forms check their required fields. | The Needs you card; toasts | done |
| **Notifications** | Needs you, finished, new explain, pipeline finished (each can be turned off); a taskbar badge. | Desktop app; Settings › Notifications | done |

## 2. Seeing what a session does

| Feature | What you get | How you reach it | State |
|---|---|---|---|
| **3D scene** | The main agent and its subagents as orbs; the files, folders, web and shell they use as planets with droplets; tool calls as flowing tubes; Anthropic's orb; waiting beacons; speech bubbles; explains rising into pills. Click to focus and filter. | The middle of a session | done |
| **Star systems** | A procedural planetary backdrop; jump to hyperspace for a new one. | Settings › Scene; the corner button | done |
| **Transcript** | Steps per agent: prompts, replies (markdown, copy, read aloud), thinking, tool rows (expand for full input and result, secrets masked), subagent reports, compactions, turn ends; filters per agent; search. | Right column, Transcript tab | done |
| **Live activity** | What each agent is doing right now, and what it's waiting on. | Under the transcript | done |
| **Tasks** | Claude's task list as it works, with progress. | Above the transcript | done |
| **Timeline** | Lanes per agent, markers (needs you, failures, prompts, edits, explains, pipelines); scrub to rewind the whole view. A long session loads only its newest events: History, at the timeline's left, loads the ones before. | Bottom strip | done |
| **Explains** | Documents Claude writes instead of long terminal text (markdown, or interactive HTML in a sandbox): a viewer, full window, pop out, a list per session or all. | Explains tab; they open by themselves; Settings › Explains | done |
| **Changes and diff review** | Per turn, the files Claude changed, plus uncommitted git; diffs (unified or split), step through edits, follow live, open in VS Code, ask Claude about a hunk, copy the patch. | Changes tab; "review" | done |
| **Overview** | All sessions as a grid of cards, a galaxy of stars, or the deploys board; today's and the week's token use. | G; Overview (nav) | done |

## 3. Cora, the assistant

| Feature | What you get | How you reach it | State |
|---|---|---|---|
| **Cora's agent** | A Claude Code session of its own that sees every session, pipeline, ticket, Slack message and email, and acts with its own tools: start, resume, message, ask and end sessions; answer and decide prompts within limits; focus the UI; Slack and email; notes; remember things. It asks before acting, except where you've said it may. | Settings › Cora Orchestrator › Turn on | done |
| **Bridge card** | Cora's lens and state, your sessions orbiting it, its latest words, Talk / Brief / Goal. | Top of the nav | done |
| **Console and command mode** | Talk to Cora by typing or voice; its cards (start, send, end, questions); goals; conversations with sessions. Command mode is the full-screen version. | Click the lens; Ctrl+Shift+Enter | done |
| **Approvals** | Every action that needs your OK is a card you can edit, approve or refuse; a later OK still runs it. Cards are kept across a restart (ones that can't be are listed in the Inbox). | Console, floating card, phone | done |
| **Goals (autopilot)** | Give Cora a goal and a token budget: it starts and directs sessions in the repos you allow; their prompts are answered by fixed rules (the mandate); over budget it stops. | Goal (bridge) | done |
| **Away mode** | While you're away the mandate answers every session's prompts. | Console: Away | done |
| **Stand down** | Stops the goal, away mode and conversations at once. | Console button; "stand down"; Ctrl+Alt+Backspace | done |
| **Briefs** | "Welcome back" after a while away; Brief me; Wrap up the day. | Bridge, console | done |
| **What Cora hears** | Important events (failures, long waits, stalls, Jira, email, network changes) typed into Cora between your turns. | Settings › Cora Orchestrator | done |
| **Starting work from Jira** | A ticket assigned to you: Cora tells you, offers to start it (a card with a folder), or starts it and stops at a plan. | Settings › Jira | done |
| **Instructions and memory** | Your standing instructions; what Cora remembers (editable, forgettable). | Settings › Cora Orchestrator | done |
| **Cora's Slack bot** | While you're away: prompts with Allow/Deny on your phone, failures, assignments, watched email, finished sessions; quiet hours and a daily cap; talk to Cora in that DM. | Settings › Slack › Cora's own bot | done |

## 4. Voice

| Feature | What you get | How you reach it | State |
|---|---|---|---|
| **Push-to-talk** | Speak a prompt to a session (review it or send at once). | Hold Ctrl+Shift+Space, or the mic | done |
| **Talk to Cora** | Hands-free conversation with Cora; a quick spoken line while it thinks. | Ctrl+Space (hold), Talk, Ctrl+Alt+Space anywhere | done |
| **"Hey Cora"** | A wake word that runs on this PC, then hands-free. | Settings › Voice | done |
| **Read aloud** | Short summaries or full replies, per-reply speaker buttons, announcements (permission needed, task finished, failures, pipelines). | Settings › Voice; the speaker toggle | done |
| **Voices and pronunciation** | ElevenLabs voices (Cora's own too), model, pace, direction, style, word swaps. | Settings › Voice | done |

Voice needs an ElevenLabs key.

## 5. Work integrations

| Feature | What you get | Needs | State |
|---|---|---|---|
| **Jira tickets** | Keys become chips with status and a hover card; a session's ticket card (status, assignee, where it's discussed in Slack). | Desktop app; signed in to Jira in Cora's browser | done |
| **Jira watch** | Assignments, mentions, comments, status changes and watched tickets, each at the level you choose (off / quiet / notify / say). | Same | done |
| **Ticket sessions** | Start a session from a ticket with your own `/jira` command or Cora's ticket prompt. | Same | done |
| **Slack as you** | Sessions and Cora find, read and search Slack; their messages wait for your OK (Cora's go out with undo when you asked), and drafts waiting for you are kept across a restart; messages Cora sends for you end with a sign-off (`:cora:` by default; Settings › Slack › Sign Cora's messages); watch a thread for a reply (Settings › Slack lists the threads being watched, for which session and until when, and stops one); let Cora carry on a conversation for a while. | Your Slack app (Cora makes it in one click) | done |
| **Gmail** | Rules for what Cora watches; drafts (never sends); email watches ("when X writes about Y, do Z"), sender-checked. | Your own Google app | done |
| **GitLab pipelines** | Each session's pipelines, stages and jobs, failed job logs; a ping when one finishes. | glab, signed in | done |
| **Deploys** | What each environment runs, newest builds, a ticket's journey from MR to prod; dev bumps (the only write: `kubectl set image` on dev). Each environment is reached through its own kubeconfig context, checked before a bump (a mismatch refuses it); the bump card shows the cluster. | kubectl, kubeconfigs, VPN | done |
| **Environments** | Which clusters this PC can reach, checked every 30 s; sessions are told when it changes. Labels are guessed prod before dev; labelling a cluster dev asks first. | kubeconfigs; Settings › Environments | done |
| **Cora's Inbox** | Everything Cora told you, 14 days: Jira, Slack (DMs, mentions, watched threads, channels you follow), email, GitLab, Cora's own actions; reply, ask Cora, start a session, open it. Open goes to your Tool for that site, else a window of its own (never the focused session's browser). Answering in Slack itself marks the item read. A session started from an email is told to read the whole of it with `gmail_read`. | Any of the above | done |
| **Notes** | Scratch and named notes; sessions can add (never change); templates; Cora drafts a standup or summary from your work; quick capture from anywhere. | — | done |
| **Built-in browser** | Tabs per session, signed in to your sites. Address-bar suggestions from your Chrome and Edge bookmarks and history, and your bookmarks bar on a new tab (read on this PC, never sent; Settings › Tools turns it off). Sessions can open pages in it: your own sites open at once, a site Cora doesn't know yet waits for Open or Not now. | Desktop app | done |
| **Tools drawer** | Web apps (Slack…) kept open beside your sessions, with unread counts, tints, tags and folders. | Desktop app | done |
| **1Password** | Your 1Password logins in Cora's browser: on a login form, the key button in the address bar (or `Ctrl+\`) opens a menu of the logins for that site, matched by their saved URL, and a search for others; pick one to fill it (one-time codes too). `Ctrl+\` works in Tools as well. Filled through 1Password's `op` command line, which the 1Password app unlocks with Windows Hello. Cora never stores a password; sessions and Cora's agent never get one. | Desktop app; the 1Password app and `op`, connected; Settings › 1Password | done |

### Tools sessions get (MCP)

Every hosted session: `open_tab`, `spotlight`, `environment`, `deploys`, `notes_list/search/read/add`, `slack_find/read/search/send/watch/inbox`,
`gmail_inbox/search/read/draft/watch/watches/unwatch`, `speak`. Cora also gets: `sessions`, `session`, `pending`,
`pipelines`, `explains`, `security`, `start_session`, `resume_session`, `send_to_session`, `ask_session`, `ask_copy`,
`end_session`, `rename_session`, `focus`, `open_url`, `open_tool`, `show_explain`, `jira_inbox`, `jira_start`, `notify`,
`cora_dm`, `goal_update`, `escalate`, `decide`, `answer_question`, `remember`, `slack_allow`.

## 6. The desktop app

| Feature | What you get | How you reach it | State |
|---|---|---|---|
| **Window and tray** | A frameless window that hides to the tray; tray menu (show, new session, start at login, update, quit); the icon turns red when something needs you. | — | done |
| **Global hotkeys** | Ctrl+Alt+B show/hide; Ctrl+Alt+N quick capture; Ctrl+Alt+Space talk to Cora; Ctrl+Alt+Backspace stand Cora down. | Anywhere | done |
| **Quick capture** | A small box from anywhere: Enter saves to Scratch, Tab picks a note. | Ctrl+Alt+N | done |
| **Splash** | The startup screen with what's starting and how long it usually takes; retry or start without the terminal host on failure. | Start Cora | done |
| **Quitting** | With sessions running: keep them running in the background, or end them. | Tray › Quit | done |
| **Cora's colour** | Eight colours for Cora's eye, cards and the app icon. | Settings › Cora Orchestrator | done |

## 7. Install, setup and updates

| Feature | What you get | How you reach it | State |
|---|---|---|---|
| **Installer** | A per-user Windows installer (no admin); no Node or repo needed. Unsigned for now: Windows warns on first run. | `Cora-Setup-<version>.exe` | done |
| **Updates** | New versions download in the background; Restart to update; sessions keep running. | Nav footer, tray | done |
| **First-run setup** | A checklist: Claude Code and the hooks (required), then each optional feature (Cora's agent, pipelines and deploys, environments, Jira, voice, Slack, Gmail, screenshots for Slack, 1Password): status, what it needs, and who does it (Cora, Cora with your OK in a window you watch, or you with steps). | First start; Settings › Setup | done |
| **Security check** | Electron, Node and npm packages: supported, patched, audited; "Ask Claude to fix it". In the installed app the page says these fixes come with Cora's updates. | Settings › Security | dev only |
| **CLI** | `cora start` (with `--sim`, `--no-host`…), `cora install` / `uninstall` (the hooks, with a diff and backup), `cora replay`. Only in a source checkout (`npm run cora -- …`), not in installed builds. | A terminal (dev) | dev only |

## 8. Settings pages

Setup · Cora Orchestrator · Voice · Sessions · Explains · Terminal · Notifications · Jira · Slack · Gmail · 1Password ·
Tools · Environments · Scene · Security · Data. "Find a setting" (Ctrl+F) searches all of them.

## 9. Where Cora keeps things

`~/.cora`: the database (sessions and events, kept 7 days by default), settings (`config.json`), tokens and keys for
Slack, Gmail, ElevenLabs and Cora's own, notes, the Inbox, attachments, logs, and the terminal host's runtime. Cora adds
HTTP hooks to `~/.claude/settings.json` (backed up first) and reads Claude Code's transcripts in `~/.claude/projects`.
Uninstalling leaves `~/.cora` in place.

- **Sign-ins are sealed.** The Slack, Gmail, Google client and ElevenLabs files are encrypted with a key in
  `secrets.key`, which Windows protects for your user (DPAPI). A copy of the folder is no use on another PC or account.
  Cora's own keys stay as they are (Claude Code reads the hook key).
- **One hooks backup.** Only the newest backup of `settings.json` is kept.
- **Logs roll over.** Past their size, `server.log` (about 5 MB), `audit.log` (about 5 MB), `ptyhost.log` and
  `desktop.log` (about 1 MB each) become `<name>.1`, replacing the one before.
- **The database compacts itself.** At start, when much of `brain.db` is free room, Cora hands it back.
