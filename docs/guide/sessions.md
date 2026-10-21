# Working with sessions

A session is one conversation with Claude Code, in one folder. Cora finds every session on your PC, whether you
started it in Cora or in any other terminal, and lists it on the left. From there you start new ones, pick up old
ones, answer their questions and permission prompts, and end them when you're done. This page covers all of that.
To see what a session is doing while it works, read [Seeing the work](seeing-the-work.md).

## The session list

The list on the left holds every session Cora knows about, in three groups:

| Group | What it means |
|---|---|
| **Working** | Claude is busy: thinking, running tools, or waiting on a subagent. A session that **needs you** stays here too, lit red. |
| **Idle** | Claude finished its turn and is waiting for you to say something. A session also goes idle after ten minutes with no activity. |
| **Ended** | Claude Code has quit, or the session has been silent for 30 minutes and isn't running in Cora. |

**Needs you** means Claude is stopped on something only you can answer: a permission prompt ("may I run this
command?"), a question with options, or a form from one of its tools. It isn't a group of its own. The session keeps
its place among the working ones and turns red, so the list doesn't jump around while several sessions run at once.

Each group heading shows a count. Next to it:

- A **red count** is how many sessions need you. Click it to go to the first one.
- A **blue count** on **Idle** is how many finished while you were looking elsewhere. Click it to go to the newest.
- **clear** on **Ended** hides every ended session.

**Idle** and **Ended** fold away when you click their heading, and Cora remembers which you folded. **Ended** starts
folded and shows only the last hour; **+ N older** shows the rest.

New sessions appear on their own, including ones you start in any other terminal: Cora reads Claude Code's
transcripts, and with Cora's hooks installed it follows each session live and receives its permission prompts (see
[Getting started](getting-started.md)).

### What a row tells you

Each session is one row:

- **The tile**, in the session's colour with its first letter. Its corner carries the state: green and pulsing while
  it works, red when it needs you, blue when it finished since you last looked.
- **A ring** around the tile when Cora started the session itself, on a goal or on a ticket assigned to you (see
  [Cora, the assistant](cora.md)).
- **The name.** Yours if you gave it one; otherwise its ticket's summary, an automatic name, Claude Code's title, or
  the folder's name.
- **The second line**: the folder, the ticket as a chip (for example `ACME-123`) and a glyph for its latest pipeline
  (see [Integrations](integrations.md)).
- **×** on the right: on a live session it ends it (after asking); on an ended one it takes it off the list.

Hover a row for its full name and folder. Click it to open the session.

### Your order

The order is yours, and nothing reshuffles by itself. Drag a row to move it within its group, or use **Move up** and
**Move down** in its right-click menu. New sessions you haven't placed go below the ones you have. Ended sessions are
history, so they're always newest first.

## Naming, colours and the right-click menu

Right-click any session for its menu:

- **Name.** Type a name and press `Enter`. Leave it empty to go back to the automatic one.
- **Suggest a name** (the sparkle beside the name box). A quick call to a small Claude model names the session from
  its first prompt.
- **Colour.** Pick a swatch, or a custom colour. **auto** goes back to the colour Cora chose.
- **Move up** and **Move down.**
- **Not about ACME-123.** Shown when Cora linked the session to a ticket that isn't really its subject: the ticket card
  goes, and the session is no longer named after it.
- **Remove from the list**, or **Show in the list again** for one you removed.
- **End session…** for a session that's still running.

To name every new session automatically from its first prompt, turn on **Name new sessions** in **Settings ›
Sessions**. It costs a little (one short call per session), and a name you give always wins.

## Removing sessions from the list

Removing a session hides it; nothing is deleted. Its transcript stays on disk, and you can
[resume it](#resume-and-fork) any time.

- **×** on an ended session, or **Remove from the list** in its menu, hides it.
- **clear** on the **Ended** heading, or **Clear ended** in **Settings › Sessions**, hides all ended sessions at once.
- A hidden session comes back by itself if it gets new activity.
- When you've hidden some, **N dismissed · show** appears under the list. Click it to see them again (faded), and
  **hide dismissed** to put them away.

A session that's running in Cora can't be hidden: end it first.

## Ending a session

Click **×** on a live session, or choose **End session…** from its menu or the command palette. Cora checks where
the session runs and tells you how it will end it before you confirm:

- **Running in Cora:** Cora presses `Ctrl+C` twice in its terminal. The first stops whatever Claude is doing; the
  second quits Claude Code. If it hasn't quit a few seconds later, Cora closes the terminal.
- **Running in another terminal:** Cora can't type there, so it ends that session's Claude Code process instead.
  Anything Claude is in the middle of stops.
- **Not running anywhere:** it has probably quit already, and Cora offers **Remove from the list** instead.

Ending a session never deletes it. Its history stays, and you can resume it later.

## Starting a new session

Click **New** at the top of the list (or choose **New session…** in the command palette, or in the tray menu). The
**New session** dialog has two tabs: **Blank** and **From a Jira ticket**.

### Folder

Claude Code works in one folder. Type a path, pick one under **Recent** (the folders your sessions use), or click
through folders under **Browse**. The dialog starts in the folder of the session you're looking at. Press `Enter` or
click **Start in &lt;folder&gt;** to begin.

### Options

All three are optional; leave them on **Default** to use Claude Code's own settings.

- **Model.** Type a model name, or pick one of the suggestions (`opus`, `sonnet`, `haiku`, …).
- **Effort.** How hard Claude thinks: **Default**, **Low**, **Medium**, **High**, **xHigh** or **Max**.
- **Permissions.** How often Claude asks before acting:

| Mode | What Claude does |
|---|---|
| **Ask each time** | Asks before every action that needs permission. |
| **Accept edits** | Edits files without asking; still asks before other actions. |
| **Auto** | Decides for itself which actions are safe to take without asking. |
| **Plan** | Reads and plans, but changes nothing until you approve the plan. |
| **Don't ask** | Never asks: anything not already allowed is refused. |
| **Bypass permissions** | Never asks and does everything. Use it only where a mistake can't do damage. |

### Starters

A starter is a folder plus options you use often, saved as one click. Set up the dialog the way you like it, click
**Save as a starter** and give it a name. Your starters appear at the top of the dialog, and in the command palette.
Click a starter to start a session right away; its **×** deletes it.

### From a Jira ticket

On the **From a Jira ticket** tab, pick one of your open issues or paste a key (`ACME-123`) or a Jira link. The session
starts on that ticket: with your own `/jira` command when you have one, or with Cora's ticket prompt, which reads the
ticket for Claude. **Settings › Jira** decides which. Listing your open issues needs the desktop app and a Jira
sign-in; pasting a key always works. See [Integrations](integrations.md).

You can also start a session from something in Cora's Inbox, with a first message already written for you to edit.
See [Cora, the assistant](cora.md).

## Resume and fork

Every Claude Code session is saved on disk, so you can always pick one up again. Click **Resume** at the top of the
list to open **Resume a session**. It lists your recent sessions under **Today**, **Yesterday** and **Earlier**.

- **Resume** continues the conversation in Cora, with all its history. Make sure it isn't open in another terminal
  first: one conversation running in two places splits in two.
- **Fork** starts a copy that goes its own way. The original is left as it was.

Use `↑` and `↓` to move, `Enter` to resume and `Ctrl+Enter` to fork. Double-clicking a row resumes it too.

### Finding the one you mean

Type in the search box to filter by title, folder and first prompt. From three letters on, Cora also searches
**what was said** in every saved session, your prompts and Claude's replies, and lists the extra matches under
**In what was said**, each with the words that matched.

If you only remember roughly what it was about, describe it ("the one where we fixed the login timeout in app-api last
week") and click **Ask Claude**. Claude reads the titles, folders, first prompts and dates of your recent sessions and
puts the best fits at the top, under **Claude's picks**. It usually takes 10 to 20 seconds, and you can **Cancel** at
any time. If nothing fits, say a bit more (the folder, the ticket, roughly when) and ask again.

### Sessions started in another terminal

When you open a session that runs outside Cora, the terminal area says **Started in another terminal**. You can read
everything it does from Cora. To type into it, click **Resume here** (Cora warns you if it's still running elsewhere:
exit it there first) or **Fork a copy** to continue separately.

## The command palette

Press `Ctrl+K` anywhere (even in a terminal, or a page in Cora's browser) to open the palette: one search box for
almost everything in Cora.

| Group | What you find |
|---|---|
| **Sessions** | The sessions in your list, with their state. |
| **Older sessions** | Saved sessions that aren't in your list, ready to resume. |
| **New session** | Your starters, and "New session in …" for your recent folders. |
| **In transcripts** | Lines from your sessions' transcripts (type three letters or more). |
| **Explains** | The documents Claude wrote for you. |
| **Notes** | Your notes, and new ones from your templates. |
| **Commands** | Actions: settings pages, the overview, voice, the browser, your tools, ending or naming this session, and more. |

With nothing typed, it shows what you picked recently and the most useful commands.

| Key | Does |
|---|---|
| `↑` `↓` | Move |
| `Tab` / `Shift+Tab` | Next or previous group |
| `Enter` | The main action (open, resume, start) |
| `Shift+Enter` | The second action, when there is one: fork instead of resume, or pick options before starting |
| `Esc` | Close |

## The session header

Above the scene, each session has a header:

- **The tile and the name.** Hover the name to see the folder, project and session ID; click it to copy the folder.
- **The state**, as a word: working, thinking, idle, needs you, ended. When Claude left commands running in the
  background, it says how many.
- **The ticket card**, the **pipeline**, how far the ticket's change has got through your environments, and any email
  watch, when the session has them (see [Integrations](integrations.md)).
- **The context meter**: how full the main agent's context window is (green, then amber, then red) and the model.
  Hover it for the numbers, the output so far and how many times the context was compacted. Right after a
  compaction it reads "fresh".
- **Browser**: this session's own browser, with its tabs (desktop app; see [Integrations](integrations.md)).
- **Jump**, for a session running outside Cora: brings its terminal window to the front. If Cora can't find the
  window, it copies the command to resume the session instead.

## Sessions that run in Cora

Sessions you start or resume from Cora run in a terminal hosted by Cora, under the scene's right-hand column. They
keep running when you close the window, when Cora restarts, and when it updates. If Cora's background server stops
unexpectedly, it starts again and picks them back up.

When you quit Cora with sessions running, it asks: **Keep running** (pick them up next time you open Cora), or **End
and quit**.

In the terminal:

- `Ctrl+V` pastes. `Ctrl+C` copies when text is selected and interrupts Claude when nothing is.
  `Ctrl+Shift+C` always copies.
- Right-click copies the selection, or pastes when nothing is selected.
- Pasting a screenshot hands the image to Claude Code (the same as `Alt+V`).
- In **Terminal** mode, the fold button in the terminal bar shows only Claude's input area; it grows by itself for
  menus and questions.
- When a session has ended, **resume again** starts it up where it left off.

## The composer

The composer is a roomy text box under the terminal for writing prompts. It's the default way to write to a session
that runs in Cora. Claude's terminal stays hidden and shows itself whenever Claude Code asks you something there.
Switch between **Composer** and **Terminal** in the terminal bar, or in **Settings › Terminal**.

- **Send** with `Enter` (`Shift+Enter` for a new line), or switch to **Ctrl+Enter sends** in **Settings › Terminal**.
- **History:** in an empty box, `↑` and `↓` step through your earlier prompts.
- **Commands:** type `/` for Claude Code's commands and your own skills; `Tab` or `Enter` picks one.
- **Files:** paste a screenshot, drop files on the box, or click the paperclip. They're attached to the prompt.
- **Drafts** are kept per session, while you look at others and across restarts.
- **Stop:** `Esc` interrupts Claude, and what you've written stays. `Ctrl+C` with nothing selected interrupts too.
- **Voice:** with voice set up, the mic button lets you speak a prompt and check it before sending (see
  [Voice](voice.md)).
- **See the terminal:** click the **Claude** tab to show or hide Claude's terminal.

### Running a command yourself

Start a line with `!` to run a shell command in the session's folder yourself, as you would in Claude Code (for
example `!git status`). The command and its output go into the conversation, so Claude sees them, and they show in
the transcript as a shell call marked as one you ran.

## Shell tabs

Next to a session's **Claude** tab you can open plain shells in the same folder: for a dev server, a quick `git log`,
or anything you'd rather run yourself.

- **+** opens your default shell. The **⌄** beside it lists the others Cora found: PowerShell, Windows PowerShell,
  Command Prompt, Git Bash and each WSL distribution you have installed. Choose the default in **Settings ›
  Terminal › New shell tabs**.
- `` Ctrl+Shift+` `` opens a new shell for the session you're looking at, even while you're typing in a terminal.
- A tab is named after what's running in it, and shows a dot when there's output you haven't seen.
- **×** or a middle-click closes a tab. If something is still running in it, Cora asks first.
- Shells keep running when Cora restarts, like the sessions themselves.

## Permission prompts and questions

When Claude needs your OK, the request comes to Cora as a card over the session's scene, and the session turns red
in the list. If you're looking at another session, a small notice appears in the corner; click it to go there.

For a permission prompt:

- **Allow** lets it go ahead.
- **Allow + edit** lets you change the command or input first, then **Allow edited**.
- **Deny…** refuses. You can add a reason, which Claude sees, then click **Deny**.
- **×** hands it back: the same prompt is waiting in Claude's terminal, so you can answer it there.
- **Jump to terminal**, for a session running outside Cora, brings its terminal window to the front.

For a file edit, the card shows the change itself as a diff (**raw input** shows what Claude sent). Anything that
looks like a secret, such as a token or password, is masked until you click **reveal**.

When Claude asks you a question, the card shows **Claude is asking you** with its options; pick one for each question
and click **Send answer**. When one of Claude's tools asks for input, fill in its form and click **Accept**,
**Decline** or **Cancel**.

Each card has a countdown. Cora holds a request for two minutes; if you don't answer by then, it goes back to the
terminal, where Claude Code asks you itself. Every decision is recorded in a log on your PC.

## Notifications

When Cora isn't the window in front, it tells you about things through Windows notifications (a prompt in a session
you aren't looking at notifies you either way). Click one to go straight to its session. In **Settings › Notifications** you can turn each kind off:

- **A session needs a permission decision**
- **A hosted session finishes its turn** (for sessions that run in Cora), with the last thing Claude said
- **Claude creates an explain**
- **A GitLab pipeline finishes**, for one a session follows

The taskbar icon carries a badge, and the tray icon turns red, while any session needs you. Notifications are part
of the desktop app.

## Keyboard shortcuts

| Key | Where | Does |
|---|---|---|
| `Ctrl+K` | Anywhere | Open the command palette |
| `G` | Not typing | Open or close the overview |
| `` Ctrl+Shift+` `` | A session | New shell tab |
| `Enter` / `Ctrl+Enter` | Composer | Send (as set in **Settings › Terminal**) |
| `↑` `↓` | Empty composer | Earlier prompts |
| `Esc` | Composer | Interrupt Claude (your draft stays); nothing running and an empty box: to the terminal |
| `Ctrl+C` | Composer or terminal, nothing selected | Interrupt Claude |
| `Alt+V` | Claude's terminal | Paste an image from the clipboard |
| `Enter` / `Ctrl+Enter` | **Resume a session** | Resume / fork |
| `Ctrl+F` | Settings | Find a setting |

## Good to know

- **Prompts come to Cora only while it's open**, with its hooks installed. Otherwise Claude Code asks in its own
  terminal as usual.
- **Removing is not deleting.** Removed and ended sessions keep their transcripts; **Resume** and the palette find them.
- **Resume in one place at a time.** Resuming a session that's still open in another terminal splits the
  conversation. When in doubt, fork.
- **Starters save typing.** If you start sessions in the same few folders with the same options, save them once and
  start them from the palette with `Ctrl+K`.
- **Names help Cora too.** A clear name makes a session easier to find in the palette, in the overview, and when
  you ask Cora about it.
- For what Cora keeps on your PC and for how long, see [Security and privacy](security-and-privacy.md). Every
  setting is listed in the [Reference](reference.md).
