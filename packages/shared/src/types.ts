import { DEFAULT_JIRA_WATCH } from './jiraWatch';
import { DEFAULT_TICKET_START } from './jira';
import { DEFAULT_SLACK_BOT } from './slackBot';
export type Family = 'look' | 'change' | 'run' | 'web' | 'delegate' | 'mcp' | 'plan' | 'human' | 'mind';

export type IconRef = { name: string; family: Family };

export type EventKind =
  | 'prompt' | 'say' | 'think' | 'tool' | 'spawn' | 'report' | 'permission' | 'question'
  | 'elicitation' | 'compact' | 'turn_end' | 'session_start' | 'session_end' | 'interrupt'
  /** a background command finished (Claude Code's task-notification) */
  | 'task';

export type ToolInfo = {
  name: string;
  input: unknown;
  summary: string;
  resultSummary?: string;
  preview?: string;
  failed?: boolean;
  resource?: string;
  /** Edit/Write/MultiEdit/NotebookEdit: the file and the hunks the tool changed */
  change?: import('./summarize').FileChange;
  /** a shell command sent to the background: its task id and where its output goes */
  background?: { taskId: string; outputFile?: string };
};

export type BrainEvent = {
  id: string;
  seq: number;
  sessionId: string;
  agentId: string;
  ts: number;
  kind: EventKind;
  phase?: 'start' | 'end';
  toolUseId?: string;
  tool?: ToolInfo;
  icon: IconRef;
  /** one model call: `in` is the whole prompt (fresh + cache reads + cache writes); `cached` is the cache-read part */
  tokens?: { in: number; out: number; thinking?: number; cached?: number };
  text?: string;
  /** kind 'say': the spoken summary Claude put at the end of the reply (its say-line), taken out of `text` */
  said?: string;
  /**
   * kind 'prompt': a message you sent while Claude was working. 'waiting': queued, Claude hasn't got it yet;
   * 'delivered': it has (the message then shows where Claude got it, as a prompt of its own)
   */
  queue?: 'waiting' | 'delivered';
  /** kind 'prompt': you sent it while Claude was working, and it got it mid-turn (at this event's time) */
  midTurn?: boolean;
  durationMs?: number;
  /** kind 'task': how a background command ended */
  task?: { id: string; status: string; exit?: number; outputFile?: string };
  source: 'hook' | 'transcript';
};

export type NewEvent = Omit<BrainEvent, 'seq'>;

export type SessionState = 'needs-you' | 'working' | 'thinking' | 'idle' | 'ended';

export type SessionInfo = {
  id: string;
  cwd: string;
  project: string;
  title: string;
  state: SessionState;
  startedAt: number;
  lastTs: number;
  cliVersion: string;
  transcriptPath: string;
  needsYou: number;
  model?: string;
  unknownLines?: number;
  totalLines?: number;
  /** user-chosen display name / main-agent colour */
  alias?: string | null;
  /** a short name suggested from the session's first prompt (auto-names, or "Suggest a name"); the alias wins */
  autoName?: string | null;
  color?: string | null;
  /** where you put it in the session list (lower first); unset sessions follow, oldest first */
  order?: number | null;
  /** hidden from the session list until there is activity after this time */
  dismissedAt?: number | null;
  /** why the session ended, when known ('exited' = hosted process exited) */
  exitReason?: string | null;
  /**
   * the Jira ticket it's about: started from it, or named by its first prompt (`/jira KEY`, a Jira link, a key of
   * one of the site's projects). Null: cleared (and not looked for again).
   */
  ticket?: SessionTicket | null;
  /** Claude Code's latest recap of it (written when you come back after a while away): where it stands, what's next */
  recap?: { text: string; at: number } | null;
  /** the GitLab issue it's about (its first message linked to it). Null: cleared. */
  issue?: import('./gitlabIssue').SessionIssue | null;
};

/** One of Claude Code's recaps of a session (`away_summary` in its transcript): kept as long as Cora keeps history. */
export type Recap = { id: string; sessionId: string; at: number; text: string };
/**
 * A recap's text as it reads: without Claude Code's note on turning them off, and without Cora's markup that it copied
 * from the session's own replies (it writes them in their style: a `<!-- say: … -->` line, explain markers).
 */
export const recapText = (s: string) =>
  s
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(/\s*\(disable recaps in \/config\)\s*/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();

/**
 * A session's ticket. `site`: the Jira it came from when that was a link (else the one Cora uses). `summary`: the
 * ticket's title as last looked up (the UI does the asking and tells the server), so the session keeps its name
 * signed out too.
 */
export type SessionTicket = { key: string; site: string | null; summary: string | null };

export type ExplainMode = 'off' | 'markdown' | 'markdown+html';
export type ExplainFrequency = 'sparingly' | 'normal' | 'liberally';
export type ExplainReply = 'pointer' | 'summary';
/** `claude --effort` / `--permission-mode` choices */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'] as const;
export type Effort = (typeof EFFORTS)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/** Per-launch Claude Code options (omitted = Claude Code's own default). */
export type LaunchOptions = { model?: string; effort?: Effort; permissionMode?: PermissionMode };
/** A saved one-click launch: a folder plus options. */
export type LaunchPreset = LaunchOptions & { id: string; name: string; cwd: string };

/** Optional voice: push-to-talk prompts and replies read aloud with an ElevenLabs voice. Off by default. */
export type VoiceSettings = {
  enabled: boolean;
  voiceId: string;
  voiceName: string;
  /** Cora's own voice (its console, its notes, its replies), so it sounds unlike your sessions; empty: the same one */
  coraVoiceId?: string;
  coraVoiceName?: string;
  /**
   * speaker buttons only; summaries (the short lines Claude writes for you with its `speak` tool, in any session);
   * or full replies (each finished turn's reply in the session you're looking at). Saved 'auto' means 'full'.
   */
  read: VoiceRead;
  /** reading full replies stops after about this many characters ("More in the transcript.") */
  cap: number;
  /**
   * the transcript's speaker button: nothing is said on its own (replies, finished commands, pipelines, failures, "needs
   * you", Cora's own news); what you click, and Cora answering you, still are
   */
  muted?: boolean;
  /** say it out loud when a session needs a permission decision */
  announce: boolean;
  /** say it when a background command finishes */
  announceTasks: boolean;
  /** say it when a tool fails in the session you're looking at */
  announceFailures: boolean;
  /** say it when a GitLab pipeline a session follows finishes */
  announcePipelines: boolean;
  /** after push-to-talk: review the words first, or send them straight away */
  after: 'review' | 'send';
  /** talking to Cora: send when you stop (a conversation), or review first; default send */
  coraAfter?: 'review' | 'send';
  /** click-to-talk stops by itself after this much quiet once you've spoken (ms); 0: only when you click again */
  endOnSilence?: number;
  /** "Hey Cora": listen on this computer for the wake word (off by default) */
  wake?: boolean;
  wakeSensitivity?: WakeSensitivity;
  /** after you speak, a quick line straight away ("Checking the webapi pipeline now.") while the answer comes (default on) */
  front?: boolean;
  /** after Cora answers aloud, listen a few seconds for a follow-up (default on) */
  wakeFollowUp?: boolean;
  /** ElevenLabs voice settings */
  stability: number;
  speed: number;
  /** the ElevenLabs text-to-speech model: Flash (fastest) by default, see VOICE_MODELS */
  model: string;
  /** how it's said: direction in ElevenLabs' audio tags (`[relaxed, warm]`), before every line (v3 and v4 models) */
  delivery?: string;
  /** the same for Cora's lines (empty: as above) */
  coraDelivery?: string;
  /** style exaggeration, 0 (none) to 1: a more characterful read (v2 and v3 models; v4 goes by tags) */
  style?: number;
  /** say this as that: swaps made before the text goes to ElevenLabs (Acme → ack me) */
  pronounce?: Array<{ from: string; to: string }>;
};

export type WakeSensitivity = 'low' | 'balanced' | 'high';
/** The wake model's score needed (twice in a row) for a hit, by sensitivity. */
export const WAKE_THRESHOLDS: Record<WakeSensitivity, number> = { low: 0.7, balanced: 0.5, high: 0.35 };

/** Does the model follow audio tags (`[laughs]`, `[whispers]`)? Eleven v3 and v4 do. */
export const takesTags = (model: string) => /^eleven_v[34]/.test(model);
/** Does it take the style setting? v2 and v3 models; v4 goes by tags instead. */
export const takesStyle = (model: string) => !/^eleven_v4/.test(model) && !/flash|turbo/.test(model);
export const DELIVERY_MAX = 200;
/**
 * The direction as ElevenLabs can take it: one short audio tag of a few cues (`[calm, confident, warm]`). Audio tags are
 * a few words; a whole description in brackets (sentences, a long list) gets read aloud. So: its phrases (split at
 * commas and stops, without a leading "and" or "with"), the short ones, positive ones (a "never…" isn't a cue), as many
 * as fit in 60 characters. Empty when nothing usable is left.
 */
export function directionTag(direction: string): string {
  const cues: string[] = [];
  let len = 0;
  // by sentence (one saying what not to do is no cue), then by phrase
  const phrases = direction
    .replace(/[[\]]/g, ' ')
    .split(/[.;:!?\n]+/)
    .filter((x) => !/^\s*(never|not|no|don't|do not|avoid)\b/i.test(x))
    .flatMap((x) => x.split(','));
  for (const raw of phrases) {
    let p = raw.replace(/[^A-Za-z '-]/g, ' ').replace(/\s+/g, ' ').trim();
    while (/^(and|with|but|or|also|yet)\s/i.test(p)) p = p.replace(/^\S+\s+/, '');
    if (!p || p.split(' ').length > 4) continue;
    const add = (cues.length ? 2 : 0) + p.length;
    if (len + add > 60) break;
    cues.push(p);
    len += add;
  }
  return cues.length ? `[${cues.join(', ')}]` : '';
}
export const PRONOUNCE_MAX = 60;
/** The text-to-speech models offered in Settings, fastest first; any other `eleven_…` ID also works. */
export const VOICE_MODELS: Array<{ id: string; name: string; note: string }> = [
  { id: 'eleven_flash_v2_5', name: 'Flash v2.5', note: 'fastest, half price' },
  { id: 'eleven_v4_turbo', name: 'v4 Turbo', note: 'near-v4 quality, still quick' },
  { id: 'eleven_v3', name: 'v3', note: 'expressive' },
  { id: 'eleven_v4', name: 'v4', note: 'best quality, slower to start' },
  { id: 'eleven_multilingual_v2', name: 'Multilingual v2', note: 'natural and steady, slowest to start' },
];
export const VOICE_READS = ['buttons', 'summaries', 'full'] as const;
export type VoiceRead = (typeof VOICE_READS)[number];
export const DEFAULT_VOICE: VoiceSettings = {
  enabled: false, voiceId: 'onwK4e9ZLuTAKqWW03F9', voiceName: 'Daniel', read: 'summaries', cap: 650,
  announce: true, announceTasks: true, announceFailures: false, announcePipelines: true, after: 'review', stability: 0.7, speed: 1, model: 'eleven_flash_v2_5',
};
/** Whether Claude should say spoken summaries with its `speak` tool (voice on, reading summaries). */
export const speaksSummaries = (v: Pick<VoiceSettings, 'enabled' | 'read'> | undefined) => !!v?.enabled && v.read === 'summaries';

/** What the server reports about the stored ElevenLabs key: never the key itself. */
export type VoiceKeyInfo = {
  set: boolean;
  /** e.g. "sk_…3f9a" */
  hint: string | null;
  /** what the key may do (null: not checked yet) */
  perms: { tts: boolean | null; stt: boolean | null; voices: boolean | null };
};

/**
 * A profile of Cora's browser: one of your Chrome or Edge profiles (`chrome:Default`, `edge:Profile 1`), whose
 * bookmarks and history it suggests from, with sign-ins of its own (its `partition`). One profile keeps the logins
 * Cora had before profiles (`persist:web`), and Tools use those.
 */
export type BrowserProfile = { id: string; name: string; partition: string };
export const BROWSER_PROFILE_ID = /^(chrome|edge):(Default|Profile \d{1,3})$/;
/** The logins Cora's browser always had (Tools use them; one profile keeps them). */
export const HOME_PARTITION = 'persist:web';
/** A profile's own logins: stable, from its id. */
export const partitionOf = (id: string) => `persist:web-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
export const isWebPartition = (p: string) => p === HOME_PARTITION || /^persist:web-[a-z0-9-]{1,40}$/.test(p);

export type Settings = {
  explains: { mode: ExplainMode; frequency: ExplainFrequency; reply: ExplainReply };
  retentionDays: number;
  presets: LaunchPreset[];
  voice: VoiceSettings;
  /** name new sessions from their first prompt (a quick Haiku call through the user's Claude Code login) */
  autoName: boolean;
  /** memes and GIFs sessions post to the Meme panel (off unless the user turns them on) */
  memes?: { mode: import('./memes').MemeMode };
  /** sessions and the Board: whether they may add (and show) a page laid out for what they're doing */
  board?: { pages: import('./boardLayouts').BoardPageMode };
  /** the Cora Orchestrator (off by default) */
  orchestrator: import('./orchestrator').OrchestratorSettings;
  /** Jira: watching it for you (off by default) */
  jira: { watch: import('./jiraWatch').JiraWatchSettings; /** how ticket sessions start */ ticket: import('./jira').TicketStart };
  /** where pipelines and deploys are read from (glab's host) */
  /** `todos`: your GitLab to-dos (assigned, review requested, mentions…) come into the Inbox */
  gitlab: { host: string; todos: boolean; /** an issue assigned to you: tell, offer to start it, or start it */ start?: import('./gitlabIssue').IssueStartMode };
  /** Cora's own Slack bot: messages while you're away, approvals, instructions */
  slackBot: import('./slackBot').SlackBotSettings;
  /** Slack in Cora's Inbox: the channels you follow (only what touches you there) */
  slack: { follow: import('./slack').SlackFollow[]; /** the sign-off on messages Cora sends for you (`:cora:`; empty: none) */ sign: string };
  /**
   * Cora's browser: suggest from (and show) your Chrome / Edge bookmarks and history. `profiles`: the ones you brought
   * in, each with its own sign-ins (Cora's Browser switches between them); none: one profile with all of them.
   * `sessions`: the profile sessions' browsers use.
   */
  browser: { chrome: boolean; profiles?: BrowserProfile[]; sessions?: string };
  /** 1Password in Cora's browser: fill logins, one-time codes, in Tools too */
  onepassword: import('./onepassword').OnePasswordSettings;
  /** setting Cora up: the features you skipped, and whether the first run was seen */
  setup: { skipped: string[]; seen: boolean };
};
export const DEFAULT_SETTINGS: Settings = {
  explains: { mode: 'markdown+html', frequency: 'normal', reply: 'pointer' },
  retentionDays: 7,
  presets: [],
  voice: DEFAULT_VOICE,
  autoName: false,
  memes: { mode: 'off' },
  board: { pages: 'show' },
  orchestrator: { enabled: false, model: 'opus', speak: true, mandate: { repos: [], deploy: false, slack: [] }, budget: 5_000_000, events: 'important', briefs: 'welcome' },
  jira: { watch: DEFAULT_JIRA_WATCH, ticket: DEFAULT_TICKET_START },
  gitlab: { host: 'gitlab.com', todos: true, start: 'offer' },
  slackBot: DEFAULT_SLACK_BOT,
  slack: { follow: [], sign: ':cora:' },
  browser: { chrome: true },
  onepassword: { on: true, otp: true, tools: true, suggest: true },
  setup: { skipped: [], seen: false },
};

export type AgentState = 'working' | 'thinking' | 'idle' | 'done';

export type AgentInfo = {
  sessionId: string;
  agentId: string;
  parentAgentId: string | null;
  parentToolUseId: string | null;
  label: string;
  agentType: string;
  colorIdx: number;
  startedAt: number;
  endedAt: number | null;
  state: AgentState;
};

export type PendingKind = 'permission' | 'elicitation' | 'question';

export type PendingRequest = {
  id: string;
  kind: PendingKind;
  sessionId: string;
  agentId: string;
  toolName: string;
  toolInput: unknown;
  toolUseId?: string;
  createdAt: number;
  expiresAt: number;
  /** MCP elicitation: server name, message and requested schema */
  elicitation?: { server: string; message: string; schema: unknown };
  /** AskUserQuestion: whether answering from the dashboard is enabled */
  canAnswer?: boolean;
};

export type PendingDecision = {
  decision: 'allow' | 'deny' | 'accept' | 'decline' | 'cancel';
  updatedInput?: unknown;
  message?: string;
  content?: Record<string, unknown>;
  answers?: Record<string, string>;
};

/** How a hosted Claude Code terminal started. */
export type ClaudeMode = 'new' | 'resume' | 'fork';
/** 'shell': a plain shell (PowerShell) opened beside a session's Claude, in its folder; it belongs to that session. */
export type TerminalMode = ClaudeMode | 'shell';
export const isShell = (t: { mode: TerminalMode }): boolean => t.mode === 'shell';
export type TerminalInfo = {
  terminalId: string;
  /** the Claude session it runs (a shell: the session it belongs to) */
  sessionId: string;
  cwd: string;
  mode: TerminalMode;
  alive: boolean;
  startedAt: number;
  exitCode?: number;
  /** Claude Code's on-screen working indicator while it works, e.g. "✻ Cogitating… (12s · esc to interrupt)" */
  status?: string | null;
  /** a shell: which kind (its name, e.g. "Git Bash", "Ubuntu") */
  shell?: string;
  /** a shell the Board's Terminal panel opened (it lives there, not among the session's terminal tabs) */
  place?: 'board';
};

export type HistoryItem = {
  sessionId: string;
  projectSlug: string;
  cwd: string;
  title: string;
  firstPrompt: string;
  mtime: number;
  size: number;
  /** what Cora calls it (as in the nav), when Cora knows it: your name, its ticket's… (naming.ts) */
  name?: string;
};

/** A GitLab CI status, as the API spells it. */
export type CiStatus =
  | 'created' | 'waiting_for_resource' | 'preparing' | 'pending' | 'running'
  | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual' | 'scheduled';

export type CiJob = {
  id: number;
  name: string;
  stage: string;
  status: CiStatus;
  allowFailure?: boolean;
  /** e.g. script_failure, job_execution_timeout */
  failureReason?: string;
  startedAt: number | null;
  finishedAt: number | null;
  url: string;
};

/** Stages in the order they run (jobs inside in GitLab's order). */
export type CiStage = { name: string; status: CiStatus; jobs: CiJob[] };

export type CiPipeline = {
  /** `${project}#${id}` */
  key: string;
  /** path with namespace, e.g. acme/internal/orion/orion-services */
  project: string;
  id: number;
  ref: string;
  sha: string;
  status: CiStatus;
  source?: string;
  url: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** seconds it has spent running, as GitLab counts it (a pipeline waiting on a manual job isn't running) */
  duration?: number | null;
  /** jobs not fetched yet: empty */
  stages: CiStage[];
};

/** Why a session follows a pipeline: its branch's latest, one its command started (a push, `glab ci run`), or one it looked at. */
export type CiWhy = 'branch' | 'push' | 'command' | 'url';

/** The pipelines that matter to one live session (most recent reference first). */
export type CiLink = {
  sessionId: string;
  /** the session's repo on gitlab.com and its branch (null: not a GitLab repo, or not on a branch) */
  repo: { project: string; branch: string; defaultBranch?: string } | null;
  pipelines: Array<{ key: string; why: CiWhy; at: number }>;
};

/** Whether the server can read pipelines at all (glab missing, signed out, offline): one line for the UI. */
export type CiHealth = { state: 'ok' | 'no-glab' | 'signed-out' | 'offline' | 'error'; message?: string };

/** Pipeline news: `full` replaces everything the client has; otherwise what changed (and which sessions stopped following). */
export type CiMsg = { t: 'ci'; full?: boolean; pipelines?: CiPipeline[]; links?: CiLink[]; goneLinks?: string[]; health?: CiHealth };

/** A dashboard that comes back is sent what it missed, up to this many events; past that it fetches sessions again. */
export const MAX_REPLAY = 5000;

/** A live explain's data changed: the open page redraws. */
export type ExplainDataMsg = { t: 'explain-data'; sessionId: string; slug: string; data: unknown };

export type ServerMsg =
  | CiMsg
  | import('./deploys').DeploysMsg
  | import('./notes').NotesMsg
  | import('./slack').SlackMsg
  | import('./jiraWatch').JiraMsg
  | import('./inbox').InboxMsg
  | import('./security').SecurityMsg
  | import('./orchestrator').OrchMsg
  | import('./orchestrator').UiCommandMsg
  | ExplainDataMsg
  /** Cora locked: every page goes to the lock screen */
  | { t: 'lock' }
  /** a session posted to the Meme panel */
  | { t: 'meme'; sessionId: string }
  | { t: 'snapshot'; sessions: SessionInfo[]; agents: AgentInfo[]; pending: PendingRequest[]; terminals: TerminalInfo[]; lastSeq: number; recent: Record<string, BrainEvent[]> }
  | { t: 'terminals'; terminals: TerminalInfo[] }
  | { t: 'events'; events: BrainEvent[] }
  | { t: 'session'; session: SessionInfo }
  | { t: 'agent'; agent: AgentInfo }
  | { t: 'pending'; pending: PendingRequest[] };

export type ClientMsg = { t: 'hello'; lastSeq: number };

/** A kind of shell a shell tab can be (PowerShell, Command Prompt, Git Bash, a WSL distro…). */
export type ShellProfile = { id: string; name: string; wsl?: boolean };

export const DEFAULT_GITLAB_HOST = 'gitlab.com';

/**
 * A session or agent id Cora will use: letters, digits, `_` and `-`, not starting with `-` (Claude Code's are UUIDs and
 * short hex). Anything else never reaches a file name, a command line or a script (docs/audit-2026-10-20.md S5, S6, S9).
 */
export const isSafeId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][\w-]{0,99}$/.test(s);
