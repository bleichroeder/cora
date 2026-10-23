# Getting started

Cora is a desktop app for Windows that sits alongside Claude Code. This page takes you from the installer to your first
session: what Cora needs, what Setup does for you, and how updates arrive.

## What you need

- **Windows 10 or 11.** There's no macOS or Linux version yet. Claude Code sessions running inside WSL aren't seen:
  Cora follows the Claude Code installed on Windows.
- **Claude Code**, installed and signed in. If you don't have it yet, Setup tells you how; Cora finds it on its own once
  it's there.
- Nothing else is required. Every other feature (Cora's agent, voice, Slack, Gmail, Jira, pipelines, deploys,
  1Password) is optional, and Setup lists what each one needs.

## Install

1. Run **`Cora-Setup-<version>.exe`**. It installs for your Windows user only, so it doesn't ask for admin rights.
2. The installer isn't code-signed yet, so Windows SmartScreen may stop it the first time. Choose **More info**, then
   **Run anyway**.
3. Cora starts when the installer finishes, and adds **Cora** to the Start menu.

While Cora starts, a splash screen shows what's starting (the terminal host, reading your recent transcripts,
connecting) and how long it usually takes. If something fails, the splash offers **Retry**, starting without hosted
terminals, and the log.

## Setup

The first time Cora starts, it opens **Let's set Cora up**: a checklist of everything Cora can do, with a status for
each.

**Two things are required:**

| | What it is | How it's done |
|---|---|---|
| **Claude Code** | Claude Code installed, and signed in | Cora finds it; signing in opens Claude Code in a window for you |
| **Cora's hooks in Claude Code** | A few lines in `~/.claude/settings.json` so Claude Code tells Cora about tool calls and permission prompts as they happen | One click, with your OK. Your settings are backed up first, and your own hooks stay as they are |

Without the hooks Cora still shows your sessions from their transcripts, but tool calls arrive a little later and
permission prompts stay in the terminal.

**Everything else is a feature you can set up now or later**, from **Settings › Setup**:

| Feature | What it gives you |
|---|---|
| **Cora's agent** | The assistant: briefs, approvals, goals, Slack and email for you ([Cora](cora.md)) |
| **Pipelines and deploys** | Your sessions' GitLab pipelines, and what each environment runs |
| **Environments** | Which of your clusters this PC can reach |
| **Jira** | Ticket chips, watching your tickets, starting sessions from them |
| **Voice** | Talk to Cora and hear it answer ([Voice](voice.md)) |
| **Slack** | Read and send as you; Cora's bot on your phone while you're away |
| **Gmail** | Mail rules, email watches, drafts |
| **Screenshots for Slack** | Cora's agent can show what's on screen |
| **1Password** | Your logins filled into Cora's browser |

Each feature lists its steps and who does each one:

- **Cora does it** — nothing for you to do.
- **Cora, with your OK** — a command (an install with `winget`, a sign-in) that runs in a PowerShell window you can
  watch and answer.
- **You do it** — a few steps to follow, with a button to the right settings page.

When the two required items are ready, choose **Open Cora**. You can skip them with **Open Cora without them**, and come
back any time from **Settings › Setup**.

## Your first session

1. Choose **New** at the top of the left nav (or press `Ctrl+K` and type "new").
2. Pick a folder: the project you want Claude to work in. Recent folders are listed; you can browse for others.
3. Optionally pick a model, effort and permission mode, then start.

Claude Code starts in a terminal inside Cora. The middle of the window shows the session's scene, the right column its
transcript, and the bottom strip its timeline. Type your first prompt in the composer under the terminal.

Sessions you started in your own terminals appear too: Cora reads their transcripts, and with the hooks installed, it
follows them live. You can bring any of them into Cora with **Resume**. See [Sessions](sessions.md).

## Updates

New versions download in the background. When one is ready, **Restart to update** appears at the bottom of the left
nav (and in the tray menu). Cora restarts on the new version; sessions running in Cora keep running and reconnect.
**Settings › Updates & security** shows the version you're on and the latest release.

## The window and the tray

- Closing the window hides Cora to the tray; it keeps working. `Ctrl+Alt+B` shows or hides it from anywhere.
- The tray menu has **New session…**, **Start at login** and **Quit**. Quitting with sessions running asks whether to
  keep them running in the background or end them.
- The tray and taskbar icons turn red when a session needs you.

## Good to know

- Cora only listens on your own PC (`127.0.0.1`), and keeps its data in `%USERPROFILE%\.cora`. See
  [Security and privacy](security-and-privacy.md).
- If Setup says the hooks point at another Cora, you have a second copy running (a test install, say) that owns
  them. **Install** puts in this Cora's.
- Uninstalling Cora leaves `%USERPROFILE%\.cora` and its hooks in place. To take the hooks out of Claude Code, run
  `cora uninstall` from a source checkout, or delete the entries that point at `http://127.0.0.1:4317/hook/…` from
  `~/.claude/settings.json` ([Reference](reference.md)).
