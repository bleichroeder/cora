/**
 * The live board's layout (the scene area with 3D off): panels on a grid that snaps, like a dashboard. 24 columns across
 * the whole width and 24 rows down the whole height, both as shares of the area, so the board keeps its shape at any
 * window size. A page always tiles the area, like split panes: no holes, nothing hanging below. A panel dropped on
 * another swaps with it, or near an edge takes that half of it; every line between panels drags like a split bar (the
 * panels along it on both sides move with it), and where two lines meet, both move; one moved or removed leaves its
 * place to its neighbours. Each session has its own board (SessionBoard); a new one starts from a template. Pure: the
 * board (components/LiveBoard.tsx) renders it and keeps it in the UI preferences.
 */

import { type BoardLayoutId } from '@cora/shared';

export type PanelKind =
  | 'spotlight'
  | 'videos'
  | 'agents'
  | 'touching'
  | 'explains'
  | 'tasks'
  | 'goal'
  | 'context'
  | 'changes'
  | 'git'
  | 'tests'
  | 'background'
  | 'terminal'
  | 'browser'
  | 'ide'
  | 'pipeline'
  | 'deploys'
  | 'ticket'
  | 'needs'
  | 'mentions'
  | 'notes'
  | 'sessions'
  | 'usage'
  | 'recap'
  | 'memes'
  | 'journal'
  | 'wall'
  | 'worktrees'
  | 'today'
  | 'constellation'
  | 'members'
  | 'loops'
  | 'incidents'
  | 'known'
  | 'pnotes'
  | 'thread'
  | 'brief'
  | 'repos'
  | 'activity'
  | 'project'
  | 'explain';
export type BoardItem = {
  id: string;
  k: PanelKind;
  /** its place and size, in grid cells */
  x: number;
  y: number;
  w: number;
  h: number;
  /** an explain: its session and title */
  sid?: string;
  title?: string;
  /** the page it's on (none: the first) */
  pg?: number;
  /** the Spotlight: what you pinned it to (lib/spotlight's key) */
  pin?: string;
  /** a Terminal panel: its own shells, as tabs (their terminal ids), and the one on show */
  terms?: string[];
  term?: string;
  /** on a project's board, a session's panel: the member it's for ('*': all of them, where it can) */
  for?: string;
};

/** A Terminal panel's shells (one from before tabs: just it). */
export const shellsOf = (p: BoardItem): string[] => p.terms ?? (p.term ? [p.term] : []);

/** At most this many pages of panels. */
export const MAX_PAGES = 9;
const pageOf = (p: BoardItem) => p.pg ?? 0;

export const COLS = 24;
/** The rows that fill the area's height. */
export const ROWS = 24;
/** The least a panel is (an eighth of the board). */
export const MIN_W = 3;
export const MIN_H = 3;
/** Layouts kept from before the grid was 24 by 24 were 12 by 12: they're read at twice the size. */
const OLD_COLS = 12;

/** Each panel's icon (Lucide) in the + Panel menu and its header. */
export const PANEL_ICON: Record<Exclude<PanelKind, 'explain'>, string> = {
  spotlight: 'Sparkles', videos: 'Clapperboard', agents: 'Bot', touching: 'Activity', tasks: 'ListChecks', explains: 'FileText', goal: 'Target', memes: 'PartyPopper', recap: 'ScrollText', journal: 'BookOpen', context: 'Gauge',
  changes: 'FileDiff', git: 'GitBranch', tests: 'FlaskConical', background: 'Loader',
  pipeline: 'GitPullRequest', deploys: 'Rocket', ticket: 'Ticket',
  needs: 'Hand', mentions: 'AtSign', notes: 'NotebookPen', usage: 'ChartPie', sessions: 'LayoutList',
  terminal: 'SquareTerminal', browser: 'Globe', ide: 'Code',
  wall: 'LayoutGrid', worktrees: 'GitFork', today: 'CalendarClock',
  constellation: 'Orbit', members: 'Users', loops: 'CircleDot', incidents: 'Siren', known: 'BookMarked', pnotes: 'StickyNote', thread: 'MessagesSquare', brief: 'NotebookText', repos: 'FolderGit2', activity: 'History', project: 'FolderKanban',
};

/** Where a panel sits in the + Panel menu. */
export const PANEL_GROUPS = ['Project', 'Cora', 'This session', 'Code', 'Delivery', 'Around you', 'Tools'] as const;
export type PanelGroup = (typeof PANEL_GROUPS)[number];

/** The panels you can add (an explain is added from the Explains panel, or the menu's explains), and their size when added. */
export const PANELS: Record<Exclude<PanelKind, 'explain'>, { name: string; hint: string; group: PanelGroup; size?: [number, number] }> = {
  spotlight: { name: 'Spotlight', hint: 'Follows what matters now, or what Claude asks to show', group: 'This session', size: [12, 14] },
  videos: { name: 'Videos', hint: "This session's debrief videos: watch, save, send", group: 'This session', size: [12, 12] },
  agents: { name: 'Agents', hint: "Each agent and what it's doing now", group: 'This session' },
  touching: { name: 'Touching', hint: 'Files, web, shell and tools of the last 10 minutes', group: 'This session' },
  tasks: { name: 'Tasks', hint: "Claude's task list", group: 'This session', size: [8, 8] },
  explains: { name: 'Explains', hint: "This session's explains, with previews", group: 'This session' },
  goal: { name: 'Goal', hint: 'What the session was asked, and the latest ask', group: 'This session', size: [10, 8] },
  memes: { name: 'Vibes', hint: "Memes and GIFs the session sticks up about what's happening (turn them on in Settings › Sessions › Vibes)", group: 'This session', size: [8, 12] },
  journal: { name: 'Journal', hint: "This session's journal: its milestones, its wrap-up, and recaps, as it writes them", group: 'This session', size: [10, 12] },
  recap: { name: 'Recap', hint: "Claude Code's recaps of the session, newest first: where it stands, what's next", group: 'This session', size: [10, 12] },
  context: { name: 'Context', hint: 'How full the context window is, and how fast it fills', group: 'This session', size: [8, 8] },
  changes: { name: 'Changes', hint: 'Files changed this session, with their diffs', group: 'Code', size: [14, 14] },
  git: { name: 'Git', hint: 'The branch, uncommitted files, commits made', group: 'Code', size: [10, 12] },
  tests: { name: 'Tests', hint: 'Test runs: what passed and failed, run by run', group: 'Code', size: [10, 10] },
  background: { name: 'Background', hint: 'Commands running in the background, with their output', group: 'Code', size: [12, 10] },
  pipeline: { name: 'Pipeline & MR', hint: "The branch's pipeline stage by stage, and its merge request", group: 'Delivery', size: [12, 10] },
  deploys: { name: 'Deploys', hint: 'Where the change has got to: MR, pipeline, tag, environments', group: 'Delivery', size: [14, 8] },
  ticket: { name: 'Ticket', hint: "The session's Jira ticket", group: 'Delivery', size: [10, 12] },
  needs: { name: 'Needs you', hint: 'Approvals and questions waiting on you, with their buttons', group: 'Around you', size: [12, 10] },
  mentions: { name: 'Mentions', hint: "Inbox items about this session's ticket, branch or work", group: 'Around you', size: [10, 12] },
  notes: { name: 'Notes', hint: "Scratch jots, this session's marked; jot one down", group: 'Around you', size: [10, 12] },
  usage: { name: 'Usage', hint: "Your plan's limits, as /usage shows them, and extra usage", group: 'Around you', size: [10, 12] },
  sessions: { name: 'All sessions', hint: "Every session and what it's doing; click one to go there", group: 'Around you', size: [10, 14] },
  terminal: { name: 'Terminal', hint: "The session's terminal or a shell, live (to watch; type in the terminal pane)", group: 'Tools', size: [14, 14] },
  browser: { name: 'Browser', hint: 'A browser of its own, with its own tabs and profiles', group: 'Tools', size: [14, 16] },
  ide: { name: 'IDE', hint: "Your VS Code (extensions, debugger, git, its terminal), opened at the session's folder", group: 'Tools', size: [16, 18] },
  wall: { name: 'Sessions', hint: "Every live session as a card: what it's doing, its agents, what it said last", group: 'Cora', size: [14, 24] },
  worktrees: { name: 'Worktrees', hint: 'Every worktree of your repos: who works in it, how far it has got, what can go', group: 'Cora', size: [10, 15] },
  today: { name: 'Today', hint: 'Your calls today (your Google calendar): when, with whom, Join, their prep notes', group: 'Cora', size: [10, 12] },
  constellation: { name: 'Constellation', hint: "The project's sessions as their orbs, together: what each is doing, and the thread's posts between them", group: 'Project', size: [12, 12] },
  members: { name: 'Crew', hint: "Who's doing what, and what each last said: reply to any session right here, and answer what it asks you", group: 'Project', size: [10, 14] },
  loops: { name: 'Needs you', hint: "What's waiting on your word: wakes to deliver, questions to you, incidents nobody owns, known issues to approve", group: 'Project', size: [10, 12] },
  incidents: { name: 'Incidents', hint: 'One per outage, most urgent first: severity, owner, state, next step; claim, assign and close them; the log of closed ones', group: 'Project', size: [12, 12] },
  known: { name: 'Known issues', hint: 'What the sessions know is wrong and how to treat it: approve what they propose, retire what is fixed', group: 'Project', size: [10, 10] },
  pnotes: { name: 'Shared notes', hint: "The sessions' and your notes as a pinboard; pinned ones join every session's project card", group: 'Project', size: [10, 10] },
  thread: { name: 'Conversation', hint: 'What passed between the sessions: who to whom, and what happened to each (delivered, held for you, waiting); write to the project or one session', group: 'Project', size: [10, 14] },
  brief: { name: 'Brief & decisions', hint: "The project's goal and the decisions it keeps", group: 'Project', size: [10, 10] },
  repos: { name: 'Across repos', hint: "The members' worktrees, tickets, merge requests and pipelines in one list", group: 'Project', size: [12, 10] },
  activity: { name: 'Activity', hint: "What the project's sessions did lately, together", group: 'Project', size: [12, 10] },
  project: { name: 'Project', hint: "This session's project: its brief and thread", group: 'This session', size: [10, 12] },
};

/** The board that is Cora's own (the Overview's Board), kept with the sessions' boards under this key. */
export const CORA_BOARD = 'cora';
/** Whose board a panel fits: one session's (it reads that session), Cora's (all your work), or both. */
export type PanelScope = 'session' | 'cora' | 'both' | 'project';
export const PANEL_SCOPE: Record<Exclude<PanelKind, 'explain'>, PanelScope> = {
  spotlight: 'session', videos: 'session', agents: 'session', touching: 'session', tasks: 'session', explains: 'session', goal: 'session', memes: 'session', journal: 'session', recap: 'session', context: 'session',
  changes: 'session', git: 'session', tests: 'session', background: 'session', pipeline: 'session', deploys: 'session', ticket: 'session', mentions: 'session', terminal: 'session', ide: 'session',
  needs: 'both', notes: 'both', usage: 'both', sessions: 'both', browser: 'both',
  wall: 'cora', worktrees: 'cora', today: 'cora',
  constellation: 'project', members: 'project', loops: 'project', incidents: 'project', known: 'project', pnotes: 'project', thread: 'project', brief: 'project', repos: 'project', activity: 'project', project: 'session',
};
/** Does this panel fit this board (a session's, or Cora's)? An explain is a session's. */
export const fitsBoard = (k: PanelKind, owner: string) => {
  // a project's board: its own panels, and a session's (each for a member); not an explain, nor its project panel
  if (owner.startsWith('project:')) return k !== 'explain' && k !== 'project' && PANEL_SCOPE[k] !== 'cora';
  const s = k === 'explain' ? 'session' : PANEL_SCOPE[k];
  return s === 'both' || (owner === CORA_BOARD ? s === 'cora' : s === 'session');
};
/** Is it a session's panel (on a project's board: for one member)? */
export const forMember = (k: PanelKind) => k === 'explain' || PANEL_SCOPE[k] === 'session';
/** A session's panels that can show every member at once on a project's board. */
export const FOR_ALL = new Set<PanelKind>(['changes', 'tests', 'pipeline', 'git']);
/** A project's board as it starts: the crew, what needs you, the conversation. */
export const PROJECT_LAYOUT: BoardItem[] = [
  { id: 'members', k: 'members', x: 0, y: 0, w: 9, h: 24 },
  { id: 'loops', k: 'loops', x: 9, y: 0, w: 7, h: 24 },
  { id: 'thread', k: 'thread', x: 16, y: 0, w: 8, h: 24 },
];
/** Cora's board as it starts: the sessions large, their worktrees and what needs you beside them. */
export const CORA_LAYOUT: BoardItem[] = [
  { id: 'wall', k: 'wall', x: 0, y: 0, w: 14, h: 24 },
  { id: 'worktrees', k: 'worktrees', x: 14, y: 0, w: 10, h: 15 },
  { id: 'needs', k: 'needs', x: 14, y: 15, w: 10, h: 9 },
];
/** A board's panels from the preferences, for its owner: what doesn't fit it dropped (none left: how it starts). */
export function boardFor(raw: unknown, owner: string, first: unknown): BoardItem[] {
  if (owner.startsWith('project:')) {
    const items = raw ? normalize(raw).filter((p) => fitsBoard(p.k, owner)) : [];
    return items.length ? items : PROJECT_LAYOUT;
  }
  if (owner !== CORA_BOARD) return raw ? normalize(raw) : template(first);
  const items = raw ? normalize(raw).filter((p) => fitsBoard(p.k, owner)) : [];
  return items.length ? items : CORA_LAYOUT;
}

/** A new session's board until you choose your own: the Spotlight (it follows what matters now) full height. */
export const DEFAULT_BOARD: BoardItem[] = [
  { id: 'spotlight', k: 'spotlight', x: 0, y: 0, w: 14, h: 24 },
  { id: 'touching', k: 'touching', x: 14, y: 0, w: 10, h: 12 },
  { id: 'tasks', k: 'tasks', x: 14, y: 12, w: 10, h: 12 },
];

const KINDS = new Set<PanelKind>([...(Object.keys(PANELS) as PanelKind[]), 'explain']);
const int = (n: unknown, lo: number, hi: number, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d);

export const collides = (a: BoardItem, b: BoardItem) => a.id !== b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const bottom = (items: BoardItem[]) => items.reduce((m, i) => Math.max(m, i.y + i.h), 0);

/**
 * A page always tiles the area: every cell is some panel's, nothing overlaps, nothing hangs below. Any layout (one
 * from before, or one an edit left a hole in) is read as a tree of straight cuts, the way split panes nest (a column
 * of rows, a row of columns), and laid out again over the whole area, each part keeping its share as far as every
 * panel stays at least 2 by 2. A layout with no straight cut at all (four panels pinwheeled round a hole) is laid out
 * in reading order instead.
 */
type Node = { item: BoardItem } | { dir: 'x' | 'y'; kids: Array<{ node: Node; len: number }> };

const lo = (o: Rect, dir: 'x' | 'y') => (dir === 'x' ? o.x : o.y);
const len = (o: Rect, dir: 'x' | 'y') => (dir === 'x' ? o.w : o.h);
const hi = (o: Rect, dir: 'x' | 'y') => lo(o, dir) + len(o, dir);

function treeOf(items: BoardItem[], r: Rect): Node {
  if (items.length === 1) return { item: items[0] };
  for (const dir of ['x', 'y'] as const) {
    const r0 = lo(r, dir);
    const r1 = hi(r, dir);
    // the lines no panel crosses
    const cuts = [...new Set(items.flatMap((o) => [lo(o, dir), hi(o, dir)]))].filter((c) => c > r0 && c < r1 && items.every((o) => hi(o, dir) <= c || lo(o, dir) >= c)).sort((a, b) => a - b);
    if (!cuts.length) continue;
    const bounds = [r0, ...cuts, r1];
    const kids: Array<{ node: Node; len: number }> = [];
    let lead = 0;
    for (let i = 0; i + 1 < bounds.length; i++) {
      const [a, b] = [bounds[i], bounds[i + 1]];
      const group = items.filter((o) => lo(o, dir) >= a && hi(o, dir) <= b);
      // an empty strip (a hole right across): its room goes to the part before it (or after, at the start)
      if (!group.length) {
        if (kids.length) kids[kids.length - 1].len += b - a;
        else lead += b - a;
        continue;
      }
      const sub = dir === 'x' ? { x: a, y: r.y, w: b - a, h: r.h } : { x: r.x, y: a, w: r.w, h: b - a };
      kids.push({ node: treeOf(group, sub), len: b - a + lead });
      lead = 0;
    }
    return kids.length === 1 ? kids[0].node : { dir, kids };
  }
  // no straight cut: in reading order, side by side along the longer side
  const dir = r.w >= r.h ? 'x' : 'y';
  return { dir, kids: [...items].sort((a, b) => a.y - b.y || a.x - b.x).map((o) => ({ node: { item: o }, len: 1 })) };
}

/** The least a part can be along a direction: its panels side by side add up, ones across take the most. */
function least(n: Node, dir: 'x' | 'y'): number {
  if ('item' in n) return dir === 'x' ? MIN_W : MIN_H;
  const m = n.kids.map((k) => least(k.node, dir));
  return n.dir === dir ? m.reduce((a, b) => a + b, 0) : Math.max(...m);
}

/** `total` whole cells shared out by weight, each at least its least (rounding fairly: largest remainders first). */
export function shareOut(total: number, weights: number[], mins: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (w / sum) * total);
  const out = raw.map((r, i) => Math.max(mins[i], Math.floor(r)));
  let diff = total - out.reduce((a, b) => a + b, 0);
  const order = (more: boolean) => raw.map((r, i) => [r - out[i], i] as const).sort((a, b) => (more ? b[0] - a[0] : a[0] - b[0]));
  while (diff > 0) for (const [, i] of order(true)) if (diff > 0) (out[i]++, diff--);
  while (diff < 0) {
    const can = order(false).filter(([, i]) => out[i] > mins[i]);
    if (!can.length) break;
    for (const [, i] of can) if (diff < 0 && out[i] > mins[i]) (out[i]--, diff++);
  }
  return out;
}

function lay(n: Node, r: Rect, out: Map<string, BoardItem>): void {
  if ('item' in n) return void out.set(n.item.id, { ...n.item, x: r.x, y: r.y, w: r.w, h: r.h });
  const sizes = shareOut(len(r, n.dir), n.kids.map((k) => k.len), n.kids.map((k) => least(k.node, n.dir)));
  let at = lo(r, n.dir);
  n.kids.forEach((k, i) => {
    lay(k.node, n.dir === 'x' ? { x: at, y: r.y, w: sizes[i], h: r.h } : { x: r.x, y: at, w: r.w, h: sizes[i] }, out);
    at += sizes[i];
  });
}

/** The page laid out over the whole area (see above). Already tiled: as it is. */
export function tile(items: BoardItem[]): BoardItem[] {
  if (!items.length) return items;
  const x0 = Math.min(...items.map((o) => o.x));
  const y0 = Math.min(...items.map((o) => o.y));
  const box = { x: x0, y: y0, w: Math.max(...items.map((o) => o.x + o.w)) - x0, h: Math.max(...items.map((o) => o.y + o.h)) - y0 };
  const out = new Map<string, BoardItem>();
  lay(treeOf(items, box), { x: 0, y: 0, w: COLS, h: ROWS }, out);
  const next = items.map((i) => out.get(i.id)!);
  return next.every((n, k) => n.x === items[k].x && n.y === items[k].y && n.w === items[k].w && n.h === items[k].h) ? items : next;
}

/** Every cell is one panel's: the page tiles the area. */
export const tiles = (items: BoardItem[]) => items.reduce((s, i) => s + i.w * i.h, 0) === COLS * ROWS && items.every((a) => a.x >= 0 && a.y >= 0 && a.x + a.w <= COLS && a.y + a.h <= ROWS && items.every((b) => !collides(a, b)));

/**
 * Drag a line between panels (`id`'s right edge, axis x, or its bottom, axis y, to `size` from its start): the whole
 * line moves, like a split bar. Every panel along it on either side (the run of them touching it, through this one)
 * grows or shrinks, as far as each stays at least 2 wide.
 */
export function moveEdge(items: BoardItem[], id: string, axis: 'x' | 'y', size: number): BoardItem[] {
  const it = items.find((i) => i.id === id);
  if (!it) return items;
  const across = axis === 'x' ? 'y' : 'x';
  const X = hi(it, axis);
  const before = items.filter((o) => hi(o, axis) === X);
  const after = items.filter((o) => lo(o, axis) === X);
  // the run along the line: everything touching it whose span joins up with this panel's
  let span = [lo(it, across), hi(it, across)];
  const run = new Set([it.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const o of [...before, ...after])
      if (!run.has(o.id) && lo(o, across) < span[1] && span[0] < hi(o, across)) {
        run.add(o.id);
        span = [Math.min(span[0], lo(o, across)), Math.max(span[1], hi(o, across))];
        grew = true;
      }
  }
  const min = axis === 'x' ? MIN_W : MIN_H;
  let to = lo(it, axis) + Math.round(size);
  for (const o of before) if (run.has(o.id)) to = Math.max(to, lo(o, axis) + min);
  for (const o of after) if (run.has(o.id)) to = Math.min(to, hi(o, axis) - min);
  if (to === X) return items;
  const out = items.map((o) => {
    if (!run.has(o.id)) return o;
    if (hi(o, axis) === X) return axis === 'x' ? { ...o, w: to - o.x } : { ...o, h: to - o.y };
    return axis === 'x' ? { ...o, x: to, w: o.x + o.w - to } : { ...o, y: to, h: o.y + o.h - to };
  });
  return tiles(out) ? out : tile(out);
}

/** A line between panels, to drag: where it is, how far it runs, and a panel before it (moveEdge moves it by that one). */
export type Line = { axis: 'x' | 'y'; at: number; from: number; to: number; id: string };

/** The lines between the panels (never the area's own edges), each run that moves as one. */
export function lines(items: BoardItem[]): Line[] {
  const out: Line[] = [];
  for (const axis of ['x', 'y'] as const) {
    const across = axis === 'x' ? 'y' : 'x';
    const end = axis === 'x' ? COLS : ROWS;
    for (const at of [...new Set(items.map((o) => hi(o, axis)))].filter((c) => c > 0 && c < end)) {
      const touching = items.filter((o) => hi(o, axis) === at || lo(o, axis) === at);
      const seen = new Set<string>();
      for (const first of touching) {
        if (seen.has(first.id) || hi(first, axis) !== at) continue;
        let span = [lo(first, across), hi(first, across)];
        seen.add(first.id);
        for (let grew = true; grew; ) {
          grew = false;
          for (const o of touching)
            if (!seen.has(o.id) && lo(o, across) < span[1] && span[0] < hi(o, across)) {
              seen.add(o.id);
              span = [Math.min(span[0], lo(o, across)), Math.max(span[1], hi(o, across))];
              grew = true;
            }
        }
        out.push({ axis, at, from: span[0], to: span[1], id: first.id });
      }
    }
  }
  return out;
}

/** A point where lines meet (a corner of panels): every line through it, up and down (`vs`) and across (`hs`). */
export type Meet = { x: number; y: number; vs: Line[]; hs: Line[] };

/**
 * Where up-and-down lines meet across ones: one point each, however many lines run through it (two lines that happen
 * to line up meet a third at the same point), so dragging there moves all of them.
 */
export function crossings(ls: Line[]): Meet[] {
  const at = new Map<string, Meet>();
  for (const v of ls)
    if (v.axis === 'x')
      for (const h of ls)
        if (h.axis === 'y' && h.from <= v.at && v.at <= h.to && v.from <= h.at && h.at <= v.to) {
          const k = `${v.at},${h.at}`;
          const m = at.get(k) ?? { x: v.at, y: h.at, vs: [], hs: [] };
          if (!m.vs.includes(v)) m.vs.push(v);
          if (!m.hs.includes(h)) m.hs.push(h);
          at.set(k, m);
        }
  return [...at.values()];
}

/** Drag a meeting point to (x, y): every line through it goes there, as far as each can. */
export function moveMeet(items: BoardItem[], m: Meet, x: number, y: number): BoardItem[] {
  let out = items;
  for (const v of m.vs) out = moveLine(out, v, x);
  for (const h of m.hs) out = moveLine(out, h, y);
  return out;
}

/** Move a line to `at` (the panel it's moved by, from lines()). */
export function moveLine(items: BoardItem[], l: Line, at: number): BoardItem[] {
  const it = items.find((i) => i.id === l.id);
  return it ? moveEdge(items, l.id, l.axis, at - lo(it, l.axis)) : items;
}

/** Where a line ended up after a move (the panel it's moved by: its far edge). */
export function lineAt(items: BoardItem[], l: Line): number {
  const it = items.find((i) => i.id === l.id);
  return it ? hi(it, l.axis) : l.at;
}

type Rect = { x: number; y: number; w: number; h: number };
export type Drop = 'swap' | 'left' | 'right' | 'top' | 'bottom';

/**
 * A hole (a panel moved or removed) is taken up by its neighbours: on the first side where the panels along it cover
 * its whole length (left, right, above, below), they grow into it. None: it stays (the gaps close upward).
 */
export function fillHole(items: BoardItem[], hole: Rect): BoardItem[] {
  const sides: Array<{
    touch(o: BoardItem): boolean;
    v: boolean;
    grow(o: BoardItem): BoardItem;
  }> = [
    {
      touch: (o) => o.x + o.w === hole.x,
      v: true,
      grow: (o) => ({ ...o, w: o.w + hole.w }),
    },
    {
      touch: (o) => o.x === hole.x + hole.w,
      v: true,
      grow: (o) => ({ ...o, x: hole.x, w: o.w + hole.w }),
    },
    {
      touch: (o) => o.y + o.h === hole.y,
      v: false,
      grow: (o) => ({ ...o, h: o.h + hole.h }),
    },
    {
      touch: (o) => o.y === hole.y + hole.h,
      v: false,
      grow: (o) => ({ ...o, y: hole.y, h: o.h + hole.h }),
    },
  ];
  for (const s of sides) {
    const group = items.filter((o) => s.touch(o) && (s.v ? o.y >= hole.y && o.y + o.h <= hole.y + hole.h : o.x >= hole.x && o.x + o.w <= hole.x + hole.w));
    const covered = group.reduce((n, o) => n + (s.v ? o.h : o.w), 0);
    if (group.length && covered === (s.v ? hole.h : hole.w)) {
      const ids = new Set(group.map((o) => o.id));
      return items.map((o) => (ids.has(o.id) ? s.grow(o) : o));
    }
  }
  return items;
}

/**
 * Drop a panel on an edge of the whole board: it runs the full width (top, bottom) or height (left, right) along that
 * side, as deep as it was (at most half the board), and the rest is laid out in what's left.
 */
export function dropEdge(items: BoardItem[], id: string, side: Exclude<Drop, 'swap'>): BoardItem[] {
  const a = items.find((i) => i.id === id);
  if (!a) return items;
  const rest = tile(fillHole(items.filter((o) => o.id !== id), a));
  if (!rest.length) return items;
  const across = side === 'left' || side === 'right';
  const total = across ? COLS : ROWS;
  const room = total - least(treeOf(rest, { x: 0, y: 0, w: COLS, h: ROWS }), across ? 'x' : 'y');
  const deep = Math.max(across ? MIN_W : MIN_H, Math.min(across ? a.w : a.h, Math.floor(total / 2), room));
  const mine: Rect =
    side === 'left' ? { x: 0, y: 0, w: deep, h: ROWS } : side === 'right' ? { x: COLS - deep, y: 0, w: deep, h: ROWS } : side === 'top' ? { x: 0, y: 0, w: COLS, h: deep } : { x: 0, y: ROWS - deep, w: COLS, h: deep };
  const left: Rect =
    side === 'left' ? { x: deep, y: 0, w: COLS - deep, h: ROWS } : side === 'right' ? { x: 0, y: 0, w: COLS - deep, h: ROWS } : side === 'top' ? { x: 0, y: deep, w: COLS, h: ROWS - deep } : { x: 0, y: 0, w: COLS, h: ROWS - deep };
  const out = new Map<string, BoardItem>();
  lay(treeOf(rest, { x: 0, y: 0, w: COLS, h: ROWS }), left, out);
  return items.map((o) => (o.id === id ? { ...o, ...mine } : out.get(o.id)!));
}

/**
 * Drop a panel on another: on its middle, they swap places (and sizes); near an edge, it takes that half of the other
 * (its own place taken up by its neighbours). Too small to halve: they swap.
 */
export function dropOn(items: BoardItem[], id: string, targetId: string, how: Drop): BoardItem[] {
  const a = items.find((i) => i.id === id);
  const t = items.find((i) => i.id === targetId);
  if (!a || !t || a === t) return items;
  const swap = () => items.map((o) => (o.id === a.id ? { ...o, x: t.x, y: t.y, w: t.w, h: t.h } : o.id === t.id ? { ...o, x: a.x, y: a.y, w: a.w, h: a.h } : o));
  if (how === 'swap') return swap();
  const rest = fillHole(
    items.filter((o) => o.id !== id),
    a,
  );
  const halves = split(
    rest.find((o) => o.id === targetId)!,
    how,
  );
  if (!halves) return swap();
  const [mine, theirs] = halves;
  return tile(items.map((o) => (o.id === id ? { ...o, ...mine } : o.id === targetId ? { ...o, ...theirs } : (rest.find((r) => r.id === o.id) ?? o))));
}

/** Whether a panel can be halved on that side (each half at least the least size). */
export const canSplit = (T: Rect, how: Exclude<Drop, 'swap'>) => (how === 'left' || how === 'right' ? T.w >= 2 * MIN_W : T.h >= 2 * MIN_H);

/** A panel halved: the half on that side, and what it keeps (too small to halve: none). */
function split(T: BoardItem, how: Exclude<Drop, 'swap'>): [Rect, Rect] | null {
  const across = how === 'left' || how === 'right';
  if (!canSplit(T, how)) return null;
  const half = Math.floor((across ? T.w : T.h) / 2);
  return how === 'left'
    ? [
        { x: T.x, y: T.y, w: half, h: T.h },
        { x: T.x + half, y: T.y, w: T.w - half, h: T.h },
      ]
    : how === 'right'
      ? [
          { x: T.x + T.w - half, y: T.y, w: half, h: T.h },
          { x: T.x, y: T.y, w: T.w - half, h: T.h },
        ]
      : how === 'top'
        ? [
            { x: T.x, y: T.y, w: T.w, h: half },
            { x: T.x, y: T.y + half, w: T.w, h: T.h - half },
          ]
        : [
            { x: T.x, y: T.y + T.h - half, w: T.w, h: half },
            { x: T.x, y: T.y, w: T.w, h: T.h - half },
          ];
}

/** Close a panel (its place goes to its neighbours). A page can be left empty; a board left empty is the default again. */
export function removePanel(items: BoardItem[], id: string): BoardItem[] {
  const gone = items.find((i) => i.id === id);
  return gone ? tile(fillHole(items.filter((i) => i.id !== id), gone)) : items;
}

/** Put a new panel in: it takes half of the biggest panel (across its longer side). */
function place(items: BoardItem[], add: Omit<BoardItem, 'x' | 'y'>): BoardItem[] {
  // alone on a page: the whole of it
  if (!items.length) return [{ ...add, x: 0, y: 0, w: COLS, h: ROWS }];
  const big = [...items].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const halves = split(big, big.w >= big.h ? 'right' : 'bottom') ?? split(big, big.w >= big.h ? 'bottom' : 'right');
  if (!halves) return tile([...items, { ...add, x: 0, y: bottom(items), w: COLS, h: MIN_H }]);
  return [...items.map((o) => (o.id === big.id ? { ...o, ...halves[1] } : o)), { ...add, ...halves[0] }];
}

/** Add a panel (once each), in half of the biggest. */
export function addPanel(items: BoardItem[], k: Exclude<PanelKind, 'explain'>): BoardItem[] {
  if (items.some((p) => p.k === k)) return items;
  const [w, h] = PANELS[k].size ?? [6, 6];
  return place(items, { id: `${k}:${Date.now().toString(36)}`, k, w, h });
}

/** Pop an explain out into a panel of its own (`items`: what its session sees). Already out: as it is. */
export function popExplain(items: BoardItem[], sid: string, title: string): BoardItem[] {
  if (items.some((p) => p.k === 'explain' && p.sid === sid && p.title === title)) return items;
  return place(items, {
    id: `explain:${Date.now().toString(36)}`,
    k: 'explain',
    w: 12,
    h: 14,
    sid,
    title,
  });
}

/** What a session sees: its own popped-out explains and every other panel, others' explains' places taken up. */
export function visible(items: BoardItem[], sid: string, pg = 0): BoardItem[] {
  const page = items.filter((p) => pageOf(p) === pg);
  let mine = page.filter((p) => p.k !== 'explain' || p.sid === sid);
  for (const o of page) if (!mine.includes(o)) mine = fillHole(mine, o);
  return tile(mine);
}

/**
 * A session changed what it sees of a page (`next`, from visible()): those panels on that page, and every other page
 * and the panels only other sessions see as they were.
 */
export function merge(items: BoardItem[], sid: string, next: BoardItem[], pg = 0): BoardItem[] {
  const mine = (p: BoardItem) => pageOf(p) === pg && (p.k !== 'explain' || p.sid === sid);
  return [...next.map(({ pg: _, ...p }) => (pg ? { ...p, pg } : p)), ...items.filter((p) => !mine(p))];
}

/** How many pages there are: the last one with panels on it, or more if you made empty ones (`made`). */
export const pageCount = (items: BoardItem[], made = 1) => Math.min(MAX_PAGES, Math.max(made, ...items.map((p) => pageOf(p) + 1)));

/** Send a panel to another page: its place on this page goes to its neighbours, it lands where there's room there. */
export function sendToPage(items: BoardItem[], sid: string, id: string, from: number, to: number): BoardItem[] {
  const it = items.find((i) => i.id === id);
  if (!it || from === to) return items;
  const here = merge(items, sid, removePanel(visible(items, sid, from), id), from);
  const { x: _x, y: _y, ...moving } = it;
  return merge(here, sid, place(visible(here, sid, to), moving), to);
}

/** Remove a page (its panels go with it); the pages after it move up one. */
export function removePage(items: BoardItem[], pg: number): BoardItem[] {
  return items.filter((p) => pageOf(p) !== pg).map((p) => (pageOf(p) > pg ? { ...p, pg: pageOf(p) - 1 } : p)).map(({ pg, ...p }) => (pg ? { ...p, pg } : p));
}

/** Each session's board: its panels, how many pages it has (some may be empty) and the page showing. */
export type SessionBoard = {
  items: BoardItem[];
  pages?: number;
  page?: number;
  /** each page's name, if it has one (a layout's, when one was added) */
  names?: Array<string | null>;
  /** the session's asks (its board tool) already acted on */
  done?: string[];
};
/** Boards kept for at most this many sessions (the ones gone are dropped first). */
export const BOARDS_KEPT = 150;

/** The layout a new session starts with: the one you chose (or the default), without any session's explains. */
export function template(raw: unknown): BoardItem[] {
  let items = normalize(raw);
  for (const p of items) if (p.k === 'explain') items = removePanel(items, p.id);
  // a Terminal panel's shell is that session's: a new one starts its own
  if (items.some((p) => p.term || p.terms)) items = items.map(({ term: _t, terms: _ts, ...p }) => p);
  return items.length ? items : DEFAULT_BOARD;
}

/** The sessions' boards with one changed: only sessions still around (`alive`), at most BOARDS_KEPT, newest last. */
export function keepBoards(boards: Record<string, SessionBoard> | undefined, sid: string, next: SessionBoard, alive: (sid: string) => boolean): Record<string, SessionBoard> {
  // Cora's own board is never one of the sessions' to let go
  // Cora's own board and the projects' are never the sessions' to let go
  const ours = (k: string) => k === CORA_BOARD || k.startsWith('project:');
  const kept = Object.entries(boards ?? {}).filter(([k]) => k !== sid && ours(k));
  const rest = Object.entries(boards ?? {}).filter(([k]) => k !== sid && !ours(k) && alive(k));
  return Object.fromEntries([...kept, ...rest.slice(-(BOARDS_KEPT - 1)), [sid, next]]);
}

/** A layout from the preferences (anything odd dropped). The earlier columns layout is turned into the grid. */
export function normalize(raw: unknown): BoardItem[] {
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_BOARD;
  if (raw.every((c: any) => Array.isArray(c?.panels))) return fromColumns(raw as Array<{ w?: unknown; panels: any[] }>);
  const seen = new Set<string>();
  // a page from before the finer grid (its panels within 12 across): each place and size doubled
  const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
  const pgOf = (p: any) => int(p?.pg, 0, MAX_PAGES - 1, 0);
  const wide = new Map<number, number>();
  for (const p of raw as any[]) wide.set(pgOf(p), Math.max(wide.get(pgOf(p)) ?? 0, num(p?.x) + num(p?.w)));
  const scale = (p: any) => ((wide.get(pgOf(p)) ?? 0) <= OLD_COLS ? { ...p, x: num(p.x) * 2, y: num(p.y) * 2, w: num(p.w) * 2, h: num(p.h) * 2 } : p);
  const items = (raw as any[])
    .map((p) => (p && typeof p === 'object' ? scale(p) : p))
    .filter((p: any) => typeof p?.id === 'string' && KINDS.has(p.k) && !seen.has(p.id) && (seen.add(p.id), true))
    .filter((p: any) => p.k !== 'explain' || (typeof p.sid === 'string' && typeof p.title === 'string'))
    .map((p: any): BoardItem => {
      const w = int(p.w, MIN_W, COLS, 12);
      return {
        id: p.id,
        k: p.k,
        x: int(p.x, 0, COLS - w, 0),
        y: int(p.y, 0, 1000, 0),
        w,
        h: int(p.h, MIN_H, 200, 12),
        ...(p.k === 'explain' ? { sid: p.sid, title: p.title } : {}),
        ...(int(p.pg, 0, MAX_PAGES - 1, 0) ? { pg: int(p.pg, 0, MAX_PAGES - 1, 0) } : {}),
        ...(p.k === 'spotlight' && typeof p.pin === 'string' && p.pin.length < 200 ? { pin: p.pin } : {}),
        ...(p.k === 'terminal' && typeof p.term === 'string' && p.term.length < 80 ? { term: p.term } : {}),
        ...(typeof p.for === 'string' && p.for.length < 90 ? { for: p.for } : {}),
        ...(p.k === 'terminal' && Array.isArray(p.terms) ? { terms: (p.terms as unknown[]).filter((t): t is string => typeof t === 'string' && t.length < 80).slice(0, 12) } : {}),
      };
    });
  if (!items.length) return DEFAULT_BOARD;
  // each page on its own
  const pages = [...new Set(items.map(pageOf))];
  const done = new Map(pages.flatMap((pg) => tile(items.filter((p) => pageOf(p) === pg)).map((p) => [p.id, p] as const)));
  return items.map((p) => done.get(p.id)!);
}

/** The columns layout (before the grid): each column its share of the 12 across, its panels their share of the 12 down. */
function fromColumns(cols: Array<{ w?: unknown; panels: any[] }>): BoardItem[] {
  const share = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 1);
  const kept = cols.slice(0, COLS / MIN_W).filter((c) => c.panels.some((p) => typeof p?.id === 'string' && KINDS.has(p.k)));
  if (!kept.length) return DEFAULT_BOARD;
  const total = kept.reduce((s, c) => s + share(c.w), 0);
  const items: unknown[] = [];
  let x = 0;
  kept.forEach((c, i) => {
    const w = i === kept.length - 1 ? COLS - x : Math.max(MIN_W, Math.min(COLS - x - MIN_W * (kept.length - i - 1), Math.round((share(c.w) / total) * COLS)));
    const panels = c.panels.filter((p) => typeof p?.id === 'string' && KINDS.has(p.k));
    const sum = panels.reduce((s, p) => s + share(p.h), 0);
    let y = 0;
    panels.forEach((p, j) => {
      const h = j === panels.length - 1 ? Math.max(MIN_H, ROWS - y) : Math.max(MIN_H, Math.round((share(p.h) / sum) * ROWS));
      items.push({ ...p, x, y, w, h });
      y += h;
    });
    x += w;
  });
  return normalize(items);
}

/** A layout you saved (+ Panel › Save this page as a layout): its name and its panels. */
export type SavedLayout = { id: string; name: string; items: BoardItem[] };

type Placed = Pick<BoardItem, 'k' | 'x' | 'y' | 'w' | 'h'>;
const P = (k: Exclude<PanelKind, 'explain'>, x: number, y: number, w: number, h: number): Placed => ({ k, x, y, w, h });
/**
 * The layouts for kinds of work (shared/boardLayouts names them), on the 24 by 24 grid. Each has the Spotlight (it
 * follows what matters now); Coding and Reviewing are led by the IDE (a debrief plays there), its terminal under it.
 */
export const LAYOUTS: Record<BoardLayoutId, Placed[]> = {
  investigating: [P('spotlight', 0, 0, 12, 24), P('browser', 12, 0, 12, 14), P('touching', 12, 14, 6, 10), P('terminal', 18, 14, 6, 10)],
  coding: [P('ide', 0, 0, 15, 17), P('terminal', 0, 17, 15, 7), P('spotlight', 15, 0, 9, 15), P('tests', 15, 15, 9, 9)],
  reviewing: [P('ide', 0, 0, 15, 24), P('spotlight', 15, 0, 9, 10), P('changes', 15, 10, 9, 8), P('ticket', 15, 18, 9, 6)],
  shipping: [P('pipeline', 0, 0, 12, 12), P('deploys', 12, 0, 12, 12), P('spotlight', 0, 12, 12, 12), P('ticket', 12, 12, 12, 12)],
  writing: [P('explains', 0, 0, 14, 24), P('spotlight', 14, 0, 10, 14), P('notes', 14, 14, 10, 10)],
};

/** A layout's panels, each new (fresh ids; no explains: those belong to a session), laid out over the whole page. */
export function fromLayout(layout: Placed[]): BoardItem[] {
  const stamp = Date.now().toString(36);
  return tile(layout.filter((p) => p.k !== 'explain').map((p, i) => ({ id: `${p.k}:${stamp}${i}`, k: p.k, x: p.x, y: p.y, w: p.w, h: p.h })));
}

/** Add a page laid out so, after the last one: everything, and its number (none at the most pages there can be). */
export function addLayoutPage(all: BoardItem[], made: number, layout: Placed[]): { items: BoardItem[]; page: number } | null {
  const page = pageCount(all, made);
  if (page >= MAX_PAGES) return null;
  return { items: [...all, ...fromLayout(layout).map((p) => ({ ...p, pg: page }))], page };
}

/** A page of the board kept as a layout (its explains left out, the rest laid out again over the page). */
export function asLayout(items: BoardItem[]): Placed[] {
  return tile(items.filter((p) => p.k !== 'explain')).map(({ k, x, y, w, h }) => ({ k, x, y, w, h }));
}

/** The pages' names after one is removed (the ones after it move up). */
export const namesWithout = (names: Array<string | null> | undefined, pg: number) => (names ? names.filter((_, i) => i !== pg) : names);

/** Move a page to another place among the pages (the ones between shift over); and the names with it. */
/** Where page `p` is after one moves from `from` to `to`. */
export const movedTo = (p: number, from: number, to: number) => (p === from ? to : from < to && p > from && p <= to ? p - 1 : from > to && p >= to && p < from ? p + 1 : p);

export function movePage(items: BoardItem[], from: number, to: number): BoardItem[] {
  if (from === to) return items;
  return items.map((p) => {
    const n = movedTo(pageOf(p), from, to);
    const { pg: _, ...rest } = p;
    return n ? { ...rest, pg: n } : rest;
  });
}
export function moveName<T>(names: T[] | undefined, from: number, to: number): T[] | undefined {
  if (!names || from === to) return names;
  const out = [...names];
  while (out.length <= Math.max(from, to)) out.push(null as T);
  const [n] = out.splice(from, 1);
  out.splice(to, 0, n);
  return out;
}

/** A copy of a page (as a session sees it), after the last one: new panels (a terminal starts its own shell). */
export function duplicatePage(all: BoardItem[], sid: string, pg: number, made: number): { items: BoardItem[]; page: number } | null {
  const page = pageCount(all, made);
  if (page >= MAX_PAGES) return null;
  const stamp = Date.now().toString(36);
  const copy = visible(all, sid, pg).map(({ term: _t, terms: _ts, ...p }, i) => ({ ...p, id: `${p.k}:${stamp}${i}`, pg: page }));
  return { items: [...all, ...copy], page };
}

/**
 * Where the bar's strip of page tabs (`view` wide, scrolled to `scroll`) scrolls to show a tab (at `at`, `size` wide)
 * whole, `pad` clear of the fade at either edge; it stays put when the tab already shows. Wider than the strip: its start.
 */
export function scrollToShow(scroll: number, view: number, at: number, size: number, pad = 0): number {
  if (at - pad < scroll) return Math.max(0, at - pad);
  if (at + size + pad > scroll + view) return Math.max(0, Math.min(at - pad, at + size + pad - view));
  return scroll;
}
