/**
 * The Cora Orchestrator ("Cora"): an opt-in master agent that can see everything Cora sees and act across the app.
 * Phase 1: you talk to it (chat or voice); it looks things up, drives the dashboard, and starts or directs sessions
 * once you OK each action. These are the shapes the server, the agent's tools and the dashboard share.
 */

/**
 * What Cora may do on autopilot (and with control): the trusted-engineer mandate. Edits, tests, builds, commits and
 * pushes to feature branches in these repos; deploys only when allowed; Slack only in these channels.
 */
export type Mandate = { repos: string[]; deploy: boolean; slack: string[] };

export type OrchestratorSettings = {
  /** the whole feature: off means no eye, no tools, no agent session */
  enabled: boolean;
  /** the agent's model (a Claude Code --model value) */
  model: string;
  /** say the agent's replies aloud (when voice is set up) */
  speak: boolean;
  mandate: Mandate;
  /** a goal's token budget (output plus uncached input, across its sessions) */
  budget: number;
  /** outside autopilot, what Cora hears about: the important things (a pipeline failed, a prompt waiting a while), or nothing */
  events: 'important' | 'off';
  /** a brief when you're back after a few hours away (what happened, what needs you), or none */
  briefs: 'welcome' | 'off';
  /** your own instructions for Cora (how it sounds, standing rules), in its system prompt on every start */
  instructions?: string;
  /**
   * Your own work MCP servers Cora knows (beyond the common ones built in), by the server's name: what it's for, and
   * its read-only tools, which Cora may use without asking.
   */
  workServers?: Record<string, WorkServer>;
};

/** A work MCP server Cora knows: what it's for (named in its instructions) and its read-only tools. */
export type WorkServer = { about: string; read: string[] };
/** How many of your own, and how many tools each. */
export const WORK_SERVERS_MAX = 20;
export const WORK_TOOLS_MAX = 100;

/** How long your instructions for Cora may be. */
export const INSTRUCTIONS_MAX = 4000;

/** Briefs: when you come back after this long away, Cora catches you up (when briefs are on). */
export const AWAY_MS = 3 * 3600_000;
export type BriefKind = 'welcome' | 'now' | 'wrap';

export const DEFAULT_MANDATE: Mandate = { repos: [], deploy: false, slack: [] };
export const DEFAULT_ORCHESTRATOR: OrchestratorSettings = { enabled: false, model: 'opus', speak: true, mandate: DEFAULT_MANDATE, budget: 5_000_000, events: 'important', briefs: 'welcome' };

/** The hard limits: refused in every mode, whatever the mandate says. */
export const HARD_LIMITS = [
  'force-pushing (--force, --force-with-lease, +refspec)',
  'pushing to (or deleting) a default branch',
  'deleting branches',
  'dropping databases or tables',
  'recursive deletes outside the repo or at a root',
] as const;

export type GoalState = 'running' | 'waiting' | 'blocked' | 'done' | 'stopped';

/** Something you've handed Cora to get done, on autopilot. */
export type Goal = {
  id: string;
  text: string;
  state: GoalState;
  createdAt: number;
  updatedAt: number;
  /** its token budget, and what its sessions have used so far */
  budget: number;
  spent: number;
  /** the sessions working on it (started or directed by Cora) */
  workers: string[];
  /** 0..1, as Cora reports it */
  progress?: number;
  /** Cora's latest word on it */
  note?: string;
  endedAt?: number;
};

/** A folder a ticket could be started in, and why it's a candidate ("7 ID tickets", "autopilot repo", "recent"). */
export type StartFolder = { cwd: string; why: string };
/** A session Cora started on a ticket assigned to you: by your OK on its card, or on its own (`auto`). */
export type JiraStarted = { sessionId: string; key: string; summary: string; cwd: string; at: number; auto: boolean };

/** Something the agent wants to do that needs your OK: start a session, type into one, end one. */
export type Approval = {
  id: string;
  /** 'ask': Cora asks you something (an escalation); `options` are its suggested answers */
  kind: 'start' | 'send' | 'end' | 'ask' | 'worktree' | 'cleanup';
  options?: string[];
  /** one line: what it wants to do */
  title: string;
  /** what it's about: the session, the folder, why */
  detail: string;
  /** the prompt it would start with or type (you can change it) */
  text?: string;
  sessionId?: string;
  cwd?: string;
  /** a start on a Jira ticket assigned to you: the ticket, and the folders it could start in (you can pick another) */
  ticket?: { key: string; summary: string; who: string; /** a GitLab issue (`group/project#123`), not a Jira ticket */ source?: 'jira' | 'gitlab' };
  folders?: StartFolder[];
  createdAt: number;
  /** the agent is still waiting for your answer (after a while it's told this is waiting for you) */
  waiting: boolean;
};

export type OrchestratorStatus = {
  enabled: boolean;
  /** its settings the dashboard needs: say its replies aloud; its model */
  speak: boolean;
  model: string;
  /** the agent's Claude Code session, and its terminal while it runs */
  sessionId: string | null;
  terminalId: string | null;
  running: boolean;
  /** it couldn't be started (or kept stopping) */
  error?: string;
  approvals: Approval[];
  /** its terminal is asking something (trust this folder? a permission prompt): the question's lines, for you to answer */
  asking?: string[];
  /** what it's asking is Claude Code's "trust this folder?" (its options have no numbers; "No, exit" is highlighted) */
  askingTrust?: boolean;
  /** Cora answers your sessions' permission prompts (under the mandate) while you're away */
  control: boolean;
  /** what it's doing on autopilot (or last did) */
  goal: Goal | null;
  /** the sessions it's talking with (you OKed a conversation): until when it may without asking again */
  talks?: Array<{ sessionId: string; until: number }>;
  /** what Cora will check back on (the user asked her to) */
  followUps?: import('./followUps').FollowUp[];
  /** sessions it started on Jira tickets (the last 14 days, newest first) */
  jiraStarted?: JiraStarted[];
};

export type OrchMsg = { t: 'orchestrator'; status: OrchestratorStatus };

/** The agent driving the dashboard: what to show you. */
export type UiCommand =
  | { action: 'focus'; sessionId: string }
  | { action: 'overview' }
  | { action: 'open_url'; url: string; sessionId?: string }
  | { action: 'open_tool'; tool: string; url?: string }
  | { action: 'show_explain'; id: string; sessionId: string }
  | { action: 'notify'; text: string }
  /** a session's open_tab, after its checks: a site Cora knows opens; another waits for the user's OK (audit S15) */
  | { action: 'open_tab'; url: string; sessionId?: string; known: boolean }
  /** what you selected in the IDE panel, into that session's prompt box for you to ask about */
  | { action: 'compose'; sessionId: string; text: string }
  /** a debrief: a session made one (start it), or its bubble in the IDE was used (its buttons, a question) */
  | { action: 'debrief'; sessionId: string; act: 'start' | 'back' | 'next' | 'play' | 'pause' | 'speak' | 'close' | 'ask'; id?: string; text?: string };

export type UiCommandMsg = { t: 'ui'; cmd: UiCommand };

/** The agent's MCP tools (without the mcp__cora__ prefix). */
export const ORCH_TOOLS = [
  'sessions',
  'recaps',
  'jira_inbox',
  'jira_start',
  'session',
  'pending',
  'pipelines',
  'explains',
  'security',
  'start_session',
  'project_move',
  'follow_up',
  'follow_ups',
  'follow_up_cancel',
  'cora_post',
  'slack_pin',
  'resume_session',
  'send_to_session',
  'ask_session',
  'ask_copy',
  'end_session',
  'rename_session',
  'focus',
  'open_url',
  'open_tool',
  'show_explain',
  'notify',
  'cora_dm',
  'remember',
  'goal_update',
  'escalate',
  'decide',
  'answer_question',
  'worktrees',
  'worktree_new',
  'worktree_cleanup',
] as const;
