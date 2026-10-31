/**
 * Projects: sessions you group by hand into one piece of work.
 * By default only organisation (the nav, the project's board, resume and wrap up together). With coordination on, its
 * sessions can share a brief, decisions and a thread, each hearing only as much as you choose.
 */
export type ProjectHears = 'nothing' | 'brief' | 'everything';
/** `report`: to one seat only (an alert or status stream: a monitor to triage), never to anyone else's news */
export type PostKind = 'note' | 'change' | 'question' | 'handoff' | 'decision' | 'report';
export const POST_KINDS: PostKind[] = ['note', 'change', 'question', 'handoff', 'decision', 'report'];

/** What one session in a project hears, and may do (all off until you say). */
export type MemberSettings = { hears: ProjectHears; canPost: boolean; wakes: boolean; /** what it has heard up to (a post's time; the brief's change) */ heardTo?: number; heardBriefAt?: number; /** the project card it last had (what's on it: brief, decisions, pins, members) */ heardCard?: string; /** its seat, as you name it (Triage, Monitor, Analyst 01) */ role?: string };
/** A member of a project that doesn't coordinate (organisation only): hears nothing, can't post. */
export const MEMBER_DEFAULTS: MemberSettings = { hears: 'nothing', canPost: false, wakes: false };
/** A member of a project that coordinates: hears it, posts, may ask to wake another (you OK each wake). */
export const MEMBER_ON: MemberSettings = { hears: 'everything', canPost: true, wakes: true };

/** `by`: a session's id, 'you', or 'cora' */
export type Decision = { id: string; text: string; by: string; at: number };
/** `to`: members, or 'user' (you); `re`: the post it answers; a note may be pinned (it joins every member's card); a question you closed. */
export type Post = { id: string; by: string; kind: PostKind; text: string; at: number; to?: string[]; re?: string; pinned?: boolean; closed?: boolean; /** its writer changed it (when) */ editedAt?: number; /** its writer took it back (it stays, struck through) */ withdrawn?: boolean; /** the item it's about (an assignment, an annotation) */ item?: string };
/** A handoff or question to a member that hasn't reached it yet (busy, or idle and not woken). */
export type Waiting = { post: string; to: string; since: number };

export type Project = {
  id: string;
  name: string;
  /** its colour (#rrggbb) */
  color: string;
  createdAt: number;
  archivedAt?: number;
  /** member sessions, in the order you added them */
  sessions: string[];
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

export type ItemKind = 'incident' | 'known';
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ItemSeverity = (typeof SEVERITIES)[number];
export const INCIDENT_STATES = ['open', 'working', 'waiting', 'resolved'] as const;
export const KNOWN_STATES = ['proposed', 'approved', 'retired'] as const;
/** A dated, signed note on an item (`by`: a session, 'you' or 'cora'). */
export type ItemNote = { by: string; at: number; text: string };
/**
 * One row of shared state: an incident
 * (owned, with a state and a next step; closed with a cause and fix into the log) or a known issue (proposed, approved
 * by you, retired). Times are Cora's.
 */
export type ProjectItem = {
  id: string;
  kind: ItemKind;
  title: string;
  /** incident: open, working, waiting, resolved; known issue: proposed, approved, retired */
  state: string;
  severity?: ItemSeverity;
  owner?: string;
  /** when its owner took it */
  ownedAt?: number;
  next?: string;
  link?: string;
  /** a known issue's description */
  body?: string;
  /** a known issue's rule: "drop matching alerts while someone owns an incident for it" */
  rule?: string;
  cause?: string;
  fix?: string;
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
/** Open: an incident not resolved, a known issue proposed or approved. */
export const itemOpen = (i: ProjectItem) => (i.kind === 'incident' ? i.state !== 'resolved' : i.state !== 'retired');
const SEV_RANK: Record<ItemSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
/** Most urgent first: severity, then the longest waiting. */
export const bySeverity = (a: ProjectItem, b: ProjectItem) => SEV_RANK[a.severity ?? 'medium'] - SEV_RANK[b.severity ?? 'medium'] || a.openedAt - b.openedAt;

/** A question is open until a post answers it (`re`) or you close it. */
export const isOpenQuestion = (p: Project, x: Post) => x.kind === 'question' && !x.closed && !p.thread.some((y) => y.re === x.id);

/** A session asking to wake another (a handoff or a question to an idle member that wakes): yours to allow. */
export type ProjectWake = { id: string; project: string; from: string; to: string; text: string; at: number; /** the post it carries */ post?: string };

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
