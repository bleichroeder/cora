/**
 * Worktrees: every worktree of your repos, who
 * works in it, how far it has got, and whether it's done. The rules here are pure; the server reads git.
 */

/** active: someone works in it · done: merged, nothing left in it, nobody there · stale: idle a week, not merged · idle */
export type WorktreeState = 'active' | 'idle' | 'stale' | 'done';

export type Worktree = {
  path: string;
  /** its branch (null: a detached HEAD) */
  branch: string | null;
  /** the repo's main checkout (never done or stale) */
  main: boolean;
  /** commits ahead of and behind the repo's base (origin/<default>) */
  ahead: number;
  behind: number;
  /** files changed and not committed */
  dirty: number;
  /** commits on no remote */
  unpushed: number;
  /** links inside it (junctions, symlinks): removing it unlinks them first */
  links: boolean;
  /** its last change: the newest of its last commit and its changed files */
  changedAt: number;
  /** its work is in the base (or its merge request was merged) */
  merged: boolean;
  /** the sessions working in it */
  who: string[];
  /** sessions Cora told to move into it, not there yet */
  coming?: string[];
  state: WorktreeState;
};

export type WorktreeRepo = {
  /** the main checkout's folder */
  root: string;
  name: string;
  /** one of the repos you gave Cora */
  mine: boolean;
  /** what worktrees are cut from and measured against, e.g. origin/main */
  base: string;
  trees: Worktree[];
};

export type WorktreesMsg = { t: 'worktrees'; repos: WorktreeRepo[] };

/** When a hosted session moves into a worktree: when it would edit a checkout another session is changing, before any edit, or only when asked. */
export type WorktreeMove = 'collide' | 'always' | 'ask';
export const WORKTREE_MOVES: WorktreeMove[] = ['collide', 'always', 'ask'];
export type WorktreeSettings = { move: WorktreeMove };
export const DEFAULT_WORKTREES: WorktreeSettings = { move: 'collide' };

/** Idle this long with no change and not merged: stale. */
export const STALE_MS = 7 * 86400_000;
/** Where Cora makes worktrees, inside the repo (where Claude Code makes its own). */
export const WORKTREE_DIR = '.claude/worktrees';

/** `git worktree list --porcelain`: each worktree's folder, branch (null when detached) and HEAD. */
export function parseWorktreeList(out: string): { path: string; branch: string | null; head: string; bare: boolean }[] {
  const list: { path: string; branch: string | null; head: string; bare: boolean }[] = [];
  let cur: { path: string; branch: string | null; head: string; bare: boolean } | null = null;
  for (const line of out.replace(/\r/g, '').split('\n')) {
    if (line.startsWith('worktree ')) list.push((cur = { path: line.slice(9).trim(), branch: null, head: '', bare: false }));
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (line === 'bare') cur.bare = true;
  }
  return list;
}

/** `git status --porcelain=v1`: how many files are changed (staged, unstaged or new). */
export const dirtyCount = (out: string) => out.replace(/\r/g, '').split('\n').filter((l) => l && !l.startsWith('##')).length;

/** A worktree's state from what's known of it. */
export function stateOf(t: Pick<Worktree, 'main' | 'who' | 'merged' | 'dirty' | 'unpushed' | 'changedAt'>, now = Date.now()): WorktreeState {
  if (t.who.length) return 'active';
  if (t.main) return 'idle';
  if (t.merged && !t.dirty && !t.unpushed) return 'done';
  if (now - t.changedAt > STALE_MS) return 'stale';
  return 'idle';
}

const slug = (s: string, max = 40) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');

/**
 * A branch for new work: `fix/KEY-short-title` or `feat/KEY-short-title` for a ticket (fix when the title says
 * something's broken), else `wt/<name>`; made unique against the branches there are.
 */
export function branchFor(o: { ticket?: string | null; title?: string | null; name?: string | null; taken: string[] }): string {
  const t = (o.title ?? '').trim();
  let b: string;
  if (o.ticket) {
    const kind = /\b(fix|bug|broken|error|crash|fails?|failing|wrong|regression)\b/i.test(t) ? 'fix' : 'feat';
    b = `${kind}/${[o.ticket.toUpperCase(), slug(t, 32)].filter(Boolean).join('-')}`;
  } else b = `wt/${slug(o.name || t, 40) || 'work'}`;
  const taken = new Set(o.taken.map((x) => x.toLowerCase()));
  if (!taken.has(b.toLowerCase())) return b;
  for (let i = 2; ; i++) if (!taken.has(`${b}-${i}`.toLowerCase())) return `${b}-${i}`;
}

/** A worktree's folder name from its branch (`fix/CORA-212-x` → `cora-212-x`). */
export const folderFor = (branch: string) => slug(branch.replace(/^(fix|feat|wt)\//, ''), 60) || 'work';

/**
 * A hosted session is about to edit a file: does it move into a worktree first? Only an edit in a repo's main
 * checkout; `collide`: when another live session has been changing that checkout; `always`: any such edit.
 */
export function gateDecision(o: { mode: WorktreeMove; inMain: boolean; othersEditing: number }): 'allow' | 'move' {
  if (!o.inMain || o.mode === 'ask') return 'allow';
  if (o.mode === 'always') return 'move';
  return o.othersEditing > 0 ? 'move' : 'allow';
}
