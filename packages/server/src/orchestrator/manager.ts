import type { JiraFresh } from '../jiraFeed';
import { IssueStarts } from './issueStart';
import type { CoraTold } from '../inboxFeeds';
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AWAY_MS, bareWords, choiceOpen, isShell, type BriefKind, type BrainEvent, type SessionInfo, type CiMsg, type GoalState, type OrchestratorStatus, type PendingDecision, type PendingRequest, type Settings, type TerminalInfo, type UiCommand, takesTags, jiraLine, type JiraEvent, type MailHit, type GitlabTodo, type GitlabIssue, todoWhy } from '@cora/shared';
import { terminalInput } from '../input';
import type { PtyManager } from '../pty';
import { Approvals, type ApprovalOutcome } from './approvals';
import { EventFeed, type FeedMode } from './feed';
import { ALLOWED_FILE, GATE_FILE, agentAllowed } from './files';
import { Goals } from './goals';
import { judge, type MandateContext, type MandateRequest, type Verdict } from './mandate';
import { agentArgs, orchestratorDir, readState, writeAgentFiles, writeState } from './files';
import { promptWhat } from './feed';
import { Talk } from './talk';
import { Copies, type CopyRun } from './copy';
import { JiraStarts, type JiraStartDeps } from './jiraStart';
import { defaultClaudeCmd } from '../pty';
import { writeFileAtomic } from '../fsx';

export type OrchDeps = {
  dataDir: string;
  /** where Claude Code keeps transcripts (to tell whether the agent's session can be resumed) */
  projectsDir: string;
  port: number;
  hookToken: string;
  /** the UI's sign-in key: the agent opens Cora's UI with it (for screenshots) */
  /** the view-only key (Cora's agent can look at the dashboard, never act in it) */
  viewToken?: string;
  /** its own key, which unlocks Cora's tools (audit S3) */
  agentToken?: string;
  ptys: Pick<PtyManager, 'launch' | 'list' | 'write' | 'screenLines' | 'end' | 'kill'>;
  settings(): Settings;
  publish(s: OrchestratorStatus): void;
  publishUi(c: UiCommand): void;
  /** its session changed (a new conversation): what was the old one's moves to the new one (Slack watches) */
  rehome?(from: string, to: string): void;
  log?(m: string): void;
  now?(): number;
  /** held permission prompts, to answer under the mandate */
  pending?: { list(): PendingRequest[]; resolve(id: string, d: PendingDecision, by: { via: 'orchestrator'; rule: string }): { ok: boolean } };
  /** a session's folder, branch (from its pipelines' link) and name */
  cwdOf?(sessionId: string): string | undefined;
  branchOf?(sessionId: string): MandateContext['branch'];
  nameOf?(sessionId: string): string;
  /** tokens these sessions used since then (output plus uncached input) */
  usage?(sessionIds: string[], since: number): number;
  /** the agent's session is working (so events wait) */
  agentWorking?(): boolean;
  /** every session (to notice the stuck ones) */
  sessions?(): SessionInfo[];
  /** a session's events since then (oldest first): the replies Cora waits for */
  eventsSince?(sessionId: string, since: number): BrainEvent[];
  /** how side questions run (tests fake it) */
  copyRun?: CopyRun;
  /** Slack is connected (briefs then include what's waiting there) */
  slackConnected?: () => boolean;
  /** watching Jira is on (briefs then include jira_inbox) */
  jiraWatching?: () => boolean;
  /** the MCP servers the user has connected to Claude Code (names): its work tools and its instructions follow them */
  mcpServers?: () => string[];
  /** a ticket session's first prompt (the user's /jira or Cora's ticket prompt; Settings › Jira) */
  ticketPrompt?(e: JiraEvent): Promise<string>;
  /** Gmail is connected (briefs include important email) */
  mailConnected?: () => boolean;
  /** the latest "assigned to you" event for a ticket (starting work from Jira) */
  jiraAssigned?(key: string): JiraEvent | undefined;
  /** GitLab issues: a project's checkout among folders, and one issue as glab reads it */
  issueFolder?(project: string, folders: string[]): Promise<string | null>;
  gitlabIssue?(project: string, iid: number): Promise<GitlabIssue | null>;
  /** how many prompts a session has (a Jira start's first is Cora's) */
  prompts?(sessionId: string): number;
  /** what Cora did or asked (Cora's Inbox) */
  told?(t: CoraTold): void;
  claudeCmd?: string[];
};

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);

/** It keeps stopping: this many exits within the window and it stays stopped until started again. */
const MAX_EXITS = 5;
const EXIT_WINDOW_MS = 10 * 60_000;
const RELAUNCH_MS = [2_000, 10_000, 60_000];

/**
 * The orchestrator agent's life: started when the feature is turned on (resuming its session when it has one),
 * stopped when it's turned off, started again when it exits (giving up if it keeps stopping). Also its chat input,
 * its memory, and its way to drive the dashboard.
 */
export class OrchestratorManager {
  readonly approvals: Approvals;
  readonly dir: string;
  private sid: string | null;
  private error: string | undefined;
  private exits: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** what its terminal is asking (checked every couple of seconds while it runs) */
  private asking: string[] | null = null;
  private watch: NodeJS.Timeout | null = null;
  /** autopilot: what you've handed it */
  readonly goals: Goals;
  /** what it hears */
  readonly feed: EventFeed;
  /** it answers your sessions' prompts (under the mandate) while you're away */
  private control: boolean;
  /** the mandate's verdicts on held prompts (each judged once) */
  private verdicts = new Map<string, Verdict>();
  private ticker: NodeJS.Timeout | null = null;
  private lastSessionsCheck = 0;
  /** when you were last active in the dashboard (kept across restarts, for the welcome-back brief) */
  private lastSeen: number | undefined;
  private lastSeenSaved = 0;
  /** its conversations with sessions */
  readonly talk: Talk;
  /** side questions to copies of sessions */
  readonly copies: Copies;
  /** starting work on tickets assigned to you */
  readonly jiraStarts: JiraStarts;
  readonly issueStarts: IssueStarts;
  /** how it starts sessions (the app's launch, set once the app is built) */
  private launcher: JiraStartDeps['launch'] | null = null;

  constructor(private d: OrchDeps) {
    this.dir = orchestratorDir(d.dataDir);
    const st = readState(this.dir);
    this.sid = st.sessionId ?? null;
    this.control = !!st.control;
    this.lastSeen = st.lastSeen;
    this.approvals = new Approvals({
      file: join(this.dir, 'approvals.json'),
      // cards a restart couldn't keep (answering a session's question: the question went with the restart)
      onLost: (lost) => this.d.told?.({ key: `lost:${this.now()}`, title: `${lost.length} of Cora's cards were lost in a restart`, text: lost.map((a) => `- ${a.title}`).join('\n'), why: 'Cora restarted' }),
      onChange: () => this.changed(),
      // (an escalation's late answer is told by its own action)
      onLate: (a, result) => void (a.kind !== 'ask' && this.feed.note(`The user OKed "${a.title}" after all: ${result}`)),
      onAsk: (a) => this.d.told?.({ key: `ask:${a.id}`, title: a.title, text: a.detail, why: 'Cora asked you', ...(a.sessionId ? { sessionId: a.sessionId } : {}) }),
      onAnswer: (a, ok, result) => this.d.told?.({ key: `ask:${a.id}`, title: a.title, text: ok ? `You said yes. ${result ?? ''}`.trim() : 'You said not now', why: 'Cora asked you', read: true, ...(a.sessionId ? { sessionId: a.sessionId } : {}) }),
    });
    this.goals = new Goals(this.dir, () => this.changed());
    this.feed = new EventFeed({
      deliver: (text, others) => {
        const ok = this.say(text).ok;
        // someone else's words (a Slack reply, an email) start this turn: until it ends (or you speak), Cora acts on
        // nothing and reaches nothing outside (see othersTurn; docs/audit-2026-10-20.md S8)
        if (ok && others) this.othersSince = this.now();
        return ok;
      },
      agentBusy: () => this.agentBusy(),
      mode: () => this.feedMode(),
      isWorker: (sid) => this.goals.isWorker(sid),
      isAgent: (sid) => this.isAgent(sid),
      name: (sid) => this.d.nameOf?.(sid) ?? sid.slice(0, 8),
      now: () => this.now(),
    });
    this.talk = new Talk({
      events: (sid, since) => this.d.eventsSince?.(sid, since) ?? [],
      heldOn: (sid) => {
        const p = this.d.pending?.list().find((x) => x.sessionId === sid);
        return p ? { what: promptWhat(p), since: p.createdAt } : undefined;
      },
      onLate: (sid, r) => {
        const name = this.d.nameOf?.(sid) ?? sid.slice(0, 8);
        const body = r.text.length > 2000 ? `${r.text.slice(0, 1999)}… (ask_copy or session for the rest)` : r.text;
        this.feed.note(`"${name}" (${sid}) replied to what you asked${r.tools.length ? ` (it used ${r.tools.join(', ')})` : ''}: ${body || '(no words: only tool calls)'}`);
      },
      onChange: () => this.changed(),
      now: () => this.now(),
    });
    this.copies = new Copies({ dir: join(this.dir, 'copy'), claudeCmd: () => this.d.claudeCmd ?? defaultClaudeCmd(), run: d.copyRun });
    this.issueStarts = new IssueStarts({
      mode: () => this.d.settings().gitlab.start ?? 'offer',
      sessions: () => this.d.sessions?.() ?? [],
      isDir: (p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
      folderFor: (project, folders) => this.d.issueFolder?.(project, folders) ?? Promise.resolve(null),
      issue: (project, iid) => this.d.gitlabIssue?.(project, iid) ?? Promise.resolve(null),
      approvals: this.approvals,
      launch: async (o) => {
        if (!this.launcher) throw new Error("Cora can't start sessions right now");
        return this.launcher(o);
      },
      prompts: (sid) => this.d.prompts?.(sid) ?? 0,
      focus: (sid) => this.ui({ action: 'focus', sessionId: sid }),
      note: (l) => this.feed.note(l),
      changed: () => this.changed(),
      started: (r) =>
        this.d.told?.({
          key: `start:gl:${r.project}#${r.iid}`,
          title: `Started #${r.iid} in ${r.cwd.split(/[\\/]/).filter(Boolean).pop() ?? r.cwd}`,
          text: r.auto ? `On its own: it sums up ${r.project}#${r.iid} and diagnoses it, then stops at a plan` : 'You said start',
          why: r.auto ? 'assigned to you, and Cora starts these' : 'assigned to you',
          sessionId: r.sessionId,
        }),
      file: join(this.dir, 'issue-starts.json'),
      now: () => this.now(),
    });
    this.jiraStarts = new JiraStarts({
      mode: () => this.d.settings().jira.watch.start,
      listening: () => this.enabled() && !!this.terminal() && this.feedMode() !== 'off',
      sessions: () => this.d.sessions?.() ?? [],
      repos: () => this.d.settings().orchestrator.mandate.repos,
      isDir: (p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
      assigned: (key) => this.d.jiraAssigned?.(key),
      ...(this.d.ticketPrompt ? { ticketPrompt: (e: JiraEvent) => this.d.ticketPrompt!(e) } : {}),
      approvals: this.approvals,
      launch: async (o) => {
        if (!this.launcher) throw new Error("Cora can't start sessions right now");
        return this.launcher(o);
      },
      prompts: (sid) => this.d.prompts?.(sid) ?? 0,
      focus: (sid) => this.ui({ action: 'focus', sessionId: sid }),
      userTurn: () => this.userTurn(),
      note: (l) => this.feed.note(l),
      changed: () => this.changed(),
      started: (r) =>
        this.d.told?.({
          key: `start:${r.key}`,
          title: `Started ${r.key} in ${r.cwd.split(/[\\/]/).filter(Boolean).pop() ?? r.cwd}`,
          text: r.auto ? `On its own: it reads ${r.key}, then stops at a plan` : 'You said start',
          why: r.auto ? 'assigned to you, and Cora starts these' : 'assigned to you',
          sessionId: r.sessionId,
          ...(r.auto ? {} : { read: true }),
        }),
      file: join(this.dir, 'jira-starts.json'),
      now: () => this.now(),
    });
  }

  /** The user's connected MCP servers (names), looked at when it starts. */
  private mcp(): string[] {
    try {
      return this.d.mcpServers?.() ?? [];
    } catch {
      return [];
    }
  }

  /** Start a hosted session (an email watch set with Cora, when its email comes): the app's own launch. */
  launchSession(o: Parameters<JiraStartDeps['launch']>[0]): ReturnType<JiraStartDeps['launch']> {
    if (!this.launcher) return Promise.reject(new Error("Cora can't start sessions right now"));
    return this.launcher(o);
  }

  /** How it starts sessions: the app's own launch (a hosted session, its first prompt typed in when it's ready). */
  setLauncher(fn: JiraStartDeps['launch']): void {
    this.launcher = fn;
  }

  /** A session's event: the replies Cora waits for, then what it hears. */
  event(e: BrainEvent): void {
    // the turn someone else's Slack words started is over
    if (this.othersSince != null && this.isAgent(e.sessionId) && e.kind === 'turn_end' && e.ts >= this.othersSince) this.othersSince = null;
    const awaited = this.talk.event(e);
    // a reply it was waiting for isn't news twice
    if (awaited && e.kind === 'turn_end') return;
    this.feed.event(e);
  }

  private now = () => this.d.now?.() ?? Date.now();
  private enabled = () => this.d.settings().orchestrator.enabled;

  sessionId(): string | null {
    return this.sid;
  }
  isAgent(sessionId: string | null | undefined): boolean {
    return !!sessionId && sessionId === this.sid;
  }
  terminal(): TerminalInfo | undefined {
    return this.sid ? this.d.ptys.list().find((t) => t.sessionId === this.sid && t.alive && !isShell(t)) : undefined;
  }

  status(): OrchestratorStatus {
    const t = this.terminal();
    const s = this.d.settings().orchestrator;
    return {
      enabled: s.enabled,
      speak: s.speak,
      model: s.model,
      sessionId: this.sid,
      terminalId: t?.terminalId ?? null,
      running: !!t,
      ...(this.error ? { error: this.error } : {}),
      approvals: this.approvals.list(),
      ...(t && this.asking ? { asking: this.asking } : {}),
      control: s.enabled && this.control,
      goal: s.enabled ? this.goals.current() : null,
      talks: s.enabled ? this.talk.list() : [],
      ...(s.enabled ? { jiraStarted: this.jiraStarts.started() } : {}),
    };
  }
  changed(): void {
    this.d.publish(this.status());
  }

  /** Its terminal is hidden: watch it for a question (the first start asks whether to trust its folder). */
  private watchAsking(on: boolean): void {
    if (on && !this.watch) {
      this.watch = setInterval(() => {
        const t = this.terminal();
        const lines = t ? this.d.ptys.screenLines(t.terminalId) : null;
        const next = lines && choiceOpen(lines) ? questionOf(lines) : null;
        if (JSON.stringify(next) !== JSON.stringify(this.asking)) {
          this.asking = next;
          this.changed();
        }
      }, 1500);
      this.watch.unref?.();
    } else if (!on && this.watch) {
      clearInterval(this.watch);
      this.watch = null;
      this.asking = null;
    }
  }

  /** Answer its terminal's question: an option's number, Enter or Esc. */
  key(k: string): { ok: boolean; error?: string } {
    const t = this.terminal();
    if (!t) return { ok: false, error: 'Cora is not running' };
    const data = /^[1-9]$/.test(k) ? k : k === 'enter' ? '\r' : k === 'esc' ? '\x1b' : null;
    if (!data) return { ok: false, error: 'a number from 1 to 9, enter or esc' };
    this.d.ptys.write(t.terminalId, data);
    return { ok: true };
  }

  /** Settings changed (or the server started): run it when it's on, stop it when it's off. */
  apply(): void {
    this.watchAsking(this.enabled());
    this.tickEvery(this.enabled());
    if (this.enabled()) {
      if (!this.terminal() && !this.timer && !this.error) this.start();
      // still running from before Cora's agent had its own key (or its gate): its tools would be gone, so it starts
      // again (resumed: the same conversation) with a config that has them (audit S3, S8)
      else if (this.terminal() && this.d.agentToken && !this.configHasKey()) this.restart();
      else this.changed();
    } else this.stop();
  }

  /** Is the running agent's config current: its key in its MCP config, its gate (audit S8), its allowed tools (B9)? */
  private configHasKey(): boolean {
    try {
      return (
        readFileSync(join(this.dir, 'mcp.json'), 'utf8').includes(this.d.agentToken!) &&
        existsSync(join(this.dir, GATE_FILE)) &&
        readFileSync(join(this.dir, ALLOWED_FILE), 'utf8') === agentAllowed(this.mcp())
      );
    } catch {
      return false;
    }
  }

  /** Has Claude Code got a transcript for this session (so it can be resumed)? */
  private hasTranscript(sid: string): boolean {
    try {
      return readdirSync(this.d.projectsDir).some((p) => existsSync(join(this.d.projectsDir, p, `${sid}.jsonl`)));
    } catch {
      return false;
    }
  }

  start(): void {
    if (this.terminal()) return;
    const s = this.d.settings().orchestrator;
    try {
      writeAgentFiles(this.dir, { name: 'Cora', mcp: this.mcp() });
      const id = this.sid ?? randomUUID();
      const resume = !!this.sid && this.hasTranscript(this.sid);
      const args = agentArgs({ port: this.d.port, hookToken: this.d.hookToken, ...(this.d.agentToken ? { agentToken: this.d.agentToken } : {}), ...(this.d.viewToken ? { viewToken: this.d.viewToken } : {}), sessionId: id, model: s.model, dir: this.dir, speak: s.speak, instructions: s.instructions, tags: takesTags(this.d.settings().voice?.model ?? ''), mcp: this.mcp() });
      this.d.ptys.launch(resume ? { mode: 'resume', cwd: this.dir, sessionId: id, args, bare: true } : { mode: 'new', cwd: this.dir, newId: id, args, bare: true });
      if (this.sid !== id) writeState(this.dir, { sessionId: id });
      this.sid = id;
      this.error = undefined;
      this.d.log?.(`orchestrator: ${resume ? 'resumed' : 'started'} (${id.slice(0, 8)})`);
    } catch (e) {
      this.error = `couldn't start: ${(e as Error).message}`;
      this.d.log?.(`orchestrator: ${this.error}`);
    }
    this.changed();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const t = this.terminal();
    if (t) this.d.ptys.end(t.terminalId);
    this.approvals.clear();
    this.talk.endAll();
    this.changed();
  }

  /** Start again from Settings after it gave up (or to pick up a new model). */
  restart(): void {
    this.exits = [];
    this.error = undefined;
    const t = this.terminal();
    if (t) this.d.ptys.kill(t.terminalId);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.enabled()) this.start();
  }

  /** A terminal exited: if it was the agent's and the feature is on, start it again (unless it keeps stopping). */
  exited(t: TerminalInfo): void {
    // a worker's terminal closing is news (it may not have said anything Cora would hear)
    if (!isShell(t) && this.goals.isWorker(t.sessionId) && this.goals.active()) this.feed.note(`"${this.d.nameOf?.(t.sessionId) ?? t.sessionId.slice(0, 8)}" (${t.sessionId}) exited: its terminal closed.`);
    if (!this.isAgent(t.sessionId) || isShell(t)) return;
    if (!this.enabled()) return this.changed();
    const now = this.now();
    this.exits = [...this.exits.filter((x) => now - x < EXIT_WINDOW_MS), now];
    if (this.exits.length >= MAX_EXITS) {
      this.error = `Cora stopped ${MAX_EXITS} times in ${EXIT_WINDOW_MS / 60_000} minutes, so it's off until you start it again`;
      this.d.log?.(`orchestrator: ${this.error}`);
      return this.changed();
    }
    const wait = RELAUNCH_MS[Math.min(this.exits.length - 1, RELAUNCH_MS.length - 1)];
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.enabled()) this.start();
    }, wait);
    this.changed();
  }

  /**
   * A new conversation: a fresh session (on the model in its settings), when the old one can't go on (flagged, too
   * long, gone strange). What it remembers, your instructions, its goals and the Slack threads it watches are kept.
   */
  newConversation(): void {
    const old = this.sid;
    const t = this.terminal();
    if (t) this.d.ptys.kill(t.terminalId);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.approvals.clear();
    this.sid = null;
    this.exits = [];
    this.error = undefined;
    writeState(this.dir, {});
    if (!this.enabled()) return this.changed();
    this.start();
    if (old && this.sid && old !== this.sid) this.d.rehome?.(old, this.sid);
    this.feed.note("This is a new conversation: the user started it fresh (the last one couldn't go on). What you remember is in memory.md; read it before you answer.");
    this.changed();
  }

  /** Forget everything: its session (it starts a fresh one) and its memory. */
  forget(): void {
    const on = this.enabled();
    const t = this.terminal();
    if (t) this.d.ptys.kill(t.terminalId);
    this.approvals.clear();
    this.sid = null;
    this.exits = [];
    this.error = undefined;
    writeState(this.dir, {});
    rmSync(join(this.dir, 'memory.md'), { force: true });
    if (on) this.start();
    else this.changed();
  }

  /**
   * You, in the console, by voice or from its Slack DM: typed into the agent's input and sent ("stand down" on its own
   * stands it down, whichever way it came: the note of where it came from isn't part of your words, audit B6).
   */
  sayFromUser(text: string): { ok: boolean; error?: string } {
    if (/^\s*(cora[,:]?\s*)?stand\s*down[.!]*\s*(,?\s*cora[.!]*)?\s*$/i.test(bareWords(text))) {
      this.standDown();
      return { ok: true };
    }
    // what it was holding (Jira) goes in with your words, so it knows when you ask
    const held = this.feed.takeHeld();
    const r = this.say(held.length ? `${held.map((l) => `- ${l}`).join('\n')}\n\n${text}` : text);
    if (r.ok) this.noteUserInput();
    else for (const l of held) this.feed.hold(l);
    return r;
  }

  /**
   * New important mail: Cora knows, without a turn of its own (held, it goes in with your next words). Only that it
   * came and from which address: what it says is someone else's words, so it's never put in with yours; gmail_read
   * shows it, quoted as theirs (docs/audit-2026-10-20.md S8).
   */
  mailNotes(hits: MailHit[]): void {
    const clean = (s: string) => s.replace(/[\[\]]/g, (c) => (c === '[' ? '(' : ')')).replace(/\s+/g, ' ').trim();
    const addr = (s: string) => (/<([^<>\s]+@[^<>\s]+)>/.exec(s)?.[1] ?? s).replace(/[^\w.@+-]/g, '').slice(0, 80);
    for (const h of hits.slice(0, 5)) this.feed.hold(`[Gmail] A new email the user watches for${h.why ? ` (${clean(h.why)})` : ''} from ${addr(h.from)} (gmail_read ${h.id})`);
    if (hits.length > 5) this.feed.hold(`[Gmail] ${hits.length - 5} more emails the user watches for (gmail_inbox has them)`);
  }

  /** New GitLab to-dos (already told to the user): Cora knows, without a turn of its own. */
  gitlabNotes(todos: GitlabTodo[]): void {
    // which MR or issue and why, never its text (someone else's words: the Inbox quotes them as theirs)
    const name = (s: string) => s.replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 40);
    for (const t of todos.slice(0, 5)) this.feed.hold(`[GitLab] ${t.project}${t.ref}: ${todoWhy(t.action)}, by ${name(t.who)} (in the Inbox; ${t.link})`);
    if (todos.length > 5) this.feed.hold(`[GitLab] ${todos.length - 5} more GitLab to-dos (in the Inbox)`);
  }

  /** New GitLab to-dos: the issues assigned to you are offered or started (Settings › GitLab), with Cora on. */
  issueTodos(todos: GitlabTodo[]): void {
    if (this.enabled()) void this.issueStarts.todos(todos);
  }

  /** New in Jira (already told to the user): Cora knows, without a turn of its own. */
  jiraNotes(f: JiraFresh): void {
    // assigned to you, and Cora offers or starts it: a turn of its own, to pick the folder
    for (const e of f.events) if (e.handoff) this.feed.note(this.jiraStarts.turnText(e));
    const rest = f.events.filter((e) => !e.handoff);
    if (f.summary) this.feed.hold(`[Jira] ${f.summary} (jira_inbox has them)`);
    // which ticket and what happened, never its text (that's someone else's words: jira_inbox quotes it as theirs)
    else for (const e of rest) this.feed.hold(`[Jira] ${e.key}: ${e.who.replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 40)} ${e.what} (jira_inbox has it)`);
  }

  /** Who its latest input came from: you (your words, typed or spoken) or itself (events, briefs, goals). */
  private lastInput: { from: 'user' | 'cora'; at: number } | null = null;
  /** You said something to it (the console, or push-to-talk into its terminal). */
  noteUserInput(): void {
    this.lastInput = { from: 'user', at: Date.now() };
    this.othersSince = null;
  }
  /** When someone else's Slack words started the turn it's on (null: it isn't). */
  private othersSince: number | null = null;
  /**
   * Is it on a turn someone else's Slack words started (a reply in a conversation it carries on, or a thread it
   * watches)? Then nothing it does may touch your machine: its action tools refuse and its permission prompts are
   * denied, whatever the words ask. It can still read, and reply in that conversation. A long turn ends this anyway.
   */
  othersTurn(): boolean {
    if (this.othersSince == null) return false;
    if (this.now() - this.othersSince > 20 * 60_000) return (this.othersSince = null), false;
    return true;
  }
  /**
   * Is it working on something you just asked, in your own words? (What it hears waits while it's busy, so nothing
   * else takes over a turn you started.) Then a Slack message you asked for goes out at once.
   */
  userTurn(): boolean {
    return this.lastInput?.from === 'user' && Date.now() - this.lastInput.at < 15 * 60_000;
  }
  /** The terminal Cora runs in (to tell your words to it apart). */
  agentTerminal(): string | null {
    return this.terminal()?.terminalId ?? null;
  }

  /** Typed into the agent's input and sent. */
  say(text: string): { ok: boolean; error?: string } {
    const t = this.terminal();
    if (!t) return { ok: false, error: this.enabled() ? 'Cora is starting; try again in a moment' : 'Cora is off (Settings → Cora Orchestrator)' };
    const input = terminalInput(text);
    if ('error' in input) return { ok: false, error: input.error };
    const lines = this.d.ptys.screenLines(t.terminalId);
    if (lines && choiceOpen(lines)) return { ok: false, error: 'Cora is waiting on a choice in its terminal' };
    this.d.ptys.write(t.terminalId, input.data);
    setTimeout(() => this.d.ptys.write(t.terminalId, '\r'), input.paste ? 150 : 80);
    // its own input (sayFromUser marks yours after this)
    this.lastInput = { from: 'cora', at: Date.now() };
    return { ok: true };
  }

  // ------------------------------------------------------------------ autopilot

  private feedMode(): FeedMode {
    if (!this.enabled()) return 'off';
    return this.goals.active() ? 'autopilot' : this.d.settings().orchestrator.events;
  }

  /** The agent is working, or its terminal is asking something: what it hears waits. */
  agentBusy(): boolean {
    const t = this.terminal();
    if (!t) return true;
    const lines = this.d.ptys.screenLines(t.terminalId);
    if (lines && choiceOpen(lines)) return true;
    return !!this.d.agentWorking?.();
  }

  /** The mandate for a session (its folder and branch). */
  mandateFor(sessionId: string): MandateContext {
    return { mandate: this.d.settings().orchestrator.mandate, branch: this.d.branchOf?.(sessionId) };
  }
  judge(sessionId: string, req: Omit<MandateRequest, 'cwd'>): Verdict {
    return judge({ ...req, cwd: this.d.cwdOf?.(sessionId) ?? '' }, this.mandateFor(sessionId));
  }

  /** You handed Cora control (Away in its console): it answers prompts within its mandate, and you count as away. */
  inControl(): boolean {
    return this.d.settings().orchestrator.enabled && this.control;
  }

  setControl(on: boolean): void {
    if (this.control === on) return this.changed();
    this.control = on;
    writeState(this.dir, { ...readState(this.dir), control: on });
    this.feed.note(on ? 'The user handed you control: your mandate now answers every session\'s permission prompts while they\'re away. Watch what comes in and tell them what matters.' : 'The user took control back: prompts go to them again.');
    this.changed();
    if (on) this.pendingChanged(this.d.pending?.list() ?? []);
  }

  /** You give it a goal: it's told what, its mandate and its budget, and gets on with it. */
  startGoal(text: string, budget?: number): { ok: boolean; error?: string } {
    if (!this.terminal()) return { ok: false, error: this.enabled() ? 'Cora is starting; try again in a moment' : 'Cora is off' };
    const t = text.trim();
    if (!t) return { ok: false, error: 'say what the goal is' };
    const s = this.d.settings().orchestrator;
    const g = this.goals.start(t, budget ?? s.budget, this.now());
    const m = s.mandate;
    const brief = [
      `[Cora goal] ${g.text}`,
      '',
      `You're on autopilot for this. Your mandate: in ${m.repos.length ? m.repos.join(', ') : '(no repos yet: everything asks the user)'}, you may have sessions read, edit, test, build, commit and push feature branches${m.deploy ? ', and deploy' : ''}; merges, ${m.deploy ? '' : 'deploys, '}messages to people and anything else ask the user. Force-pushes, the default branch, deleting branches or data: never.`,
      `Budget: ${fmtTokens(g.budget)} tokens across the goal's sessions.`,
      'Do the work in sessions: start_session (in a mandate repo, no OK needed) and send_to_session to direct them. Their permission prompts are answered by the mandate; you hear what happens as [Cora] lines.',
      'Report with goal_update (state, progress 0..1, a note) at each milestone; when you need the user, escalate. When it\'s done, goal_update state done with what was done.',
    ].join('\n');
    this.sayWhenFree(brief);
    this.changed();
    return { ok: true };
  }

  /** What it must hear that its terminal couldn't take yet (a menu was open): tried again until it does (audit B10). */
  private due: Array<{ text: string; until: number }> = [];
  private dueTimer: NodeJS.Timeout | null = null;
  /** Typed in now, or as soon as its terminal can take it (each once, one at a time; given up on after 10 minutes). */
  private sayWhenFree(text: string): void {
    if (!this.due.length && this.say(text).ok) return;
    this.due.push({ text, until: this.now() + 10 * 60_000 });
    if (this.dueTimer) return;
    this.dueTimer = setInterval(() => {
      const d = this.due[0];
      if (d && this.now() > d.until) {
        this.due.shift();
        this.d.log?.(`orchestrator: gave up giving it: ${d.text.slice(0, 80)}`);
        this.ui({ action: 'notify', text: "Cora's terminal stayed busy, so it didn't get what you gave it. Try again." });
      } else if (d && this.say(d.text).ok) this.due.shift();
      // one a tick: the next waits for this one's Enter
      if (!this.due.length && this.dueTimer) {
        clearInterval(this.dueTimer);
        this.dueTimer = null;
      }
    }, 2000);
    this.dueTimer.unref?.();
  }

  stopGoal(why = 'the user stopped it'): void {
    if (!this.goals.stop(why)) return;
    this.feed.note(`The goal was stopped (${why}). Don't start or send anything more for it.`);
    this.changed();
  }

  /** Stand down: the goal ends, control goes back to you, the agent stops what it's doing. Workers are left as they are. */
  standDown(): void {
    this.goals.stop('the user stood you down');
    this.control = false;
    writeState(this.dir, { ...readState(this.dir), control: false });
    this.talk.endAll();
    for (const a of this.approvals.list()) void this.approvals.decide(a.id, { ok: false });
    const t = this.terminal();
    if (t) {
      this.d.ptys.write(t.terminalId, '\x1b');
      setTimeout(() => this.sayWhenFree("[Cora] Stand down: the user has taken over. Stop everything now; don't start, send, approve or escalate anything until they ask you to."), 600);
    }
    this.d.log?.('orchestrator: stood down');
    this.changed();
  }

  /** Cora asks you something: a card in its console; your answer goes back to it (even if it stopped waiting). */
  escalate(question: string, options?: string[]): Promise<ApprovalOutcome> {
    if (this.goals.active()) this.goals.update({ state: 'waiting' });
    return this.approvals.request({ kind: 'ask', title: question.slice(0, 300), detail: 'Cora asks', text: '', ...(options?.length ? { options: options.slice(0, 6).map((o) => o.slice(0, 80)) } : {}) }, async (answer, late) => {
      const a = (answer ?? '').trim() || '(no answer)';
      if (this.goals.active()?.state === 'waiting') this.goals.update({ state: 'running' });
      if (late) this.feed.note(`The user answered your question "${question.slice(0, 120)}": ${a}`);
      return `The user answered: ${a}`;
    }, { do: 'ask', question });
  }

  /**
   * You're active in the dashboard. Back after a few hours away (and briefs on): Cora catches you up. Saved now and
   * then, so a night's sleep (or a restart) counts.
   */
  presence(): { briefed: boolean } {
    const now = this.now();
    const away = this.lastSeen !== undefined ? now - this.lastSeen : 0;
    this.lastSeen = now;
    if (now - this.lastSeenSaved > 60_000) {
      this.lastSeenSaved = now;
      writeState(this.dir, { ...readState(this.dir), lastSeen: now });
    }
    if (away < AWAY_MS || this.d.settings().orchestrator.briefs === 'off') return { briefed: false };
    // a menu open in its terminal doesn't cost you the catch-up: it comes once it can (audit B10)
    return { briefed: this.brief('welcome', away, true).ok };
  }

  /** A brief: catching you up (back from away, or asked), or wrapping up the day. `whenFree`: later if not now. */
  brief(kind: BriefKind, awayMs = 0, whenFree = false): { ok: boolean; error?: string } {
    const look = 'Look first (sessions, pending, pipelines, security, and the goal if there is one); never guess.';
    const text =
      kind === 'wrap'
        ? `[Cora wrap-up] The user is wrapping up for now. Sum up the work across their sessions since this morning (start from the sessions' recaps: recaps with since 14h): what got done, what's still open, anything left running or waiting on them. Then say what to pick up first next time. ${look} Remember anything worth keeping with remember. Keep it to about a minute to hear.`
        : `[Cora brief] ${kind === 'welcome' ? `The user is back after ${Math.round(awayMs / 3600_000)} hours away.` : 'The user asked for a brief.'} Catch them up: what needs them now first (prompts and questions waiting, failures${this.d.slackConnected?.() ? `, and Slack DMs and mentions waiting for them: slack_inbox with since ${kind === 'welcome' ? `${Math.max(1, Math.round(awayMs / 3600_000))}h` : '8h'}` : ''}${this.d.jiraWatching?.() ? `, and Jira (assigned to them, mentions, comments): jira_inbox with since ${kind === 'welcome' ? `${Math.max(1, Math.round(awayMs / 3600_000))}h` : '8h'}` : ''}${this.d.mailConnected?.() ? `, and email they watch for: gmail_inbox with since ${kind === 'welcome' ? `${Math.max(1, Math.round(awayMs / 3600_000))}h` : '8h'}` : ''}), then what happened${kind === 'welcome' ? ' while they were away' : ''} (start from the sessions' recaps, Claude Code's own summaries: recaps with since ${kind === 'welcome' ? `${Math.max(1, Math.round(awayMs / 3600_000))}h` : '8h'}; then sessions that finished, what they did, pipelines), then anything else worth knowing. ${look} Offer the obvious next steps. Keep it to about a minute to hear; skip what's quiet.`;
    // later is fine: its terminal busy with a menu, or not up yet (Cora still starting when you sit down in the morning)
    if (whenFree && this.enabled()) {
      this.sayWhenFree(text);
      this.d.log?.(`orchestrator: brief (${kind})`);
      return { ok: true };
    }
    const r = this.say(text);
    if (r.ok) this.d.log?.(`orchestrator: ${kind === 'wrap' ? 'wrap-up' : `brief (${kind})`}`);
    return r;
  }

  /** Report on the goal (from the agent). */
  goalUpdate(p: { state?: GoalState; progress?: number; note?: string }): boolean {
    const g = this.goals.update(p);
    if (g && (g.state === 'done' || g.state === 'blocked')) this.ui({ action: 'notify', text: g.state === 'done' ? `Done: ${g.note ?? g.text}` : `Cora is blocked: ${g.note ?? g.text}` });
    return !!g;
  }

  /** Held prompts changed: answer the ones in scope (a goal's workers, or any session while it has control) by the mandate. */
  pendingChanged(list: PendingRequest[]): void {
    try {
      this.pendingChangedUnsafe(list);
    } catch (e) {
      this.d.log?.(`orchestrator: prompts: ${(e as Error).message}`);
    }
  }
  private pendingChangedUnsafe(list: PendingRequest[]): void {
    if (!this.enabled() || !this.d.pending) return;
    const goal = this.goals.active();
    const budgetOk = !goal || goal.state !== 'blocked';
    const todo: Array<[PendingRequest, Verdict]> = [];
    for (const p of list) {
      if (!p.sessionId || this.verdicts.has(p.id) || this.isAgent(p.sessionId)) continue;
      if (!this.goals.isWorker(p.sessionId) && !this.control) continue;
      const v = this.judge(p.sessionId, { tool: p.toolName, input: p.toolInput, kind: p.kind });
      const verdict = v.verdict === 'allow' && !budgetOk ? { verdict: 'ask' as const, rule: 'budget', why: "the goal's budget is spent" } : v;
      this.verdicts.set(p.id, verdict);
      todo.push([p, verdict]);
    }
    this.feed.pending(list, this.verdicts);
    // answered after the pending manager has finished telling everyone (it calls us from its change notice)
    if (todo.length)
      setTimeout(() => {
        for (const [p, v] of todo) {
          try {
            this.resolveOne(p, v);
          } catch (e) {
            this.d.log?.(`orchestrator: answering a prompt: ${(e as Error).message}`);
          }
        }
      }, 0);
    // forget verdicts for prompts that are gone
    const ids = new Set(list.map((p) => p.id));
    if (this.verdicts.size > 500) for (const id of this.verdicts.keys()) if (!ids.has(id)) this.verdicts.delete(id);
  }

  /** Carry out the mandate's verdict on one held prompt (an "ask" stays with you). */
  private resolveOne(p: PendingRequest, v: Verdict): void {
    if (v.verdict === 'allow') this.d.pending!.resolve(p.id, { decision: 'allow' }, { via: 'orchestrator', rule: v.rule });
    else if (v.verdict === 'refuse') this.d.pending!.resolve(p.id, { decision: 'deny', message: `Not allowed by Cora's mandate: ${v.why}. Don't try another way round it; tell the user if it's needed.` }, { via: 'orchestrator', rule: v.rule });
  }

  /** Pipelines changed: the ones the goal's workers (or anyone's, when they fail) follow. */
  ciChanged(m: CiMsg): void {
    try {
      this.ciChangedUnsafe(m);
    } catch (e) {
      this.d.log?.(`orchestrator: pipelines: ${(e as Error).message}`);
    }
  }
  private ciChangedUnsafe(m: CiMsg): void {
    if (!this.enabled() || !m.pipelines?.length) return;
    for (const p of m.pipelines) {
      const sids = (m.links ?? []).filter((l) => l.pipelines.some((x) => x.key === p.key)).map((l) => l.sessionId);
      this.feed.pipeline(p, sids);
    }
  }

  /** Every few seconds: the budget, prompts that have waited, what it hears. */
  tick(): void {
    try {
      this.tickUnsafe();
    } catch (e) {
      this.d.log?.(`orchestrator: ${(e as Error).message}`);
    }
  }
  private tickUnsafe(): void {
    const g = this.goals.active();
    if (g && this.d.usage) {
      const spent = this.d.usage([...g.workers, ...(this.sid ? [this.sid] : [])], g.createdAt);
      this.goals.setSpent(spent);
      if (spent > g.budget && g.state !== 'blocked') {
        this.goals.update({ state: 'blocked', note: `budget reached (${fmtTokens(g.budget)} tokens)` });
        this.feed.note(`The goal's budget (${fmtTokens(g.budget)} tokens) is spent: stop starting or sending work, and tell the user where things stand. Prompts now go to them.`);
        this.ui({ action: 'notify', text: `Cora's goal reached its budget (${fmtTokens(g.budget)} tokens)` });
      }
    }
    if (this.d.pending) this.feed.pending(this.d.pending.list(), this.verdicts);
    if (this.d.sessions && this.now() - this.lastSessionsCheck >= 30_000) {
      this.lastSessionsCheck = this.now();
      this.feed.sessions(this.d.sessions());
    }
    this.feed.tick();
  }
  private tickEvery(on: boolean): void {
    if (on && !this.ticker) {
      this.ticker = setInterval(() => this.tick(), 5000);
      this.ticker.unref?.();
    } else if (!on && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }
  dispose(): void {
    if (this.dueTimer) clearInterval(this.dueTimer);
    this.dueTimer = null;
    this.tickEvery(false);
    this.watchAsking(false);
    this.talk.dispose();
  }

  ui(cmd: UiCommand): void {
    this.d.publishUi(cmd);
  }

  memoryFile(): string {
    return join(this.dir, 'memory.md');
  }
  readMemory(): string {
    try {
      return readFileSync(this.memoryFile(), 'utf8');
    } catch {
      return '';
    }
  }
  writeMemory(text: string): void {
    writeAgentFiles(this.dir, { name: 'Cora', mcp: this.mcp() });
    writeFileAtomic(this.memoryFile(), text);
  }
  /** Returns how big memory.md now is (bytes), so a long one can be tidied. */
  remember(note: string): number {
    writeAgentFiles(this.dir, { name: 'Cora', mcp: this.mcp() });
    const line = note.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (line) appendFileSync(this.memoryFile(), `- ${line}\n`);
    try {
      return statSync(this.memoryFile()).size;
    } catch {
      return 0;
    }
  }
}

const RULE = /^[─━]{8,}$/;
/** A question on Claude Code's screen: from the second-to-last full-width rule down (or the last rows), trimmed. */
export function questionOf(lines: string[]): string[] {
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  const rules: number[] = [];
  for (let i = 0; i <= end; i++) if (RULE.test(lines[i].trim())) rules.push(i);
  const start = rules.length >= 2 ? rules[rules.length - 2] + 1 : rules.length === 1 ? rules[0] + 1 : Math.max(0, end - 11);
  return lines
    .slice(start, end + 1)
    .map((l) => l.replace(/^[\s│┃|]+|[\s│┃|]+$/g, ''))
    .filter((l) => l && !RULE.test(l) && !/^[╭╰─]+/.test(l))
    .slice(0, 16);
}
