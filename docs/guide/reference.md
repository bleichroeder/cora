# Reference

Shortcuts, settings, files and the command line in one place, and what to do when something isn't right.

## Keyboard shortcuts

### Anywhere in Windows

| Keys | What it does |
|---|---|
| `Ctrl+Alt+B` | Show or hide Cora |
| `Ctrl+Alt+N` | Quick capture: a note to Scratch from anywhere |
| `Ctrl+Alt+Space` | Talk to Cora |
| `Ctrl+Alt+Backspace` | Stand Cora down (stops its goal, away mode and conversations) |

### In Cora

| Keys | What it does |
|---|---|
| `Ctrl+K` | Command palette: sessions, older transcripts, folders, notes, explains, settings, commands |
| `G` | Overview (all sessions); `Esc` goes back |
| `Ctrl+Shift+Space` (hold) | Push to talk to the session you're looking at |
| `Ctrl+Space` (hold) | Talk to Cora |
| `Ctrl+Shift+Enter` | Cora's command mode |
| `Ctrl+Shift+N` | Notes |
| `Ctrl+Shift+B` | Browser (Cora's own, not tied to a session) |
| `Ctrl+1` … `Ctrl+9` | Open or close your Tools, in order |
| `` Ctrl+Shift+` `` | A new shell tab beside the session |
| `Ctrl+F` | Find a setting (in Settings), or find in the page (in the browser) |

### In the composer and terminal

| Keys | What it does |
|---|---|
| `Enter` or `Ctrl+Enter` | Send (you choose which in **Settings › Terminal**) |
| `↑` / `↓` | Your earlier prompts |
| `Esc` | Interrupt Claude (what you've written stays) |
| `Alt+V` | Paste an image |
| `Ctrl+C` / `Ctrl+V` | In the terminal: copy (with text selected; otherwise it interrupts) / paste |
| `Ctrl+Shift+C` | In the terminal: always copy |

### In the browser

| Keys | What it does |
|---|---|
| `Ctrl+T` / `Ctrl+W` | New tab / close tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+L` | The address bar |
| `Ctrl+F` | Find in the page (also in Tools: in the drawer and in their own windows) |
| `Ctrl+\` | Fill a login from 1Password (or click the key in the login field) |
| `Ctrl+click` a link | Open it in your usual browser |

## Settings

**Cora:** Setup · Cora Orchestrator · Voice
**Sessions:** Sessions · Explains · Terminal · Notifications
**Connected:** Jira · Slack · Gmail · 1Password · Tools
**This machine:** Environments · Scene · Security · Data

`Ctrl+F` in Settings searches every page. Settings are kept in `%USERPROFILE%\.cora\config.json`; if that file is ever
damaged, Cora keeps a copy beside it and starts with what it could read.

## Where Cora keeps things

Everything is in `%USERPROFILE%\.cora`:

| | |
|---|---|
| `brain.db` | Sessions and their events (kept 7 days by default: **Settings › Data**) |
| `config.json` | Your settings |
| `token`, `ui-token`, `view-token`, `agent-token`, `host-token` | Cora's own keys: for Claude Code's hooks, the dashboard, Cora's agent and the terminal host |
| `secrets.key` | The key your saved sign-ins are encrypted with, itself protected by Windows for your user |
| `slack*.json`, `gmail.json`, `google-client.json`, `elevenlabs.json` | Your sign-ins, encrypted |
| `notes\` | Your notes |
| `inbox.json` | Cora's Inbox |
| `attachments\` | Files you dropped into prompts |
| `orchestrator\` | Cora's agent: its memory, goals and settings |
| `server.log`, `desktop.log`, `ptyhost.log` | Logs |
| `audit.log` | Every permission decision (tool inputs stored only as hashes) |

Cora also adds its hooks to `~/.claude/settings.json` (with a backup beside it) and reads Claude Code's transcripts in
`~/.claude/projects`.

## The command line (from a source checkout)

| Command | What it does |
|---|---|
| `npm run cora -- start` | Start the server (the desktop app does this for you) |
| `npm run cora -- start --sim` | Simulated sessions, for trying the UI |
| `npm run cora -- install` | Add Cora's hooks to `~/.claude/settings.json` (shows the change, backs it up) |
| `npm run cora -- uninstall` | Remove only Cora's hooks |
| `npm run cora -- replay <session.jsonl>` | Play a transcript back |

## Troubleshooting

**A session shows as Idle while I'm talking to it.** Idle means Claude has finished its turn and is waiting for you.
It's Working while Claude is busy, and Needs you when a permission prompt or question is waiting.

**Tool calls arrive late, and permission prompts stay in the terminal.** The hooks aren't installed, or they point at
another copy of Cora. **Settings › Setup** says which, and **Install** fixes it.

**"Something else is answering on port 4317".** Another program, or an older Cora you started yourself from a
terminal, is using Cora's port. Close it and start Cora again.

**Claude Code isn't found.** Install it (Setup links to it). Cora looks for it again each time it starts a session; no
restart needed.

**Slack, Gmail or ElevenLabs asks you to connect again.** Your sign-ins are encrypted for your Windows user on this PC.
A new PC or a new Windows profile can't open them: connect again in Settings.

**A sign-in page doesn't work in Cora's browser.** Some sites turn away embedded browsers. Use the address bar's
**Open in your browser** button, or `Ctrl+click` the link.

**Something else.** The logs are in `%USERPROFILE%\.cora`: `desktop.log` for the app, `server.log` for Cora's server,
`ptyhost.log` for the terminal host. The splash's **Open log** button opens the server's.
