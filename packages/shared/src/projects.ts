/**
 * Projects: sessions you group by hand into one piece of work.
 * By default only organisation (the nav, the project's board, resume and wrap up together). With coordination on, its
 * sessions can share a brief, decisions and a thread, each hearing only as much as you choose.
 */
export type ProjectHears = 'nothing' | 'brief' | 'everything';
export type PostKind = 'note' | 'change' | 'question' | 'handoff' | 'decision';
export const POST_KINDS: PostKind[] = ['note', 'change', 'question', 'handoff', 'decision'];

/** What one session in a project hears, and may do (all off until you say). */
export type MemberSettings = { hears: ProjectHears; canPost: boolean; wakes: boolean; /** what it has heard up to (a post's time; the brief's change) */ heardTo?: number; heardBriefAt?: number };
export const MEMBER_DEFAULTS: MemberSettings = { hears: 'nothing', canPost: false, wakes: false };

/** `by`: a session's id, 'you', or 'cora' */
export type Decision = { id: string; text: string; by: string; at: number };
export type Post = { id: string; by: string; kind: PostKind; text: string; at: number; to?: string[] };

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
};

/** A session asking to wake another (a handoff or a question to an idle member that wakes): yours to allow. */
export type ProjectWake = { id: string; project: string; from: string; to: string; text: string; at: number };

export type ProjectsMsg = { t: 'projects'; projects: Project[]; wakes: ProjectWake[] };

export const PROJECT_COLORS = ['#60a5fa', '#3ddc97', '#a78bfa', '#fbbf24', '#f472b6', '#2dd4bf', '#fb923c', '#f87171'];
export const MAX_POSTS = 500;
export const MAX_POST = 4000;
export const MAX_DECISION = 400;
export const MAX_BRIEF = 8000;
