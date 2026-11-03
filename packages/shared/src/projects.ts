/**
 * Projects: sessions you group by hand into one piece of work.
 * By default only organisation (the nav, the project's board, resume and wrap up together). With coordination on, its
 * sessions can share a brief, decisions and a thread, each hearing only as much as you choose.
 */
import type { Team } from './teams';
export type ProjectHears = 'nothing' | 'brief' | 'everything';
/** `report`: to one seat only (an alert or status stream: a monitor to triage), never to anyone else's news */
/** `direct`: a message to one member (what a team's route calls a direct message) */
export type PostKind = 'note' | 'change' | 'question' | 'handoff' | 'decision' | 'report' | 'direct';
export const POST_KINDS: PostKind[] = ['note', 'change', 'question', 'handoff', 'decision', 'report', 'direct'];

/** What one session in a project hears, and may do (all off until you say). */
export type MemberSettings = { hears: ProjectHears; canPost: boolean; wakes: boolean; /** what it has heard up to (a post's time; the brief's change) */ heardTo?: number; heardBriefAt?: number; /** the project card it last had (what's on it: brief, decisions, pins, members) */ heardCard?: string; /** its seat, as you name it (Triage, Monitor, Analyst 01) */ role?: string; /** its team seat id (a team's definition; not the free-text role) */ seat?: string; /** which instance of that seat (1-based) */ instance?: number };
/** A member of a project that doesn't coordinate (organisation only): hears nothing, can't post. */
export const MEMBER_DEFAULTS: MemberSettings = { hears: 'nothing', canPost: false, wakes: false };
/** A member of a project that coordinates: hears it, posts, may ask to wake another (you OK each wake). */
export const MEMBER_ON: MemberSettings = { hears: 'everything', canPost: true, wakes: true };

/** `by`: a session's id, 'you', or 'cora' */
export type Decision = { id: string; text: string; by: string; at: number };
/** `to`: members, or 'user' (you); `re`: the post it answers; a note may be pinned (it joins every member's card); a question you closed. */
export type Post = { id: string; by: string; kind: PostKind; text: string; at: number; to?: string[]; re?: string; pinned?: boolean; closed?: boolean; /** its writer changed it (when) */ editedAt?: number; /** its writer took it back (it stays, struck through) */ withdrawn?: boolean; /** the item it's about (an assignment, an annotation) */ item?: string; /** a cross-session message Claude Code delivered itself (Cora records it; it never delivers it again) */ native?: boolean; /** when its member received it (a native message) */ deliveredAt?: number; /** a project post Cora sent natively, as its writer (the receiver's report finds it) */ sentNative?: boolean; /** team labels it carries */ labels?: Record<string, string>; /** its writer's team seat when it wrote it (its route still applies once the writer has left) */ seat?: string; /** a message the team's routes refused: kept quietly on the board, never delivered, nobody's news */ blocked?: true };
/** A handoff or question to a member that hasn't reached it yet (busy, or idle and not woken). */
export type Waiting = { post: string; to: string; since: number; /** when Cora found it couldn't reach its member (not hosted here, nothing of it asking for messages) and told its sender */ undelivered?: number };

export type Project = {
  id: string;
  name: string;
  /** its colour (#rrggbb) */
  color: string;
  createdAt: number;
  archivedAt?: number;
  /** member sessions, in the order you added them */
  sessions: string[];
  /** its team definition, when it has one */
  team?: Team;
  /** earlier versions of the team (newest last, at most 50) */
  teamHistory?: Array<{ version: number; at: number; by: string; team: Team }>;
  /** its team was brought up (and not stood down): Cora keeps its standing seats running, after a restart too */
  teamUp?: boolean;
  /** seats stood down on their own (ids): not started again until Bring up, after a restart too */
  teamDown?: string[];
  /** seats whose running members wait for your Restart (an edit they take only at start): asked for after a restart too */
  teamRestart?: string[];
  /** pools made smaller whose extras still close once idle, after a restart too */
  teamTrim?: string[];
  /** its team was up and you stood it down (until it's brought up again): not running on purpose */
  teamStoodDown?: true;
  /** you chose no lead (Crew): an Apply or a bring-up doesn't give it one, until you pick one or the team's lead seat changes */
  leadNone?: true;
  /** a change to its team its lead proposed, waiting for the user (one at a time; `base`: the version it edits) */
  teamProposal?: { team: Team; why: string; by: string; at: number; base: number };
  /** where the builder draws its team (seats, You and Cora): beside the team, never a change to it */
  teamLayout?: TeamLayout;
  /** the team being built (one draft, yours and Cora's): never the project's team until it's applied */
  builderDraft?: BuilderDraft;
  /** the builder's own session (published in place of the draft, so screens keep it out of the session list) */
  builderSession?: string;
  /** the newest revision the project's draft has had (kept when it is discarded, so revisions only go up) */
  builderRev?: number;
  /** its sessions may hear each other (off: organisation only) */
  coordination: boolean;
  /** markdown: the goal, the repos, done-when, don'ts */
  brief: string;
  /** when the brief or the decisions last changed */
  briefAt: number;
  decisions: Decision[];
  thread: Post[];
  members: Record<string, MemberSettings>;
  /** its sessions wear shades of its colour, kept as sessions join and leave and as its colour changes */
  shade?: boolean;
  /** handoffs and questions to members not delivered yet */
  waiting?: Waiting[];
  /** its sessions wake each other without asking you (a few times an hour each; back to asking if two keep at it) */
  autoWake?: boolean;
  /** shared state, updated in place: incidents and known issues */
  items?: ProjectItem[];
  /** the lead seat (a member's id): it opens incidents, assigns and merges them */
  lead?: string;
  /** Cora posts, and opens or assigns items, without asking you each time */
  coraRoutes?: boolean;
};

/** Where the builder draws a team: seat ids, '@user', '@cora'. */
export type TeamLayout = { pos: Record<string, { x: number; y: number }>; color?: Record<string, string> };
/** One of Cora's changes to a draft (team_draft_set): what it did, and the team before and after it (for Undo). */
export type BuilderTurn = { id: string; at: number; summary: string; before: Team; after: Team; undone?: true };
/** The team being built: one draft per project, every change (yours or Cora's) a new revision; `base`: the team version it edits. */
export type BuilderDraft = { team: Team; rev: number; by: 'you' | 'cora'; base: number; at: number; turns: BuilderTurn[]; session?: string };
/** The draft as screens get it: its turns without their teams. */
export type BuilderDraftView = Omit<BuilderDraft, 'turns'> & { turns: Array<Omit<BuilderTurn, 'before' | 'after'>> };
/** A project's draft changed (null: there is none now). */
/** A project's builder draft as the screens hold it; `talkError`: what you said in Talk didn't reach Cora's session, and why. */
export type BuilderMsg = { t: 'builder'; project: string; draft: BuilderDraftView | null; talkError?: string };
export const draftView = (d: BuilderDraft): BuilderDraftView => ({ ...d, turns: d.turns.map(({ before: _b, after: _a, ...x }) => x) });
/** The builder session's own first prompt (Talk doesn't show it). */
export const BUILDER_FIRST_PROMPT = 'Read the draft with team_draft_get and wait for the user';

export type ItemKind = 'incident' | 'known' | 'task';
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ItemSeverity = (typeof SEVERITIES)[number];
export const INCIDENT_STATES = ['open', 'working', 'waiting', 'resolved'] as const;
export const KNOWN_STATES = ['proposed', 'approved', 'retired'] as const;
/** A task's states while it's open (its owner sets them); closed, it's done (with its outcome). */
export const TASK_STATES = ['queued', 'building', 'review', 'testing', 'blocked'] as const;
export type TaskState = (typeof TASK_STATES)[number];
/** A dated, signed note on an item (`by`: a session, 'you' or 'cora'). */
export type ItemNote = { by: string; at: number; text: string };
/**
 * One row of shared state: an incident
 * (owned, with a state and a next step; closed with a cause and fix into the log) or a known issue (proposed, approved
 * by you, retired), or a task (a piece of work: queued in rank order, owned, moved through building, review and testing;
 * closed as done with its outcome). Times are Cora's.
 */
export type ProjectItem = {
  /** team labels it carries */
  labels?: Record<string, string>;
  /** a team group it is offered to (id) */
  offeredTo?: string;
  /** the team's route it was offered on (id): escalation rules scoped to a route read it */
  route?: string;
  id: string;
  kind: ItemKind;
  title: string;
  /** incident: open, working, waiting, resolved; known issue: proposed, approved, retired; task: TASK_STATES, or done */
  state: string;
  severity?: ItemSeverity;
  /** a member's session id (or 'you'); a task's may be a team group's id while it's offered to the group */
  owner?: string;
  /** when its owner took it */
  ownedAt?: number;
  next?: string;
  link?: string;
  /** a known issue's description, or what a task is */
  body?: string;
  /** a known issue's rule: "drop matching alerts while someone owns an incident for it" */
  rule?: string;
  cause?: string;
  fix?: string;
  /** a task's place in the queue (lower first) */
  rank?: number;
  /** a task done: how it ended, in a line ("merged as abc1234") */
  outcome?: string;
  mergedInto?: string;
  openedBy: string;
  openedAt: number;
  updatedBy: string;
  updatedAt: number;
  closedAt?: number;
  notes: ItemNote[];
};
export const MAX_ITEMS = 1000;
export const MAX_ITEM_NOTES = 100;
/** Open: an incident not resolved, a known issue proposed or approved, a task not done. */
export const itemOpen = (i: ProjectItem) => (i.kind === 'incident' ? i.state !== 'resolved' : i.kind === 'task' ? i.state !== 'done' : i.state !== 'retired');
/** Tasks in the queue's order: rank, then the oldest first. */
export const byRank = (a: ProjectItem, b: ProjectItem) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.openedAt - b.openedAt;
const SEV_RANK: Record<ItemSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
/** Most urgent first: severity, then the longest waiting. */
export const bySeverity = (a: ProjectItem, b: ProjectItem) => SEV_RANK[a.severity ?? 'medium'] - SEV_RANK[b.severity ?? 'medium'] || a.openedAt - b.openedAt;

/** A question is open until a post answers it (`re`) or you close it. */
export const isOpenQuestion = (p: Project, x: Post) => x.kind === 'question' && !x.closed && !p.thread.some((y) => y.re === x.id);

/** A session asking to wake another (a handoff or a question to an idle member that wakes): yours to allow. */
export type ProjectWake = { id: string; project: string; from: string; to: string; text: string; at: number; /** the post it carries */ post?: string; /** a team's offer that Cora carries (its text names its real sender) */ offer?: true };

export type ProjectsMsg = { t: 'projects'; projects: Project[]; wakes: ProjectWake[]; /** what each member is on now (its latest journal headline, else its last reply's first sentence) */ doing?: Record<string, string> };

export const PROJECT_COLORS = ['#60a5fa', '#3ddc97', '#a78bfa', '#fbbf24', '#f472b6', '#2dd4bf', '#fb923c', '#f87171'];
export const MAX_POSTS = 500;
export const MAX_POST = 4000;
export const MAX_DECISION = 400;
export const MAX_BRIEF = 8000;

/**
 * Shades of a project's colour, one per session (lighter and darker, the hue nudged a little each way), so its sessions
 * read as one family and still apart.
 */
export function shadesOf(hex: string, n: number): string[] {
  const [h, s, l] = toHsl(hex);
  if (n <= 1) return [hex];
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1); // 0 … 1
    const light = Math.max(32, Math.min(78, l - 18 + t * 36));
    const hue = (h + (i % 2 ? 1 : -1) * Math.min(14, 4 + i * 2) + 360) % 360;
    const sat = Math.max(35, Math.min(95, s + (i % 3 === 1 ? -10 : i % 3 === 2 ? 6 : 0)));
    return toHex(hue, sat, light);
  });
}
function toHsl(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const v = m ? parseInt(m[1], 16) : 0x60a5fa;
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
function toHex(h: number, s: number, l: number): string {
  const S = s / 100, L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
}
