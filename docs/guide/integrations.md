# Integrations

Cora connects your sessions to the rest of your working day: the Jira tickets they're about, the Slack conversations
and email around them, the pipelines they start, and the environments their changes end up in. Each integration is
optional and talks straight from your PC to the service, with your own sign-in. Nothing reaches out on your behalf
without your OK, except where you've said it may. **Settings › Setup** lists what each one needs; this page explains
what each one does.

## At a glance

| Integration | What you get | What it needs |
|---|---|---|
| [Jira](#jira) | Ticket chips, a ticket card per session, watching your tickets, sessions started from a ticket | The desktop app, and a Jira sign-in in Cora's browser |
| [Slack](#slack) | Sessions and Cora find, read, search and send as you; thread watches; Cora's bot on your phone | Your own Slack app (Cora fills it in for you) |
| [Gmail](#gmail) | Mail rules, drafts, email watches | Your own Google app |
| [GitLab pipelines](#gitlab-pipelines) | Each session's pipeline, its jobs and logs | `glab`, signed in |
| [Deploys](#deploys) | What runs where, a ticket's journey, dev bumps | `kubectl`, your kubeconfigs, `glab` |
| [Environments](#environments) | Which clusters this PC can reach right now | Your kubeconfigs |
| [Cora's Inbox](#coras-inbox) | Everything Cora told you, in one place | Any of the above |
| [Notes](#notes) | Scratch, notes, templates, quick capture | Nothing |
| [The built-in browser](#the-built-in-browser) | A browser per session, signed in to your sites | The desktop app |
| [Tools](#the-tools-drawer-and-tool-windows) | Web apps kept open beside your sessions | The desktop app |
| [1Password](#1password) | Your logins filled into Cora's browser | The 1Password app and its command line |

## Jira

Jira tells Cora which ticket each session is about, so you can see where the work stands without leaving the session.
Cora reads Jira through your own sign-in in its built-in browser. There's no API token to create, and Cora only reads.

**To set it up**, sign in to Jira once in Cora's browser. Cora finds your Jira site by itself (from that sign-in, or
from Jira links in your transcripts). You can also type it in **Settings › Jira › Site**. The **Login** row shows
whether you're signed in and which projects you can see.

### Chips and the hover card

Ticket keys (`ACME-123`) and Jira links in transcripts become **chips**: the key and the ticket's status, coloured by
how far along it is.

- **Hover** a chip for its card: the summary, status, type, priority and assignee.
- **Click** to open the ticket in the session's browser. `Ctrl+click` opens it in your usual browser.
- Signed out of Jira, the chip says **sign in**, and the card offers a button to open your Jira site and sign in.

### The ticket card

When a session is about a ticket, its header shows a **ticket card**: the key, status, type and assignee, kept up to
date every minute. Click it to open the ticket.

- A small dot means there's a new mention or comment since you last opened it.
- Beside the card, a Slack count shows how often the ticket comes up in Slack. Hover for where; click to open the
  newest conversation in your Slack Tool. (This needs Slack connected, with search.)

A session gets its ticket when you start it from one, or from its first prompt: a `/jira ACME-123` command, a Jira link,
or a key from one of your site's projects. If Cora got it wrong, right-click the session and choose **Not about
ACME-123**. See [Working with sessions](sessions.md).

### Watching Jira for you

Turn on **Settings › Jira › Watch Jira for me › Watch Jira**, and Cora checks Jira every 30 seconds (every 2 minutes
while you're away) for things you'd want to know. You choose how loudly each kind is told:

| Kind | What it is | Starts at |
|---|---|---|
| **Assigned to you** | A ticket put in your name by someone else | Notify and say it |
| **@mentions** | Someone tags you in a comment or a description | Notify and say it |
| **Comments on your tickets** | Someone else comments on a ticket that's yours | Notify |
| **Status changes on your tickets** | Someone else moves one of your tickets | Notify |
| **Tickets you watch** | Comments and moves on tickets you watch that aren't yours | Quietly |

The levels:

| Level | What happens |
|---|---|
| **Off** | Not looked for. |
| **Quietly** | It goes to [Cora's Inbox](#coras-inbox), and Cora knows about it. |
| **Notify** | That, plus a card or a Windows notification. |
| **Notify and say it** | That, plus Cora says it out loud (with [voice](voice.md) set up). |

**When a ticket is assigned to you**, Cora can just tell you, offer to start a session on it, or start one on its own
that stops at a plan. That's covered in [Starting work from Jira](cora.md#starting-work-from-jira).

### Ticket sessions

Start a session from a ticket with **New › From a Jira ticket**: pick one of your open issues, or paste a key or a Jira
link ([Working with sessions](sessions.md#from-a-jira-ticket)). How it begins is set in **Settings › Jira › Start
ticket sessions with**:

| Choice | How the session starts |
|---|---|
| **Auto** | Your own `/jira` command when you have one, otherwise Cora's prompt |
| **Cora's prompt** | Cora writes the first prompt from the ticket (summary, status, description) and asks for a plan. No skill or Jira tool needed. |
| **My command** | Your own slash command, given the key (for example `/jira ACME-123`) |

The ticket's description is written by other people, so Cora hands it to Claude as information about the work, never
as instructions. See [Security and privacy](security-and-privacy.md#other-peoples-words).

## Slack

With Slack connected, your sessions and Cora can look people and channels up, read a conversation or a thread for
context, search, and write messages as you. Messages go out under your own name, and only with your OK.

### Connecting Slack

Cora works through a Slack app of your own, so no one else's app sits between you and your workspace. Cora fills the
app in for you.

1. In **Settings › Slack**, choose **Create Cora's Slack app**. Slack opens with the app already described: it works
   as you, and has Cora's own bot. Pick your workspace, create it, then choose **Install to Workspace**. Your Slack
   admin may need to approve it.
2. From the app's **OAuth & Permissions** page, copy the **User OAuth Token** (`xoxp-…`) and the **Bot User OAuth
   Token** (`xoxb-…`). Paste them under **2. Paste its tokens**, and choose **Connect**. (With token rotation on,
   paste the refresh token instead, with the app's Client ID and Client Secret.)
3. For anything live (thread watches, Slack in the Inbox, the bot's buttons), turn on **Live events**. The page walks
   you through it: Socket Mode on, event subscriptions, and an app-level token (`xapp-…`) pasted into **Live events**.
   Cora connects out to Slack, so nothing on your PC has to be reachable from outside.

If **What's waiting** says the app can't search yet, add the `search:read` user scope to the app and reinstall it.

### Sending as you

How a message goes out depends on who wrote it and whether you asked for it:

| Who | What happens |
|---|---|
| **A session** | Every message is a draft that waits for you. It shows over whatever you're looking at: change who it's for or what it says, then **Send** (`Ctrl+Enter`), **Open in Slack** to finish it there, or **Discard**. Drafts survive a restart. While you're away, Cora's bot sends it to your phone with **Send** and **Discard**. |
| **Anyone, to you yourself** | A message to your own DM (a session following up with you while you're away) goes out at once: nobody else reads it. |
| **Cora, when you asked in your own words** | It goes out at once ("tell Ana I'm running late"). You can undo it for about 15 seconds. |
| **Cora, on anything else** (a goal, an event) | A draft for you to send, like a session's. |
| **You, from the Inbox** | **Reply…** sends what you type, as you. |

**Messages Cora sends for you end with a sign-off**, so whoever reads one knows Cora wrote it. That includes a
session's draft once you send it. The sign-off is `:cora:` by default; change it, or leave it empty for none, in
**Settings › Slack › Sign Cora's messages**. A custom emoji has to exist in your workspace. Replies you type yourself
in the Inbox are never signed.

Sessions can attach files to a message: from the session's folder, your temp folder, Pictures, Downloads or Desktop,
up to 20 MB each. Never from `~/.cora` or `~/.claude`.

### Watching a thread

When a session asks someone something in Slack and needs the answer to carry on, it can watch the thread. The first
reply from someone else is typed into the session as soon as it's posted, and the session's row says so. A watch ends
after one reply, or after 24 hours (a session can ask for up to three days). Watches need **Live events**;
**Settings › Slack** shows how many are running.

### Letting Cora carry on a conversation

You can tell Cora, in your own words, to keep a Slack conversation going by itself: "keep chatting with Ana about the
release notes until I say stop." For that one conversation, Cora's messages go out without asking you, for a few hours
at most (four unless you say otherwise).

- **Settings › Slack › Cora on its own** lists these conversations, with **Stop** for each.
- Each message can still be undone for a few seconds.
- When the other person replies, Cora can answer them there, but their words can't make Cora do anything else on your
  PC. See [Other people's words](cora.md#other-peoples-words).

### Slack in the Inbox, and Cora's bot

With **Live events** on, your DMs, mentions and replies in threads Cora watches come into [Cora's Inbox](#coras-inbox).
You can also follow channels under **Inbox: channels I follow**: Cora brings in only what touches you there (replies
in threads you posted in, your tickets and repos, `@here`, and words you choose), never every message.

**Cora's own bot** messages you as Cora while you're away, so it reaches your phone, and takes instructions in that
DM. Choose **Send a test message** to check it. What it sends and when is described in
[Cora's Slack bot](cora.md#coras-slack-bot).

## Gmail

Cora reads your mail and writes drafts through a Google app of your own, so no one else's app sits between you and
your mail. It never sends an email: drafts wait in Gmail for you to check and send.

### Connecting Gmail

**Settings › Gmail › Set up your Google app (once)** walks you through it:

1. A Google Cloud project (a new one just for Cora is cleanest).
2. The Gmail API, turned on in that project.
3. The sign-in screen: **Internal** with a work account; with a personal account, **External**, yourself as a test
   user, then **Publish** (or Google signs you out every 7 days).
4. What Cora may do: two scopes, to read mail and to write drafts.
5. A **Desktop app** client, downloaded as JSON.
6. Paste that JSON into the box.

Then sign in with Google in your browser. Disconnecting removes Cora's access at Google too.

### Rules: what Cora watches for

Under **What Cora watches for**, turn on **Watch my inbox** and add rules: a name and a Gmail search, written as in
Gmail's own search box (`from:ana@example.com`, `subject:(outage OR incident)`). Every minute, Cora looks for new mail
matching a rule. Cora hears about it, it lands in the Inbox, and Cora's bot can tell you while you're away. Everything
else is left alone.

**Also what Gmail marks important** adds unread mail Gmail marks important. It's off by default, because a busy inbox
makes a lot of it.

### Drafts

With **Let Cora write drafts** on, Cora and your sessions can write a reply or a new email when you ask. Each one waits
in Gmail's Drafts for you to check and send. **Only to** limits who drafts may be addressed to (addresses or domains,
such as `@example.com`). Your own reply from the Inbox (**Reply (a draft)…**) also becomes a draft, and isn't held to
these limits.

### Email watches

An email watch is "when this email comes, do this": "when QA replies about the login bug, look into it and ask me
before replying." Tell Cora, or a session, what you're waiting for. It finds the real sender first, then sets the
watch.

- **One email, or a whole thread.** A watch can wait for one reply, or follow a thread back and forth.
- **What happens when it comes.** **Tell me** only tells you. **Ask me, then** asks before starting on it. **Start**
  starts straight away, when you said so. After the work, it asks before drafting a reply, unless you told it to draft
  one.
- **The sender is checked.** The email must come from the address or domain you named, and pass Gmail's own sender
  check. One that fails is never acted on; Cora tells you about it instead.
- **Your instruction is the work.** The email is passed along as information. Whatever it says can't widen what you
  asked for.

**Settings › Gmail › Waiting for** lists every watch (what it waits for, from whom, until when, and what happens next)
with **Stop**. A session with a watch shows a small mail mark in its header.

## GitLab pipelines

Cora follows each session's GitLab pipeline, so you see a failure the moment it happens, next to the work that caused
it.

**It needs** the GitLab command line, `glab`, installed and signed in (`glab auth login`). Set your GitLab host in
**Settings › Environments › Pipelines and Deploys › GitLab** (it starts as `gitlab.com`). Cora only reads from GitLab.

- **Which pipelines.** Each live session follows the latest pipeline for the branch it works on (its merge request's,
  when it has one), plus pipelines its commands start or look at. After a push, Cora looks again within seconds.
- **In the header.** A strip shows the pipeline's stages and jobs as they run. Click a failed job for its log.
- **In the session list.** A glyph on the session's row shows its latest pipeline.
- **When one finishes.** A notification (**Settings › Notifications › A GitLab pipeline finishes**), an Inbox item,
  and, while you're away, a ping from Cora's bot if it failed.

Pipelines are read only while a Cora window is open.

## Deploys

Deploys shows what each of your environments runs, and how far a ticket's change has got: merged, built, tagged, on
dev, on staging, on prod. It reads your clusters with `kubectl` and your projects with `glab`.

**It needs** `kubectl`, kubeconfigs for your clusters (see [Environments](#environments)), `glab` signed in, and a
connection to each cluster (usually its VPN). Only images from your GitLab registry are shown.

### What runs where

**Overview › Deploys** (`G`) is a board: a row per service, a column per environment, and each service's newest build.
**Mine** shows only the services your sessions' tickets change. The top right shows which environments your PC can
reach now; one it can't reach keeps its last listing, with its age. See
[The overview](seeing-the-work.md#deploys).

### A ticket's journey

When a session's ticket has a merge request, its header shows a row of dots: **MR**, **Pipeline**, **Tag**, then each
environment. Hover or click it for each step's detail (the MR's number, the tag, which version each environment runs)
and Cora's suggested next step.

### Dev bumps

A dev bump is the only thing Deploys ever changes. When a ticket's change is built and dev doesn't run it yet, Cora
offers **Bump dev…** on a card. The board has **Bump dev** on a service's row too.

1. Choose which workloads to update. The ones running an older version are ticked.
2. Check the line at the top: **Set** *tag* **on** *cluster*, with the cluster's address.
3. Choose **Bump** (it shows how many workloads). Nothing changes until you do.

Before it changes anything, Cora checks that:

- the environment is labelled **dev**, and is reachable now;
- each workload is one it just listed there, and the tag exists in the registry;
- the kubeconfig really points at that cluster. Cora uses each environment's own kubeconfig context, never whichever
  one is current. If they don't match, nothing is changed and Cora says why.

Cora follows the rollout until it's done. The result goes to the Inbox, and a failed rollout pings you on Slack while
you're away. Staging, prod and every other environment are only ever read. Sessions can ask what runs where, but they
can't bump anything.

## Environments

Most teams reach dev, staging and prod through separate VPNs, often one at a time. Environments tells Cora, and every
session, which clusters this PC can reach right now.

- **Where clusters come from.** Cora finds them in the kubeconfig files in `~/.kube`. **Check now** also looks for new
  ones.
- **Reachability.** Each cluster is checked every 30 seconds with a harmless ping. Sessions can ask which environment
  is reachable, and are told with their next prompt when it changes. Cora never changes your network.
- **Labels.** Each cluster has a label: **Dev**, **Staging**, **Prod** or **Other**. Cora guesses it from the
  cluster's names, and keeps the one you set. Local clusters (Docker Desktop, kind and the like) are left out.
- **Labelling a cluster dev asks first.** Dev is the one label Deploys may write to, so Cora shows you the cluster's
  name and address, and asks you to confirm.
- **Not checked.** Turn a cluster's switch off to stop checking it.

All of this is in **Settings › Environments › Clusters**.

## Cora's Inbox

The Inbox keeps everything Cora told you, from every source, for 14 days. Open it from **Inbox** in the left nav; the
row shows unread counts per source.

| Source | What comes in |
|---|---|
| **Jira** | What you asked Cora to watch for: assignments, mentions, comments, status changes |
| **Slack** | DMs, mentions, replies in watched threads, channels you follow (with **Live events** on) |
| **Email** | Mail matching your rules, and email watches with what Cora did about them |
| **GitLab** | Finished pipelines your sessions follow, and dev bumps |
| **Cora** | Cora's own work: what it did, and anything it needs you to know |

Each item says **Why it's here**, and **What Cora did** when it did something. "New since you looked" marks where you
left off. On an item:

- **Reply…** answers a Slack message as you, in its thread or DM. For email, **Reply (a draft)…** makes a Gmail draft.
- **Ask Cora** opens Cora's console with the item, ready for your question.
- **Start a session** starts one with a first message about the item, for you to edit.
- **Open in…** opens it where it lives. If one of your [Tools](#the-tools-drawer-and-tool-windows) is for that site
  (Slack, say), it opens there, at the conversation. Otherwise it opens in a window of its own, never in the focused
  session's browser.
- **Go to its session**, when it belongs to one.

## Notes

Notes are a notepad that lives beside your sessions, for you, and for Cora and your sessions when you ask. Open them from
**Notes** in the Tools drawer (`Ctrl+Shift+N`).

- **Scratch** takes quick jots, newest first. Each jot can be copied, moved to a note, or deleted.
- **Named notes** are plain text that saves as you type. Markdown works: `- [ ]` makes a task, and `Ctrl+Enter` ticks
  it. Pin a note to keep it at the top; **Search notes** finds any of them.
- **Templates.** **New note** has a menu of templates: Standup, Meeting, Weekly review and Bug report to start with.
  Templates marked **Cora fills** are drafted for you from what you actually did: pick a window (**Since last**,
  **Today**, **Last 24 h**, **This week**), the repos to include, anything to add, then **Draft it**. Cora writes it
  only from those facts, and you can edit everything after. **Just the template** gives you the blank one. Edit your
  templates in **Settings › Tools › Notes templates**.
- **Sessions can add, never change.** When you ask a session or Cora to note something down, it adds a jot to Scratch
  or text at the end of a note, marked as theirs. A dot shows on a note a session added to.

**Quick capture:** press `Ctrl+Alt+N` anywhere in Windows. A small box opens: type, then `Enter` saves to Scratch, or
`Tab` picks a note to add to. `Esc` hides it.

## The built-in browser

Each session has a browser of its own inside Cora, signed in to your sites. Links you click in Cora open there, next
to the work, instead of scattering tabs across your usual browser.

- **Open it** with **Browser** in the session's header. The count shows its tabs. **Hide** keeps the tabs loaded.
- **Tabs per session.** Each session keeps its own tabs. Sign in to a site once, and every session's tabs share it.
- **The address bar** suggests as you type: pages you've visited in Cora first, then your Chrome and Edge bookmarks
  and history.
- **A new tab** shows your Chrome bookmarks bar under **Your bookmarks**, and **Recent** pages.
- **Your usual browser** is a click away: **Open in your browser**, or `Ctrl+click` any link.

Cora reads bookmarks and history from Chrome's and Edge's profiles on this PC, and never sends them anywhere. Your
sign-ins can't come over: those browsers keep them encrypted for themselves. Turn this off with **Settings › Tools ›
Cora's browser › Your Chrome bookmarks and history**.

### Pages sessions open

A session can open a page for you, such as the merge request it just created or the ticket it just commented on. Sites
you plainly use open straight away: your GitLab and Jira sites, GitHub, your Tools, sites already open in a tab, and
sites you've said yes to before. Any other site waits: a card says the session wants to open it, with **Open**, or
**Not now** to dismiss it. Nothing on the page comes back to the session.

Browser shortcuts are in the [Reference](reference.md#in-the-browser).

## The Tools drawer and Tool windows

Tools are web apps you keep open for the whole of Cora, beside whichever session you're in: Slack to start with, then
whatever you add (your Jira board, merge requests, a dashboard).

- **Open one** from **Tools** in the left nav, or with `Ctrl+1` to `Ctrl+9`. It opens in a drawer beside the session.
  Drag its edge to resize it.
- **Unread counts** show on a Tool's button when the app has news.
- **Add, arrange and tell apart** in **Settings › Tools**: a name and an address; move up or down; a tint and a short
  tag (`PRD`, `STG`, `DEV`) for Tools that look alike; and a folder to group related ones. **Show their names** in the
  nav switches between icons and a list with names.
- **Tool windows.** **Pop out into its own window** gives a Tool a window of its own. It keeps the same sign-ins, its
  links open in your usual browser, and its sign-in pop-ups work.
- **Permissions.** Only Tools may show notifications, use your microphone and camera, or share your screen. To share
  a screen, you pick which one, every time.

Tools share sign-ins with Cora's browser, so signing in once covers both.

## 1Password

The 1Password browser extension can't run in Cora's browser, so Cora works with the 1Password app directly. Your logins
are filled in when you ask, and never kept by Cora.

### Filling a login

1. On a page with a sign-in form, a 🔑 appears in the address bar. Click it, or press `Ctrl+\` (in the page, or in
   Cora).
2. Cora asks 1Password for the site's logins. 1Password may ask you to unlock it with Windows Hello.
3. Pick a login. Cora fills the username, the password and, when the page asks for one, the one-time code.

Cora doesn't ask 1Password anything until you click the key or press the shortcut, so simply opening a sign-in page
never prompts Windows Hello. After that, the key lights up on sites 1Password has logins for.

- **Which logins.** The menu lists the logins whose saved websites match the site, or a domain it's part of (a login
  saved for `acme.io` also fits `rancher.acme.io`). Never by username or email.
- **Another login.** **Search 1Password for another login** finds any login by its title. One that isn't saved for
  this site asks you first: **Fill** it on this site, or **Cancel**.
- **Always your click.** Even a single match waits for you to pick it. Nothing is filled silently.
- **In Tools.** Press `Ctrl+\` in a Tool, in the drawer or in its own window. In a Tool window you get a short menu of
  the site's logins, without the search.

### Setting it up

1Password is an optional feature in **Settings › Setup**:

1. **The 1Password app**, installed and signed in. Setup can install it for you, in a window you can watch.
2. **1Password's command line (`op`)**, installed the same way.
3. **Connected to the app.** In the 1Password app, open **Settings › Developer** and turn on **Integrate with 1Password
   CLI** (and Windows Hello, to unlock with your face, fingerprint or PIN). Cora checks again by itself.

**Settings › 1Password** shows whether it's ready, and has three switches: **Fill logins in Cora's browser**,
**One-time codes too** and **In Tools too**. All three start on.

How Cora keeps your passwords out of its own hands is in
[Security and privacy](security-and-privacy.md#how-secrets-are-kept).

## Good to know

- **Jira, the browser, Tools and 1Password need the desktop app.** Opened in a web browser, Cora's dashboard has no
  built-in browser to sign in with.
- **Every integration is read-only until you act**, with three exceptions you control: Slack messages (drafts you
  send, or ones you asked Cora for), Gmail drafts (never sent), and dev bumps (only on your click).
- **A session's Slack draft that's waiting isn't sent.** If you close Cora, it's still there when Cora comes back.
- **Thread watches end by themselves**, after the first reply or when their time runs out. Starting a fresh
  conversation with Cora keeps the threads it was watching.
- **If a cluster won't show as reachable**, check its VPN first. Cora only looks; it can't connect you.
- **Saving logins** to 1Password, passkeys, cards and other password managers aren't supported.
- What Cora stores for each integration, and where, is in [Security and privacy](security-and-privacy.md). Shortcuts
  and settings pages are in the [Reference](reference.md).
