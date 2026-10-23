/**
 * The live board's layout (the scene area with 3D off): panels on a grid that snaps, like a dashboard. 12 columns across
 * the whole width and 12 rows down the whole height, both as shares of the area, so the board keeps its shape at any
 * window size (taller than the area: it scrolls). It stays filled: a panel dropped on another swaps with it, or near
 * an edge takes that half of it; an edge drags like a split bar (the panels along it on both sides move with it); one
 * moved or removed leaves its place to its neighbours. A corner resizes one panel freely, and a panel dropped on empty
 * cells goes there (ones in the way move down, everything floats up to close gaps). Each session has its own board
 * (SessionBoard); a new one starts from a template. Pure: the board (components/LiveBoard.tsx) renders
 * it and keeps it in the UI preferences.
 */

export type PanelKind =
  | 'spotlight'
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
};

/** At most this many pages of panels. */
export const MAX_PAGES = 9;
const pageOf = (p: BoardItem) => p.pg ?? 0;

export const COLS = 12;
/** The rows that fill the area's height (a panel can go below them: the board scrolls). */
export const ROWS = 12;
export const MIN_W = 2;
export const MIN_H = 2;

/** Each panel's icon (Lucide) in the + Panel menu and its header. */
export const PANEL_ICON: Record<Exclude<PanelKind, 'explain'>, string> = {
  spotlight: 'Sparkles', agents: 'Bot', touching: 'Activity', tasks: 'ListChecks', explains: 'FileText', goal: 'Target', memes: 'Laugh', recap: 'ScrollText', context: 'Gauge',
  changes: 'FileDiff', git: 'GitBranch', tests: 'FlaskConical', background: 'Loader',
  pipeline: 'GitPullRequest', deploys: 'Rocket', ticket: 'Ticket',
  needs: 'Hand', mentions: 'AtSign', notes: 'NotebookPen', usage: 'ChartPie', sessions: 'LayoutList',
  terminal: 'SquareTerminal', browser: 'Globe',
};

/** Where a panel sits in the + Panel menu. */
export const PANEL_GROUPS = ['This session', 'Code', 'Delivery', 'Around you', 'Tools'] as const;
export type PanelGroup = (typeof PANEL_GROUPS)[number];

/** The panels you can add (an explain is added from the Explains panel, or the menu's explains), and their size when added. */
export const PANELS: Record<Exclude<PanelKind, 'explain'>, { name: string; hint: string; group: PanelGroup; size?: [number, number] }> = {
  spotlight: { name: 'Spotlight', hint: 'Follows what matters now, or what Claude asks to show', group: 'This session', size: [6, 7] },
  agents: { name: 'Agents', hint: "Each agent and what it's doing now", group: 'This session' },
  touching: { name: 'Touching', hint: 'Files, web, shell and tools of the last 10 minutes', group: 'This session' },
  tasks: { name: 'Tasks', hint: "Claude's task list", group: 'This session', size: [4, 4] },
  explains: { name: 'Explains', hint: "This session's explains, with previews", group: 'This session' },
  goal: { name: 'Goal', hint: 'What the session was asked, and the latest ask', group: 'This session', size: [5, 4] },
  memes: { name: 'Memes', hint: "Memes and GIFs the session posts about what's happening (turn them on in Settings › Sessions)", group: 'This session', size: [4, 6] },
  recap: { name: 'Recap', hint: "Claude Code's recaps of the session, newest first: where it stands, what's next", group: 'This session', size: [5, 6] },
  context: { name: 'Context', hint: 'How full the context window is, and how fast it fills', group: 'This session', size: [4, 4] },
  changes: { name: 'Changes', hint: 'Files changed this session, with their diffs', group: 'Code', size: [7, 7] },
  git: { name: 'Git', hint: 'The branch, uncommitted files, commits made', group: 'Code', size: [5, 6] },
  tests: { name: 'Tests', hint: 'Test runs: what passed and failed, run by run', group: 'Code', size: [5, 5] },
  background: { name: 'Background', hint: 'Commands running in the background, with their output', group: 'Code', size: [6, 5] },
  pipeline: { name: 'Pipeline & MR', hint: "The branch's pipeline stage by stage, and its merge request", group: 'Delivery', size: [6, 5] },
  deploys: { name: 'Deploys', hint: 'Where the change has got to: MR, pipeline, tag, environments', group: 'Delivery', size: [7, 4] },
  ticket: { name: 'Ticket', hint: "The session's Jira ticket", group: 'Delivery', size: [5, 6] },
  needs: { name: 'Needs you', hint: 'Approvals and questions waiting on you, with their buttons', group: 'Around you', size: [6, 5] },
  mentions: { name: 'Mentions', hint: "Inbox items about this session's ticket, branch or work", group: 'Around you', size: [5, 6] },
  notes: { name: 'Notes', hint: "Scratch jots, this session's marked; jot one down", group: 'Around you', size: [5, 6] },
  usage: { name: 'Usage', hint: "Your plan's limits, as /usage shows them, and extra usage", group: 'Around you', size: [5, 6] },
  sessions: { name: 'All sessions', hint: "Every session and what it's doing; click one to go there", group: 'Around you', size: [5, 7] },
  terminal: { name: 'Terminal', hint: "The session's terminal or a shell, live (to watch; type in the terminal pane)", group: 'Tools', size: [7, 7] },
  browser: { name: 'Browser', hint: 'A browser of its own, with its own tabs and profiles', group: 'Tools', size: [7, 8] },
};

export const DEFAULT_BOARD: BoardItem[] = [
  { id: 'agents', k: 'agents', x: 0, y: 0, w: 7, h: 8 },
  { id: 'touching', k: 'touching', x: 7, y: 0, w: 5, h: 6 },
  { id: 'explains', k: 'explains', x: 7, y: 6, w: 5, h: 6 },
  { id: 'tasks', k: 'tasks', x: 0, y: 8, w: 7, h: 4 },
];

const KINDS = new Set<PanelKind>([...(Object.keys(PANELS) as PanelKind[]), 'explain']);
const int = (n: unknown, lo: number, hi: number, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d);

export const collides = (a: BoardItem, b: BoardItem) => a.id !== b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const bottom = (items: BoardItem[]) => items.reduce((m, i) => Math.max(m, i.y + i.h), 0);

/** Everything floats up as far as it can without passing another panel (top to bottom, left to right); overlaps go below. */
export function compact(items: BoardItem[]): BoardItem[] {
  const placed: BoardItem[] = [];
  for (const it of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const at = { ...it };
    while (placed.some((p) => collides(at, p))) at.y++;
    while (at.y > 0 && !placed.some((p) => collides({ ...at, y: at.y - 1 }, p))) at.y--;
    placed.push(at);
  }
  return items.map((i) => placed.find((p) => p.id === i.id)!);
}

/**
 * Put one panel somewhere (its place or size): it stays there; one in its way that starts above it goes above it if
 * there's room (so dragging a panel down past another swaps them), the rest go below it; then the gaps close.
 */
function settle(items: BoardItem[], moved: BoardItem): BoardItem[] {
  const placed = [moved];
  const rest = items.filter((i) => i.id !== moved.id);
  for (const it of [...rest].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const at = { ...it };
    if (collides(at, moved) && at.y < moved.y) {
      const up = { ...at, y: moved.y - at.h };
      if (up.y >= 0 && !placed.some((p) => collides(up, p)) && !rest.some((o) => o.id !== at.id && !placed.some((p) => p.id === o.id) && collides(up, o))) {
        placed.push(up);
        continue;
      }
    }
    while (placed.some((p) => collides(at, p))) at.y++;
    while (at.y > 0 && !placed.some((p) => collides({ ...at, y: at.y - 1 }, p))) at.y--;
    placed.push(at);
  }
  return compact(items.map((i) => placed.find((p) => p.id === i.id)!));
}

/** Move a panel to a cell (kept on the grid). */
export function moveTo(items: BoardItem[], id: string, x: number, y: number): BoardItem[] {
  const it = items.find((i) => i.id === id);
  if (!it) return items;
  return settle(items, {
    ...it,
    x: Math.max(0, Math.min(COLS - it.w, Math.round(x))),
    y: Math.max(0, Math.round(y)),
  });
}

/** Resize a panel (at least 2 by 2, within the width). Its neighbour across the edge gives way or takes up the room. */
export function resizeTo(items: BoardItem[], id: string, w: number, h: number): BoardItem[] {
  const it = items.find((i) => i.id === id);
  if (!it) return items;
  const next = {
    ...it,
    w: Math.max(MIN_W, Math.min(COLS - it.x, Math.round(w))),
    h: Math.max(MIN_H, Math.round(h)),
  };
  const out = items.map((o) => ({ ...o }));
  const free = (o: BoardItem, t: BoardItem) => !out.some((q) => q.id !== o.id && q.id !== id && collides(t, q));
  for (const o of out) {
    if (o.id === id) continue;
    const rows = o.y < it.y + it.h && it.y < o.y + o.h;
    const cols = o.x < it.x + it.w && it.x < o.x + o.w;
    // beside it: wider, the neighbour narrows (if it can); narrower, the neighbour widens (if nothing's in its way)
    if (rows && o.x === it.x + it.w && next.w !== it.w) {
      const t = { ...o, x: it.x + next.w, w: o.x + o.w - (it.x + next.w) };
      if (t.w >= MIN_W && (next.w > it.w ? collides(next, o) : free(o, t))) Object.assign(o, t);
    }
    // below it, the same for the height
    if (cols && o.y === it.y + it.h && next.h !== it.h) {
      const t = { ...o, y: it.y + next.h, h: o.y + o.h - (it.y + next.h) };
      if (t.h >= MIN_H && (next.h > it.h ? collides(next, o) : free(o, t))) Object.assign(o, t);
    }
  }
  return settle(out, next);
}

/**
 * Drag a panel's right (or bottom) edge: the whole line it's part of moves, like a split bar. Every panel along it on
 * either side (the run of them touching it, through this one) grows or shrinks, as far as each stays at least 2 wide.
 */
export function moveEdge(items: BoardItem[], id: string, axis: 'x' | 'y', size: number): BoardItem[] {
  const it = items.find((i) => i.id === id);
  if (!it) return items;
  const X = axis === 'x' ? it.x + it.w : it.y + it.h;
  const lo = (o: BoardItem) => (axis === 'x' ? o.x : o.y);
  const len = (o: BoardItem) => (axis === 'x' ? o.w : o.h);
  const a0 = (o: BoardItem) => (axis === 'x' ? o.y : o.x);
  const a1 = (o: BoardItem) => (axis === 'x' ? o.y + o.h : o.x + o.w);
  const before = items.filter((o) => lo(o) + len(o) === X);
  const after = items.filter((o) => lo(o) === X);
  // the run along the line: everything touching it whose span joins up with this panel's
  let span = [a0(it), a1(it)];
  const run = new Set([it.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const o of [...before, ...after])
      if (!run.has(o.id) && a0(o) < span[1] && span[0] < a1(o)) {
        run.add(o.id);
        span = [Math.min(span[0], a0(o)), Math.max(span[1], a1(o))];
        grew = true;
      }
  }
  const min = axis === 'x' ? MIN_W : MIN_H;
  const max = axis === 'x' ? COLS : Infinity;
  let to = lo(it) + Math.round(size);
  for (const o of before) if (run.has(o.id)) to = Math.max(to, lo(o) + min);
  for (const o of after) if (run.has(o.id)) to = Math.min(to, lo(o) + len(o) - min);
  to = Math.min(to, max);
  if (to === X) return items;
  const out = items.map((o) => {
    if (!run.has(o.id)) return o;
    if (lo(o) + len(o) === X) return axis === 'x' ? { ...o, w: to - o.x } : { ...o, h: to - o.y };
    return axis === 'x' ? { ...o, x: to, w: o.x + o.w - to } : { ...o, y: to, h: o.y + o.h - to };
  });
  return out.some((a) => out.some((b) => collides(a, b))) ? compact(out) : out;
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
  return compact(items.map((o) => (o.id === id ? { ...o, ...mine } : o.id === targetId ? { ...o, ...theirs } : (rest.find((r) => r.id === o.id) ?? o))));
}

/** A panel halved: the half on that side, and what it keeps (too small to halve: none). */
function split(T: BoardItem, how: Exclude<Drop, 'swap'>): [Rect, Rect] | null {
  const across = how === 'left' || how === 'right';
  if ((across ? T.w : T.h) < 2 * (across ? MIN_W : MIN_H)) return null;
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
  return gone ? compact(fillHole(items.filter((i) => i.id !== id), gone)) : items;
}

/** The first place a w×h panel fits within the area (or what's already below it), if any. */
export function freeSpot(items: BoardItem[], w: number, h: number): { x: number; y: number } | null {
  const end = Math.max(ROWS, bottom(items));
  for (let y = 0; y + h <= end; y++) for (let x = 0; x + w <= COLS; x++) if (!items.some((i) => collides({ id: '\u0000', k: 'agents', x, y, w, h }, i))) return { x, y };
  return null;
}

/** Put a new panel where there's room; none: it takes half of the biggest panel (across its longer side). */
function place(items: BoardItem[], add: Omit<BoardItem, 'x' | 'y'>): BoardItem[] {
  // alone on a page: the whole of it
  if (!items.length) return [{ ...add, x: 0, y: 0, w: COLS, h: ROWS }];
  const at = freeSpot(items, add.w, add.h);
  if (at) return compact([...items, { ...add, ...at }]);
  const big = [...items].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const halves = split(big, big.w >= big.h ? 'right' : 'bottom');
  if (!halves) return [...items, { ...add, x: 0, y: bottom(items) }];
  return [...items.map((o) => (o.id === big.id ? { ...o, ...halves[1] } : o)), { ...add, ...halves[0] }];
}

/** Add a panel (once each), where there's room or beside the biggest. */
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
    w: 6,
    h: 7,
    sid,
    title,
  });
}

/** What a session sees: its own popped-out explains and every other panel, others' explains' places taken up. */
export function visible(items: BoardItem[], sid: string, pg = 0): BoardItem[] {
  const page = items.filter((p) => pageOf(p) === pg);
  let mine = page.filter((p) => p.k !== 'explain' || p.sid === sid);
  for (const o of page) if (!mine.includes(o)) mine = fillHole(mine, o);
  return compact(mine);
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
export type SessionBoard = { items: BoardItem[]; pages?: number; page?: number };
/** Boards kept for at most this many sessions (the ones gone are dropped first). */
export const BOARDS_KEPT = 150;

/** The layout a new session starts with: the one you chose (or the default), without any session's explains. */
export function template(raw: unknown): BoardItem[] {
  let items = normalize(raw);
  for (const p of items) if (p.k === 'explain') items = removePanel(items, p.id);
  return items.length ? items : DEFAULT_BOARD;
}

/** The sessions' boards with one changed: only sessions still around (`alive`), at most BOARDS_KEPT, newest last. */
export function keepBoards(boards: Record<string, SessionBoard> | undefined, sid: string, next: SessionBoard, alive: (sid: string) => boolean): Record<string, SessionBoard> {
  const rest = Object.entries(boards ?? {}).filter(([k]) => k !== sid && alive(k));
  return Object.fromEntries([...rest.slice(-(BOARDS_KEPT - 1)), [sid, next]]);
}

/** A layout from the preferences (anything odd dropped). The earlier columns layout is turned into the grid. */
export function normalize(raw: unknown): BoardItem[] {
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_BOARD;
  if (raw.every((c: any) => Array.isArray(c?.panels))) return fromColumns(raw as Array<{ w?: unknown; panels: any[] }>);
  const seen = new Set<string>();
  const items = raw
    .filter((p: any) => typeof p?.id === 'string' && KINDS.has(p.k) && !seen.has(p.id) && (seen.add(p.id), true))
    .filter((p: any) => p.k !== 'explain' || (typeof p.sid === 'string' && typeof p.title === 'string'))
    .map((p: any): BoardItem => {
      const w = int(p.w, MIN_W, COLS, 6);
      return {
        id: p.id,
        k: p.k,
        x: int(p.x, 0, COLS - w, 0),
        y: int(p.y, 0, 500, 0),
        w,
        h: int(p.h, MIN_H, 100, 6),
        ...(p.k === 'explain' ? { sid: p.sid, title: p.title } : {}),
        ...(int(p.pg, 0, MAX_PAGES - 1, 0) ? { pg: int(p.pg, 0, MAX_PAGES - 1, 0) } : {}),
        ...(p.k === 'spotlight' && typeof p.pin === 'string' && p.pin.length < 200 ? { pin: p.pin } : {}),
      };
    });
  if (!items.length) return DEFAULT_BOARD;
  // each page on its own
  const pages = [...new Set(items.map(pageOf))];
  const done = new Map(pages.flatMap((pg) => compact(items.filter((p) => pageOf(p) === pg)).map((p) => [p.id, p] as const)));
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
