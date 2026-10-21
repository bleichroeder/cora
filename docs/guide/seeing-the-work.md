# Seeing the work

Claude Code does a lot between your prompt and its answer: it reads files, runs commands, hands work to subagents and
edits code. Cora shows you all of it as it happens, so you can follow along, catch a wrong turn early, and review what
changed before you move on. This page walks through each view of a session: the 3D scene, the transcript, the
timeline, explains and the changes review. It ends with the overview of all your sessions at once. To start,
resume and talk to sessions, see [Working with sessions](sessions.md).

## The layout

When you open a session, its view has three parts:

- **The middle:** the [session header](sessions.md#the-session-header) on top, the 3D scene in the centre and the
  timeline along the bottom. Explains and diffs open here too, in place of the scene.
- **The right column:** the **Transcript**, **Explains** and **Changes** tabs, with the session's terminal and
  composer underneath when it runs in Cora.
- **The edges between them** can be dragged. Drag the divider to resize the right column, or the bar between the
  transcript and the terminal. The expand button in the terminal bar widens the right column in one click.

## The 3D scene

The scene draws the session as a small solar system. Everything in it stands for something real, and everything you
can see, you can hover for detail or click.

### What you see

- **Orbs are agents.** The large orb on the left is the main agent, the one you talk to. Each subagent it starts
  appears as its own orb to the right, linked back to whoever started it. A subagent that finishes fades away. When
  more than six run at once, the rest are counted as "+N more agents".
- **Labels under the orbs** give each agent's name, what it's doing and how full its context is. Click a label to
  show only that agent in the transcript; click it again for all of them.
- **Planets are what the agents work on:** a folder, the shell, the web, Cora's browser, or one of Claude's tool
  servers. Files orbit their folder as droplets, coloured by what was last done to them: cyan for read, amber for
  edited, green for written, violet for programs that ran. The shell's planet lists recent commands, with the ones
  still running and how long they've taken.
- **Tubes are tool calls.** While an agent uses something, a tube runs from the agent to the planet with light
  pulsing down it, and a failed call flashes red. If you prefer, Cora can draw simple lines with a travelling comet
  instead (**Settings › Scene › Flowing tubes**, or "Scene: lines with comets" in the command palette).
- **The spark above the main orb is the model.** Light travels up to it while an agent waits on Claude, and streams
  back down when the reply arrives, denser for longer replies.
- **Speech bubbles** show what an agent just said. Click one to find it in the transcript.
- **A red beacon** marks an agent that's waiting for you, such as a permission prompt or a question.
- **Explains rise out of the main orb** as a card, then settle on a shelf beside it as small pills. Click a pill to
  open it; when there are more than four, a "+N more" pill opens the **Explains** tab.

When a session ends, a black hole opens and swallows its scene. If the session comes back (you resume it), the hole
gives everything back.

### Moving around

- **Hover** anything for a short description.
- **Click** an orb or a planet to bring it into focus; a planet lines up its files so you can read them.
- **Click** a file droplet to see exactly what changed in it, or, for a file that was only read, to search the
  transcript for it.
- **Drag** to move the view, **right-drag** to tilt it, and use the **wheel** to zoom toward the pointer.
- **Click empty space**, or press `Esc`, to go back to the whole scene.

### Star systems

Behind your agents, Cora draws a star system: a planet, perhaps with moons, rings, an asteroid belt or city lights
on its night side. For a new one, jump to hyperspace with the small rocket button in the scene's corner (it shows
when the pointer is over the scene), or with "Jump to hyperspace" in the command palette (`Ctrl+K`).

**Settings › Scene** lets you change the planet's size and brightness, turn each feature on or off, set how many stars
and how much nebula you see, or turn star systems off for the classic deep-space look.

### When the scene starts

The scene takes a moment to prepare its graphics the first time it opens. While it does, a short "warming up the
scene" veil covers it, and the rest of Cora stays fully usable. If the 3D view ever looks blank or frozen, **Restart
the 3D view** in **Settings › Scene** rebuilds it without touching anything else.

## The transcript

The **Transcript** tab is the written record of the session, step by step and agent by agent:

- **Your prompts**, marked "you", and the task each subagent was given.
- **Replies** from each agent, formatted. Each has a copy button (it copies the text both as Markdown and formatted),
  and with voice turned on, a speaker to read it aloud (see [Voice](voice.md)).
- **Tool calls**, one row each: what was called, on what, the result and how long it took. Click a row to see the
  full input and result. Anything that looks like a secret is masked until you click **reveal**. A row that changed
  a file has a **diff** button.
- **Commands you ran yourself** with `!`, shown as shell calls with their output.
- **Thinking**, as a short "thought for …" line (its content stays hidden).
- **Subagents** being started, with their progress; click one to show only that subagent. Their final reports appear
  in full.
- **Dividers** for context compactions, interruptions and finished turns. A finished turn that changed files says how
  many, with **review** to look at them.

Above the feed, chips filter the transcript: **All**, **main**, or any one subagent. The magnifier searches the
transcript.

The transcript follows new activity as it arrives. Scroll up to read, and it stays where you are; **↓ new activity**
takes you back to the end.

For sessions that run in Cora, main's replies are also in the terminal. If you'd rather keep the transcript short,
turn on **Collapse main's replies** in **Settings › Terminal**: long replies then fold, with **more** to open them.

## Live activity

The transcript only receives finished steps, so under it Cora shows what each agent is doing right now: the tool it's
running and for how long, or that it's thinking. For a session that runs in Cora, the main agent's line is Claude
Code's own status, with its spinner word, time and tokens. When the session is waiting for you, the line says what
for. Between turns it rests on a quiet "idle".

## Tasks

When Claude keeps a task list for its work, it appears above the transcript with a progress bar ("3/7") and the task
it's on. Click it to show or hide the whole list: done tasks are ticked, and the current one spins.

## The timeline

The timeline runs along the bottom of the scene. It has a lane for each agent, with a block for each tool call and
each stretch of thinking, and markers above for the moments you might want to find again:

| Marker | Moment |
|---|---|
| Red | A session waiting for you (a permission prompt or a question), for as long as it waited |
| Orange | A tool call that failed |
| Light blue | One of your prompts |
| Pink | An explain |
| Amber | A file edit |
| Violet | A command left running in the background; it ends green or red |
| Blue | A pipeline starting; it ends green or red |
| White | The context being compacted |

**Rewind** to any moment: drag the playhead, click the time ruler, or click a block in a lane. The scene and the
transcript go back to that moment together, so you can replay how the work unfolded. Click a marker to see what's
there, then click an item to rewind to it; an edit or an explain also has a button to open it straight away.

- Pick how much time the strip shows: **30s**, **2m** or **10m**.
- Drag a lane sideways to look further back.
- **live** (or "Back to live" in the command palette) returns to now. Dropping the playhead at the right edge does
  the same.

## Explains

Long answers are hard to read in a terminal. In sessions started or resumed from Cora, Claude can write its answer as
a document instead: an **explain**. Tables, reports, comparisons and plans come out as formatted Markdown; charts and
interactive pages as HTML. Claude's reply in the terminal then points to it.

A new explain in the session you're looking at opens by itself a couple of seconds after Claude writes it. You'll
find the rest:

- On the **Explains** tab, grouped by day. Switch between **This session** and **All sessions**. An explain Claude
  writes again under the same title is a new version of it, not another explain: it has one row, its newest.
- As pills on the scene's shelf, and as pink markers on the timeline.
- In the command palette (`Ctrl+K`), by title.

### The viewer

An explain opens in the middle of the session, in place of the scene. Its bar has:

- **Copy**: copies the explain's source (Markdown or HTML). The button says **Copied** when it's done.
- **Save**: saves it as a file in `Documents\Cora\Explains`, named after its title and the date, and shows it in File
  Explorer. It never overwrites a file; a second save of the same explain gets a number.
- **Pop out**: opens it in a window of its own, which you can keep open beside Cora.
- **Use the whole window**: spreads it over the whole session view; click again to go back.
- **Close**, or press `Esc`.
- **Versions** (`‹ 2/5 ›`), when the explain has more than one: step back through earlier versions. While you're on
  an older one it stays put; back on the newest, the viewer follows new versions as they come.

**Save** and **Pop out** are part of the desktop app.

HTML explains run in a sealed-off frame: they can draw and animate, but they can't reach Cora or your files, and the
only things they can load from the internet are images, fonts, and scripts from two public code libraries.

### Live explains

For work that runs for minutes (a test run, a build, a deploy, a migration), Claude can keep a **live explain**: a
dashboard it updates as it works. It writes the page once, then rewrites a small data file at each step. The page in
the viewer redraws in place, with no reload and no jump, so you can watch the numbers move.

- A live explain's row on the Explains tab has a pulsing dot while its session is working, and says when it was last
  updated.
- Its files live in `%USERPROFILE%\.cora\explains`. Sessions started from Cora may write there without asking you,
  and nowhere else in Cora's folder. Old ones are cleared with the rest of Cora's history.
- Live explains need HTML explains on (**Markdown + HTML**).

Every HTML explain gets Cora's colours to use (yours included, if you've picked another in Settings), so what Claude
draws looks like part of Cora.

### Choosing how much Claude uses them

In **Settings › Explains**:

- **Explains:** **Off**, **Markdown**, or **Markdown + HTML** (the default). Markdown costs about one and a half times
  the tokens of a terminal answer; HTML four times or more.
- **How often:** **Sparingly**, **Normal** or **Liberally**.
- **In the terminal:** whether Claude's reply leaves a **One-line pointer** or a **Short summary** where the explain
  went.

These apply to sessions started or resumed from Cora after you change them.

## Changes and diff review

The **Changes** tab answers "what did Claude just do to my code?". Its count shows how many files the session has
changed.

- **Per turn.** Each of your prompts heads a group listing the files that turn changed, with lines added and removed.
  A file is marked **new** when Claude created it, or with how many edits it got. The turn still in progress is
  marked "now" and updates live.
- **Uncommitted.** When the folder is a git repository, a second section lists everything uncommitted on the current
  branch, including changes Claude made with shell commands, or that you made yourself. Those are marked **other**.
- **Review** opens the latest turn's changes, file by file.

Click any file to see its diff. You can also get there from a tool row's **diff** button, a finished turn's
**review** in the transcript, a file droplet in the scene, or an edit marker on the timeline.

### Reading a diff

The diff opens in the middle of the session. Its bar has:

- **Follow**: jump to each file Claude changes next, as it works.
- **Unified** or **Split**: one column, or old and new side by side.
- **Open**: opens the file in VS Code at that line.
- **Copy patch**: copies the change as a patch.
- **Review** (the expand button): the whole turn file by file, with the list of files on the left.

When a file was edited several times in one turn, **Net** shows the overall change and the numbered buttons step
through each edit in order.

Every block of changes has two buttons of its own: **open**, to go to those lines in VS Code, and **ask Claude about
this**, which puts a reference to those lines (like `@src/app.ts:40-52`) into your prompt in Claude's terminal, ready
for your question. For a session that isn't running in Cora, the reference is copied instead.

In review mode:

| Key | Does |
|---|---|
| `j` / `k` | Next / previous file |
| `n` / `p` | Next / previous block of changes |
| `s` | Switch between unified and split |
| `Esc` | Close |

## The overview

The overview shows all your sessions at once. Open it with **Overview** at the bottom of the session list, or press
`G` (when you're not typing). Press `G` or `Esc` to go back. It has three views, and remembers the one you used last.

### Grid

Every live session as a card: its name and folder, how many agents it's running, what it's doing right now (or what
it's waiting for you about), and the last thing it said. Cards that need you are red. Click a card to open the
session. The grid shows up to 24 sessions, in your list's order.

### Galaxy

Every session as a star system in one galaxy, its subagents as moons around it. Sessions in the same folder cluster
together under the folder's name. Each star is labelled with its session and what it's doing, and a bubble shows
what it just said. Sessions that ended in the last hour are still there, dimmed.

Drag to turn the galaxy, use the wheel to zoom toward the pointer, and hover a star for its details. Click a star to
fly into that session.

### Deploys

A board of what each environment runs: a row for each service, grouped by project; a column for each environment;
and the newest build of each service. A cell shows the running version, whether it's rolling out, and whether it's
behind the environment before it. **Mine** shows only the services your sessions' tickets change; **All** shows
everything. The top right says which environments your PC can reach right now. Below the board, **Lately** lists the
latest changes.

When dev runs an older version than the newest good build, **Bump dev** lets you update it. Cora shows exactly which
workloads it will change, on which cluster, and does nothing until you confirm. Production and other environments
are only ever read.

The board needs access to your clusters and your GitLab projects; see [Integrations](integrations.md).

### Token use

Along the top of the overview:

- **Today:** output tokens, input tokens (and how much of that came from cache), sessions and turns.
- **The week:** a bar for each of the last seven days. Hover a bar for that day's numbers.
- **N needs you**, when sessions are waiting for you. Click it to go to the first.
- **Most today:** the three sessions that used the most. Click one to open it.

## Good to know

- **Rewind before you scroll.** To see how a long turn unfolded, dragging the timeline's playhead is quicker than
  scrolling the transcript, and the scene rewinds with it.
- **Review turn by turn.** **Review** on the **Changes** tab, then `j`, `k`, `n` and `p`, is the fastest way to read
  everything a turn changed.
- **Ask about a hunk.** **ask Claude about this** saves you typing file names and line numbers.
- **Keep an explain in view.** Pop it out into its own window while you keep working in the session.
- **Find old explains with `Ctrl+K`.** The command palette searches explains from every session, including ones no
  longer in your list.
- **Slow graphics?** The scene turns some effects down by itself when it can't keep up. You can also switch off star
  systems, drifting particles or the nebula in **Settings › Scene**.
- What Cora stores about your sessions, and for how long, is in [Security and privacy](security-and-privacy.md). The
  [Reference](reference.md) lists every setting and shortcut.
