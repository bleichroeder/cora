# Security and privacy

Cora runs entirely on your PC. It has no account, no cloud service of its own and no telemetry. What it learns about
your sessions stays in a folder in your Windows user profile, and it talks to other services only when you've connected
them, directly and with your own sign-in. This page explains what Cora keeps and where, how it protects your
sign-ins, what Claude sessions can and can't do through it, and how to remove it.

## What stays on your PC

Everything Cora keeps stays on your PC: your sessions and their events, your settings, notes, the Inbox, and your
sign-ins.

- **Cora listens on your own PC only** (`127.0.0.1`, port 4317). Nothing on your network, or the internet, can
  connect to it.
- **The dashboard needs a key.** Even on your PC, Cora's pages open only with Cora's sign-in key. Other web pages you
  open (a local dev server, say) can't read Cora's live stream or press its buttons.
- **The desktop app only talks to a real Cora.** Before it hands over any key, it asks whatever answers on Cora's port
  to prove it knows Cora's key, without the key ever crossing the wire. If something else answers, the app says so and
  stops.

### What leaves your PC, and when

Cora sends nothing anywhere by itself. These are the only places your data goes, each because you connected it:

| Where | What goes there | When |
|---|---|---|
| **Anthropic, through Claude Code** | Your sessions, as always. Cora's agent and the short jobs Cora runs (naming a session, drafting a note) are Claude Code sessions too, on your own Claude sign-in. | When they run |
| **Slack** | Searches, reads, and messages you send or allowed | With Slack connected |
| **Google** | Mail reads and drafts | With Gmail connected |
| **Your Jira site** | Ticket lookups, through your sign-in in Cora's browser | With Jira in use |
| **Your GitLab** | Pipeline and project reads, through `glab` | With `glab` signed in |
| **Your clusters** | Reads through `kubectl`, and the dev bumps you click | With Deploys in use |
| **ElevenLabs** | Text to read aloud, and your voice while you talk to Cora | With voice set up. "Hey Cora" listens on your PC only. |
| **Cora's releases** | A check for a new version | A little after Cora starts, then every 6 hours |

Your Chrome and Edge bookmarks and history are read on your PC for the browser's suggestions, and never sent anywhere.

## Where things are kept

Cora's data folder is `~/.cora` (`%USERPROFILE%\.cora`):

| What | Kept |
|---|---|
| Sessions and their events (`brain.db`) | 7 days by default; change it in **Settings › Data** |
| Settings (`config.json`) | Until you change them |
| Notes (`notes\`) | Until you delete them |
| Cora's Inbox (`inbox.json`) | 14 days |
| Your sign-ins for Slack, Google and ElevenLabs | Encrypted; see below |
| Cora's own keys (`token`, `ui-token` and others) | For as long as Cora is installed |
| Files you pasted or dropped into prompts (`attachments\`) | 14 days |
| Logs, and the permission log (`audit.log`) | Until you delete them |

The full list is in the [Reference](reference.md#where-cora-keeps-things).

Two other places hold Cora's things:

- **`~/.claude/settings.json`** holds Cora's hooks (see [The hooks Cora adds](#the-hooks-cora-adds)). Cora also reads
  Claude Code's transcripts in `~/.claude/projects`, and never changes them.
- **Cora's browser profile** (`%APPDATA%\Cora`), like any browser's, keeps your open tabs and the sites you've signed
  in to.

Cora writes its files whole, beside the old one and then swapped in, so a crash or a power cut mid-save can't leave a
half-written file behind. If `config.json` is ever damaged, Cora keeps every setting it can still read, sets the
damaged file aside, and never overwrites your settings with defaults.

## How secrets are kept

- **Your Slack, Google and ElevenLabs sign-ins are encrypted** (AES-256) with a key that Windows itself protects for
  your user. A copy of `~/.cora` (in a backup, a synced folder, an upload) is useless on another PC or to another
  Windows user. Like any app's secrets, they can't be hidden from programs running as you.
- **Cora's own keys** stay as plain files in `~/.cora`, because Claude Code has to read the hooks' key. Cora never
  prints its sign-in link into a log.
- **Jira, GitLab and your clusters need no secret from Cora.** Jira uses your sign-in in Cora's browser; GitLab uses
  `glab`'s own sign-in; clusters use your kubeconfigs, as they are.
- **Passwords from 1Password are never stored, and never seen by a session.** A password or code exists only inside
  Cora's desktop app, for the moment between 1Password handing it over and the page that asked. It never reaches Cora's
  server, its database, its logs, its dashboard, Cora's agent or any Claude session. Cora keeps only the list of logins
  (titles, usernames and websites, no passwords), and only for a minute.
- **A login is filled only where you asked.** Only into a web page in Cora's browser or Tools, never into Cora's own
  dashboard. And only if the page is still on the site that login is for: one that has moved elsewhere in the meantime
  gets nothing.

## What Claude sessions can and can't reach

Sessions you start or resume in Cora get a few of Cora's tools, so they can work with your day. They act with the same
limits you'd want from a colleague.

| A session can | It can't |
|---|---|
| Open a page in its own tabs in Cora's browser (see below) | See what's on the page afterwards, through Cora |
| Ask which environment is reachable, and what runs where | Bump, deploy or change a cluster through Cora |
| Read your notes, and add to them | Change or delete what's in your notes |
| Find, read and search Slack; write a message | Send it: you do that, from its draft |
| Watch a Slack thread for a reply | Watch it forever: one reply, or a few days at most |
| Read and search your mail; write a draft; wait for an email | Send an email |
| Attach your files to a Slack message | Attach anything from `~/.cora` or `~/.claude` |

Sessions can't act as Cora. Cora's own tools (starting, messaging and ending sessions, answering prompts, messaging
you) need Cora's own key, which only Cora's agent has. Knowing Cora's session ID isn't enough.

**Pages sessions open.** A session opening a page can't send your data out in the address, or trigger something on a
site you're signed in to, without you noticing. Sites you plainly use open straight away: your GitLab and Jira, GitHub,
your Tools, and sites you've said yes to. Any other site waits for you to choose **Open** or **Not now**. A request
that's refused opens nothing.

**Cora's agent** gets a view-only key to the dashboard, so it can look at it (to take a screenshot for you, say).
Nothing it opens can press a button: it can't approve its own cards, turn on away mode or change its own rules. It
never sees your sign-in.

**Cora's windows** can use your microphone, the clipboard and notifications for Cora's own page only. In Cora's
browser, only your Tools may use notifications, the microphone, the camera or screen sharing. Links leave Cora only as
web or mail addresses, and the developer tools are off.

## Other people's words

Cora reads a lot that other people wrote: Slack messages, email, Jira comments, ticket descriptions, web pages. It treats
all of it as information, never as instructions.

- **Quoted, and marked as someone else's.** When a session or Cora reads Slack, email or Jira, the text comes back
  quoted, with a note that it's information from someone else, whatever it claims (urgent, from you, from Cora, from
  an admin). Nothing inside the quote can close it early and pass itself off as Cora.
- **A ticket's description is someone else's words.** When a session starts from a ticket, its description is handed
  over as information about the work.
- **Sessions Cora starts on its own open in plan mode.** A session started on its own for a ticket assigned to you
  can read and plan, but changes nothing until you approve its plan.
- **Alerts about new email and Jira activity say only which and from whom.** Cora hears that a message came, never
  what it says, so a message can't steer Cora's next turn.
- **Someone else's turn can't act.** When someone else's message starts a turn for Cora (a reply in a thread it
  watches, a conversation you let it carry on), Cora can read and reply in that conversation. It can't start, message
  or end sessions, answer prompts, open pages, fetch from the web, write to your notes or set email watches. It tells
  you what they asked.
- **Email watches check the sender.** An email must come from the address or domain you named, and pass Gmail's own
  sender check, before anything is done with it.

More in [Cora, the assistant](cora.md#other-peoples-words).

## Autopilot, in brief

When you give Cora a goal, or turn on away mode, fixed rules answer your sessions' permission prompts: never Cora's own
judgement, and never the words of a ticket or a message. In the folders you allow, the rules let through ordinary
work (reading, editing inside the repo, tests and builds, commits and feature-branch pushes). Merges, deploys,
publishing, sending data out, writing outside the repo, and any command that hides another one come to you. Some
things are never allowed in any mode: force-pushing, pushing to the default branch, deleting branches, dropping
databases. With no folders allowed, everything comes to you.

The full rules are in [The rules for what Cora may approve](cora.md#the-rules-for-what-cora-may-approve).

## The hooks Cora adds

Claude Code tells Cora what's happening through hooks: a few lines in `~/.claude/settings.json` that send each event
to Cora on your own PC.

- **What they do.** Most only report: a prompt sent, a tool used, a session started or ended. Two wait for an answer:
  permission prompts, and forms that MCP servers show. Those are answered in Cora, or handed back to the terminal after
  two minutes (up to an hour for a prompt sent to your phone).
- **Written with your OK.** Setup shows you the change before writing it. Your own hooks stay as they are.
- **Backed up first.** Cora copies your settings to `settings.json.cora-backup-<date and time>` beside the file. Only
  the newest backup is kept, because each one holds Cora's hooks key.
- **Left alone if it's broken.** If `~/.claude/settings.json` can't be read, Cora says what's wrong and never writes
  to it.
- **Checked against this Cora.** Setup counts the hooks as installed only when they reach this Cora, with its port and
  its key. Hooks aimed at another copy of Cora, or carrying an old key, show as such, and **Install** puts in this
  one's.
- **Harmless when Cora is off.** Sessions carry on normally. You may see a one-line message when a session exits.

## Permission decisions are logged

Every permission decision goes into `~/.cora/audit.log`: when, which session, which tool, what was decided, and how
(in Cora, in the terminal, timed out, or by Cora's rules, with the rule's name). A tool's input (the command, the file,
the edit) is never written there, only a fingerprint of it, so the log shows what happened without holding your code.

## Updates

New versions download in the background and install when you choose **Restart to update** (or the next time Cora
quits). Sessions running in Cora keep running through an update. Cora's installer isn't code-signed yet, so Windows may
warn you the first time you run it; see [Getting started](getting-started.md#install).

## Removing Cora

1. **Uninstall Cora** from Windows' **Settings › Apps**, like any app. This removes the app. It leaves your data in
   `~/.cora` and Cora's browser profile in `%APPDATA%\Cora`, in case you come back.
2. **Take the hooks out of Claude Code.** Uninstalling doesn't touch `~/.claude/settings.json`. Run `cora uninstall`
   from a source checkout (`npm run cora -- uninstall`), which removes only Cora's hooks. Or delete the entries that
   point at `http://127.0.0.1:4317/hook/…` yourself.
3. **Delete your data**, if you want it gone: the `~/.cora` folder and `%APPDATA%\Cora`.
4. **Disconnect services** you no longer want Cora to reach. Disconnecting Gmail in Cora also removes its access at
   Google. Your Slack app stays in your workspace until you remove it at api.slack.com/apps. In 1Password, you can turn
   off **Integrate with 1Password CLI**.

## Good to know

- **Programs running as you can read what you can.** Encryption protects a copy of `~/.cora` on another PC, not on
  yours. Treat your Windows account as the boundary, as you would for your browser or your SSH keys.
- **Logs aren't trimmed for you.** `server.log`, `audit.log` and the other logs in `~/.cora` grow over time. You can
  delete them while Cora is closed.
- **Sessions in other terminals** don't get Cora's tools. Cora only watches them, through the hooks and their
  transcripts.
- **Your sign-ins in Cora's browser** are shared by every session's tabs and your Tools. Sign out there as you would in
  any browser.
- How each integration works, and what it needs, is in [Integrations](integrations.md).
