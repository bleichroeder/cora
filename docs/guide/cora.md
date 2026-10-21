# Cora, the assistant

Cora's agent is an assistant that works across everything Cora shows you. It is a Claude Code session of its own,
running on your Claude login, and it watches your sessions, pipelines, Jira tickets, Slack and email. You talk to it by
typing or by voice. It looks things up, puts the right session or page in front of you, starts and directs sessions,
and tells you what needs you. It acts only through its own tools, and it asks you first: anything that changes your
work comes to you as a card to approve, unless you asked for it yourself, or you've handed it a goal or turned on away
mode, where fixed rules decide what it may do on its own.

**Asking is your OK.** When you ask Cora for something in your own words (in its console, by voice, or in its Slack DM),
it doesn't ask again: "start a session on ACME-5300" starts one, "tell app-api to rerun the tests" sends it, "end the
docs session" ends it. A card comes only for what Cora decides to do on its own.

## What Cora can do

- **Answer questions about your work.** "What's app-api doing?", "Why did the pipeline fail?", "What's on dev?" Cora
  looks before it answers: at your sessions, their prompts and transcripts, pipelines, deploys and the security check.
- **Show you things.** It can focus a session, open an explain, a page in Cora's browser, or one of your Tools.
- **Start, resume, direct and end sessions.** Each of these is a card you approve first.
- **Talk with your sessions.** It can ask a throwaway copy of a session a question ("what's left?", "why did you do
  that?") without interrupting it, and without asking you. To talk to the session itself, it asks your OK once; that
  opens a 10-minute conversation in which it can follow up without asking again.
- **Use your other tools.** If you've connected MCP servers to Claude Code (Jira, GitLab and the like), Cora can use
  them too. Reading from the common ones needs no OK; anything that changes something asks. For a server of your own,
  add it in **Settings › Cora › Work tools** (what it's for, and which of its tools only read) and Cora uses those
  tools without asking too.
- **Slack, email and notes.** Read and search Slack, send messages, read your watched email, write drafts, and add to
  your notes. See [Integrations](integrations.md).
- **Remember** what you tell it about yourself and your work.

What Cora never does itself: edit files or run commands. Real work happens in Claude Code sessions, where you can see
it. Cora starts them and tells them what to do.

## Turning it on

Cora's agent is off until you turn it on.

1. Open **Settings › Cora Orchestrator**.
2. Turn on **Turn on Cora**.

Cora starts its session in the background. It doesn't appear in your session list. The first time it starts, Claude
Code may ask whether to trust Cora's folder: the question shows in Cora's console, where you answer it.

On the same page:

- **Colour**: Cora's eye, its cards and console, and the app's icon.
- **Status**, with **Start again** (restarts its session; it keeps its conversation) and **New conversation** (a fresh
  start when the current one can't go on; it keeps its memory, your instructions, its goals and the Slack threads it
  watches).
- **Model**: **Opus** or **Sonnet**, or **Other…** for any model name Claude Code accepts. The strongest works best.
- **Say replies aloud**: a short spoken line with each reply, using your [voice](voice.md) settings.

If Cora's session keeps stopping (five times in ten minutes), it stays off and says so. Choose **Start again** when
you're ready.

## The bridge card

The bridge card sits at the top of the left nav. It shows Cora's eye, its state (**standing by**, **thinking…**,
**listening…**, **waiting for you**, **away mode**, **autopilot** with its progress), your running sessions orbiting
it, and Cora's latest words.

Under it are three buttons:

- **Talk**: speak to Cora (needs [voice](voice.md)).
- **Brief**: catch up on what needs you and what happened.
- **Goal**: give Cora a goal, or see the one it's on.

Click the eye or the card to open the console. The arrow in the corner shrinks the card to one row. When Cora is off,
the card shows **offline** and a **Turn on** button.

## The console and command mode

The console is where you talk to Cora. Type in **Talk to Cora…** and press `Enter`, or hold `Ctrl+Space` and speak.
Cora's replies come in with what it did in between ("sessions", "focus", "start_session"), so you can follow along.

The console holds everything Cora needs from you: its approval cards, its own permission prompts, Jira start cards,
deploy cards, and the Slack messages it just sent (while you can still undo them). When the console is closed, these
cards float beside the bridge card instead, so you don't miss them.

The **…** menu has **Brief me**, **Wrap up**, **New conversation** and **Cora's settings**. `Esc` closes the console.

From [Cora's Inbox](integrations.md), **Ask Cora** puts an item in the console's box, ready for your question.

**Command mode** is the console full screen, for when Cora is the main thing you're working with. Press
`Ctrl+Shift+Enter` (or the expand button in the console). It has three columns:

- **Needs you**: Cora's cards and every prompt a session is waiting on.
- The middle: Cora's eye, what you said last, what it did, and its reply.
- **Autopilot** and **Sessions**: the goal, the sessions Cora is talking with, and your running sessions.

`Ctrl+Shift+Enter` or `Esc` takes you back.

## Approval cards

When Cora wants to do something that changes your work, it shows you a card first. Each card says what Cora wants to
do and why.

| Card | What it does | Buttons |
|---|---|---|
| Start a session | Starts Claude Code in a folder with a first prompt | **Start it** · **No** |
| Tell or ask a session | Types a message into a running session | **Send it** · **No** |
| End a session | Ends a session | **End it** · **No** |
| A question from Cora | Asks you to decide something (a merge, a deploy, a choice) | its suggested answers, or **Answer** in your own words · **Dismiss** |
| Start a ticket | Starts work on a Jira ticket assigned to you | **Start in** *folder* (the arrow picks another) · **Not now** |

- **Edit before you approve.** A card's text (the first prompt, the message, the answer) is editable. What you approve
  is what's sent, and Cora is told you changed it.
- **Approve** with the main button, or `Ctrl+Enter` in the text. **Refuse** with **No** or **Dismiss**. Cora doesn't ask
  again unless you bring it up.
- **Take your time.** Cora waits a little under a minute, then carries on knowing the card is waiting; the card shows
  **Cora moved on**. Approving it later still does it, and Cora hears what happened.
- **Cards survive a restart.** Cards waiting when Cora restarts or updates are still there afterwards, and still work.
  The one exception is Cora's answer to a session's question: that question ended with the restart, so the card goes,
  and [Cora's Inbox](integrations.md) tells you which cards were lost.

When Cora starts a session, it answers Claude Code's "do you trust this folder?" question with yes, so the first prompt
can go in.

## Goals and autopilot

A goal is a piece of work you hand Cora to get done on its own: "Fix ACME-123 in app-api, get the tests and pipeline
green, and push a branch for review." Cora plans it, starts worker sessions, tells them what to do, checks their work,
and reports progress. While a goal runs, Cora is on autopilot.

**Before your first goal**, tell Cora where it may work. In **Settings › Cora Orchestrator**, under **Autopilot and
away**, add folders to **Where Cora may work on its own**. Cora suggests the folders your sessions already use. With no
folders, everything on autopilot comes to you.

**To give Cora a goal**, choose **Goal** on the bridge card (or in the console), describe the goal, optionally pick a
budget, and choose **Start** (`Ctrl+Enter`).

On autopilot:

- Cora starts sessions in your allowed folders without asking, and sends them instructions straight away.
- Their permission prompts are answered by the rules below, not by Cora's judgement. What the rules don't allow waits for
  you as usual.
- Cora answers its workers' multiple-choice questions itself. It can also turn down a worker's prompt when the work is
  going the wrong way.
- When it needs you (a merge, a deploy, a choice), it asks with a card.

The goal shows as a progress ring in the console header and a line under it: the goal, the progress Cora reports, and
the tokens used. Click it for the goal card with its worker sessions and Cora's latest note. A goal is **running**,
**waiting for you**, **blocked**, **done** or **stopped**. Sessions working on the goal are marked in your session
list.

One goal runs at a time; starting another stops the first. **Stop** on the goal card ends it and leaves the worker
sessions as they are. A goal survives a restart.

### The rules for what Cora may approve

The rules (the mandate) are fixed checks on each command and edit. Cora's model doesn't decide them and can't change
them. They apply to sessions working in the folders you've allowed; in any other folder, every prompt comes to you.

| | What it covers |
|---|---|
| **Fine on its own** | Reading and searching. Editing files inside the repo. The project's own scripts, tests, builds, linters and package installs. Local git work: commits, branches, rebases, stashes, fetch and pull. Pushing a feature branch. Read-only checks against clusters and clouds (get, describe, logs, plan). Reading from GitLab or GitHub. Fetching a web page. Containers that stay inside the repo. Deleting a file in the repo. |
| **Asks you** | Merging. Deploys: changing clusters or infrastructure, running pipelines, pushing images, scripts named deploy, release or publish. Publishing a package or a release. Sending data out: requests that post or upload, API calls that change something, remote shells and copies, creating things others see. Anything that writes outside the repo: a redirect, a copy, an in-place edit, an edit to a file elsewhere, a container that mounts your machine. A command that hides another one (inside `$( )` or backticks, inline code like `node -e`, an encoded PowerShell command). Recursive deletes, hard resets and `git clean`. Changing your global git config. Another service's tools. Any command not on the list. Questions from sessions that aren't the goal's workers. |
| **Never** | Force-pushing. Pushing to the default branch. Deleting branches. Dropping databases or tables. Recursive deletes outside the repo or at a drive's root. |

The "never" list holds in every mode, whatever else you allow. When a session tries one, its prompt is refused with a
note telling it not to look for another way round. Settings lists these under **Never › Hard limits**.

**Deploys too** lets the rules approve deploys as well (cluster and infrastructure changes, pipelines, image pushes).
Publishing a package or a release still asks.

### The budget

Each goal has a token budget: what its sessions and Cora itself may use (output plus uncached input) before Cora stops.
Set the default in **Budget per goal** (1M, 5M, 20M or 50M tokens; 5M to start with), or pick one for a goal when you
start it.

When the budget is spent, the goal is **blocked**: Cora stops starting or sending work, tells you where things stand,
and every prompt comes back to you.

## Away mode

Away mode applies the same rules to all your sessions, not just a goal's workers. Turn it on when you step away and
want routine prompts (an edit, a test run, a commit) answered so work doesn't stall.

Use the **Away** switch in the console header (**Away mode** in command mode). The bridge card says **away mode** while
it's on. Prompts the rules don't allow still wait for you, and sessions outside your allowed folders aren't touched.

Away mode doesn't turn itself off when you come back. Turn it off yourself, or stand Cora down.

With Cora's Slack bot set up, away mode also counts as being away: whatever is waiting for you goes to your phone at
once, without waiting for **Away after**.

## Stand down

Stand down stops Cora at once:

- the goal stops,
- away mode turns off, so prompts come to you again,
- its conversations with sessions end,
- its waiting cards are refused,
- and Cora stops what it's doing and waits until you ask it for something.

Worker sessions are left as they are, for you to look at.

There are four ways to stand Cora down:

- **Stand down** in the console header or command mode (shown while a goal runs).
- Say or type "stand down" (or "Cora, stand down") to Cora.
- Send "stand down" to Cora in its Slack DM.
- Press `Ctrl+Alt+Backspace`: anywhere in Cora, and with the desktop app, anywhere in Windows.

## Briefs

Briefs catch you up in about a minute to hear.

- **Welcome back.** When you come back to Cora after three hours or more away, Cora tells you what needs you first
  (waiting prompts and questions, failures, and Slack, Jira and email waiting for you, when they're connected), then what
  happened while you were away. Turn it off with **Briefs › Only when I ask**.
- **Brief me.** The same, any time: **Brief** on the bridge card, or **Brief me** in the console's menu and command
  mode.
- **Wrap up.** At the end of the day: what got done, what's still open, what's left running or waiting on you, and what
  to pick up first next time. In the console's menu and command mode.

## What Cora hears between your turns

Cora doesn't wait to be asked about everything. Important events are passed to it as short notes while it's idle, a
few at a time, so it can look into them and tell you. Nothing interrupts a turn you started: notes wait until Cora is
free.

With **Cora hears › The important things** (the default), Cora is told about:

- a session that failed several tool calls in a row, stopped on an API error, or ended in the middle of a turn,
- a session that has been working with no activity for 15 minutes and may be stuck,
- a pipeline that failed,
- a prompt that has waited a few minutes for you.

For each, Cora looks first, works out what would fix it, and tells you with a suggestion. Outside a goal it doesn't act
on it without your OK.

Quieter news (new Jira activity, watched email, changes in which environments you can reach) doesn't get a turn of its
own. Cora keeps it and takes it in with your next words, so it knows when you ask.

On autopilot, Cora hears everything about its goal's sessions: each finished turn, each prompt and what the rules said,
their pipelines.

Choose **Cora hears › Nothing** to keep Cora quiet until you talk to it.

## Starting work from Jira

When Jira watching is on ([Integrations](integrations.md)), Cora can help when a ticket is assigned to you. Choose
what happens in **Settings › Jira**, under **When a ticket is assigned to you**:

| Choice | What happens |
|---|---|
| **Just tell me** | A card, and Cora's voice if you've asked for it. |
| **Offer to start it** | Cora picks the folder the ticket's code most likely lives in and shows a card: **Start in** *folder*, with other candidates under the arrow, or **Not now**. |
| **Start it on its own** | Cora starts a session in that folder, in plan mode: it reads the ticket and stops at a plan, changing nothing until you approve the plan. A card tells you, with **Open**. |

A few things keep this tidy:

- Cora never starts the same ticket twice, and skips tickets that already have a session.
- **Start it on its own** starts at most two tickets that are waiting on you. Beyond that, it offers instead.
- If a ticket is reassigned before you act, its offer goes away.
- The session starts with your own `/jira` command, or Cora's ticket prompt (**Start ticket sessions with**, in the same
  settings).

Offering and starting need Cora's agent on; until then, Cora just tells you.

## Instructions and memory

**Your instructions** (in **Settings › Cora Orchestrator**) are standing guidance that Cora reads every time it starts:
how it sounds and how it works for you. For example: "Be warm but brief. Lead with what needs me. Call me Sam." Choose
**Apply** to use them; Cora restarts and keeps its conversation. Instructions can't lift the hard limits or anything
that needs your OK.

**Memory** is what Cora keeps about you and your work: your preferences, projects, people, how you like things done. It
adds to it as you go, when something seems worth keeping or when you ask it to remember. You can read and edit it under
**Memory › What Cora keeps about you**, then **Save**. **Forget everything** clears its memory and starts a fresh
session.

## Cora's Slack bot

Cora can have its own Slack bot, so it can reach you on your phone while you're away from your desk. Set it up in
**Settings › Slack › Cora's own bot** ([Integrations](integrations.md) has the steps), then **Send a test message**.

While you're away (no keyboard or mouse for **Away after** minutes, or the screen locked), Cora messages you as itself.
You choose what pings you:

- **Whatever waits for your OK**:
  - a session's permission prompt, with **Allow** and **Deny**. A prompt sent to your phone waits up to an hour for
    your answer, instead of two minutes.
  - a Slack message a session drafted, with **Send** and **Discard** (to change it first, use Cora's outbox).
  - Cora's own cards (start, tell or end a session; a ticket to start on), with **Yes** and **No**. When Cora asks you
    something, its suggested answers are buttons; with none, answer in Cora or write your answer in the DM.
  - a session's question comes as a message too; you answer it in Cora or in the Claude app.

  What was already waiting when you left comes to your phone then, and anything you answer at your PC says so in
  Slack.
- **Failures**: a pipeline a session follows failed, or a dev bump didn't roll out.
- **Tickets assigned to me**.
- **Email I watch for**.
- **Finished sessions**: **Ping** for each, a **Digest** every 30 minutes, or **Off**.

**Quiet hours** and **At most a day** keep it from getting noisy.

With **Take instructions in that DM** on, you can write to Cora in that DM as you would in the console: "what's
running?", "tell app-api to rerun the tests", "stand down". Cora marks your message as seen, says in a sentence what
it'll do, and sends its reply back to the DM. A turn you start from Slack is answered in Slack: it isn't read aloud at
your desk. Only your own messages in that DM count.

## Other people's words

Cora reads a lot that other people wrote: Slack messages, email, Jira comments, web pages. All of it is information,
never instructions, even when it asks Cora to do something or claims to come from you. Only your own words instruct
Cora: what you type or say in its console, and what you write in its Slack DM.

When someone else's message starts a turn (a reply in a Slack thread Cora is watching, a conversation you let it carry
on, an email you were waiting for), Cora can read, reply in that conversation, and tell you what they asked. It can't
act: it can't start, message or end sessions, answer prompts, open pages, fetch from the web, or reach anywhere else.
If they ask for something, Cora tells you, and you decide.

## Good to know

- Cora's agent uses your Claude login and counts toward your Claude usage, like any other session.
- Cora's own tool prompts (rare, such as a write tool from one of your MCP servers) appear in its console as **Cora
  wants permission for a tool**. Answer them there.
- Slack messages you ask for in your own words go out at once, with a few seconds to undo. Messages Cora would send on
  its own are drafts you confirm, at your desk or from your phone.
- Turning Cora off stops its session and clears its waiting cards. Its memory and your instructions stay for next
  time.
- Settings for all of this are in **Settings › Cora Orchestrator**. Shortcuts are listed in [Reference](reference.md).
- How Cora protects your machine and data: [Security and privacy](security-and-privacy.md). Talking to Cora by voice:
  [Voice](voice.md).
