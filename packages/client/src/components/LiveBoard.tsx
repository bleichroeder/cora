import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BOARD_LAYOUTS, BOARD_LAYOUT_INFO, displayPath, type AgentInfo, type BoardLayoutId, type BoardPageMode, type BrainEvent } from '@cora/shared';
import { sessionEvents, useBrain } from '../state/store';
import { derive, fileOf, type AgentView } from '../scene/derive';
import { latestByTitle, versionsOf } from '../lib/explainVersions';
import { deriveTasks, taskProgress } from '../lib/tasks';
import {
  COLS,
  MAX_PAGES,
  PANEL_GROUPS,
  PANELS,
  ROWS,
  addLayoutPage,
  shellsOf,
  duplicatePage,
  moveName,
  movePage,
  movedTo,
  addPanel,
  asLayout,
  LAYOUTS,
  namesWithout,
  bottom,
  dropEdge,
  dropOn,
  merge,
  crossings,
  moveMeet,
  lineAt,
  lines,
  moveLine,
  keepBoards,
  normalize,
  pageCount,
  PANEL_ICON,
  popExplain,
  removePage,
  removePanel,
  sendToPage,
  template,
  visible,
  type BoardItem,
  type Line,
  type Meet,
  type SavedLayout,
  type SessionBoard,
} from '../lib/boardLayout';
import { fitGrid } from '../lib/fitGrid';
import { dropLabel, dropTarget } from '../lib/boardDrag';
import { liveKey, loadLiveData, useLiveData } from '../state/liveExplains';
import { explainShim, themeVars } from '../lib/explainShim';
import { fetchToolDetail } from '../state/ws';
import { Markdown } from './Markdown';
import { openChanges } from '../lib/changes';
import { maskSecrets } from '../lib/mask';
import { explainFrom, looksLikeHtmlDoc, sandboxedHtml, type Explain } from './Viewer';
import { Icon } from './Icon';
import { MorePanel } from './board/panels';
import { BoardTerminal } from './board/ToolPanels';
import { BoardBar, type BoardNote } from './board/BoardBar';
import { openSettings } from './SettingsModal';
import { closeShell } from '../state/shells';
import { SpotlightPanel } from './board/Spotlight';
import type { Spot } from '../lib/spotlight';
import type { PanelKind } from '../lib/boardLayout';
import './liveBoard.css';

/** How far back "Touching" looks, and how many of each it lists. */
const TOUCH_MS = 10 * 60_000;
const TOUCH_SHOWN = 6;
/** The calls bar: this many buckets over the last two minutes. */
const SPARK = 10;
const SPARK_MS = 120_000;
/** The board: the gap between panels, the least a row is tall, and below this width one column of panels. */
const GAP = 12;
const MIN_ROW = 17;
/** A Board shell this new isn't ended for having no panel (its panel is still saving it). */
const SHELL_GRACE_MS = 20_000;
const NARROW = 560;
/** An explain's preview: a page drawn this wide, then scaled down to the card. */
const PREVIEW_W = 1200;

type Touch = {
  key: string;
  label: string;
  agents: string[];
  ts: number;
  note: string;
  path?: string;
  changed?: boolean;
  live?: boolean;
  failed?: boolean;
};

const ago = (ms: number) =>
  ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`;
const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(ms < 60_000 ? 1 : 0)}s`;
const clock = (ts: number) =>
  new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** What the board's panels show for a session, kept current: the scene's derived view, plus per agent what's in flight. */
function useBoardData(sessionId: string) {
  const version = useBrain((s) => s.versions[sessionId]);
  const allAgents = useBrain((s) => s.agents);
  const model = useBrain((s) => s.sessions[sessionId]?.model);
  const cwd = useBrain((s) => s.sessions[sessionId]?.cwd);
  const slots = useRef(new Map<string, number>());
  // the timers tick
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => void slots.current.clear(), [sessionId]);

  const agents = useMemo(() => {
    const list = Object.values(allAgents).filter((a) => a.sessionId === sessionId);
    if (!list.some((a) => a.agentId === 'main'))
      list.push({
        sessionId,
        agentId: 'main',
        parentAgentId: null,
        parentToolUseId: null,
        label: 'main',
        agentType: 'main',
        colorIdx: -1,
        startedAt: 0,
        endedAt: null,
        state: 'idle',
      } satisfies AgentInfo);
    return list;
  }, [allAgents, sessionId]);
  const events = sessionEvents(sessionId);
  const tick = Math.floor(now / 5000);
  const d = useMemo(() => {
    const r = derive(events, agents, slots.current, now, model);
    slots.current = r.slots;
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, agents, model, tick]);

  // per agent: its call in flight, its calls over the last two minutes, the files it touched, its report, and whether it
  // runs in the background (its Agent call returned at once)
  const per = useMemo(() => {
    const open = new Map<string, Map<string, BrainEvent>>();
    const spark = new Map<string, number[]>();
    const files = new Map<string, Set<string>>();
    const report = new Map<string, string>();
    const spawnEnd = new Map<string, number>();
    for (const e of events) {
      if (e.kind === 'report' && e.text) report.set(e.agentId, e.text);
      if (e.kind !== 'tool' || !e.toolUseId) continue;
      if ((e.tool?.name === 'Agent' || e.tool?.name === 'Task') && e.phase === 'end') spawnEnd.set(e.toolUseId, e.ts);
      const m = open.get(e.agentId) ?? new Map<string, BrainEvent>();
      open.set(e.agentId, m);
      if (e.phase === 'start') {
        m.set(e.toolUseId, e);
        const ago = now - e.ts;
        if (ago < SPARK_MS) {
          const b = spark.get(e.agentId) ?? new Array(SPARK).fill(0);
          b[Math.min(SPARK - 1, Math.max(0, SPARK - 1 - Math.floor((ago / SPARK_MS) * SPARK)))]++;
          spark.set(e.agentId, b);
        }
        const f = fileOf(e);
        if (f) (files.get(e.agentId) ?? files.set(e.agentId, new Set()).get(e.agentId)!).add(f.path);
      } else m.delete(e.toolUseId);
    }
    return { open, spark, files, report, spawnEnd };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, tick]);

  // helpers under the agent that started them
  const rows = useMemo(() => {
    const kids = new Map<string, AgentView[]>();
    for (const a of d.agents) if (!a.isMain) (kids.get(a.parentId) ?? kids.set(a.parentId, []).get(a.parentId)!).push(a);
    const out: Array<{ a: AgentView; depth: number }> = [];
    const walk = (a: AgentView, depth: number) => {
      out.push({ a, depth });
      for (const k of kids.get(a.a.agentId) ?? []) walk(k, depth + 1);
    };
    const main = d.agents.find((a) => a.isMain);
    if (main) walk(main, 0);
    for (const a of d.agents) if (!out.some((r) => r.a === a)) out.push({ a, depth: 1 });
    return out;
  }, [d]);

  const touching = useMemo(() => touchedBy(events, now, cwd), [version, cwd, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  // each explain's newest version (newest first), with how many versions, when it was first written and by whom
  const explains = useMemo(() => {
    const all = d.explains.flatMap((x) => {
      const p = explainFrom(x.event);
      return p ? [{ ...p, ts: x.ts, agentId: x.event.agentId }] : [];
    });
    return latestByTitle(all)
      .reverse()
      .map((x) => {
        const vs = versionsOf(all, x);
        return { ...x, versions: vs.length, first: vs[0]?.ts ?? x.ts };
      });
  }, [d.explains]);
  const tasks = useMemo(() => deriveTasks(events), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const color = Object.fromEntries(d.agents.map((a) => [a.a.agentId, a.color]));
  const name = Object.fromEntries(d.agents.map((a) => [a.a.agentId, a.name]));
  return { d, per, rows, touching, explains, tasks, color, name, now };
}
export type BoardData = ReturnType<typeof useBoardData>;
type BoardExplain = BoardData['explains'][number];

/**
 * A move or resize in progress. Moving, the board stays still (what you see is what you're over): the panel dims, a
 * chip with its name follows the pointer, and an outline shows where it would land. Resizing, the panels take their
 * snapped sizes as you go, and an edge that can't go further says so.
 */
type Act = {
  /** moving: the panel; a line: the panel it's moved by */
  id: string;
  /** a panel, a line between panels, or where two lines meet */
  mode: 'move' | 'line' | 'cross';
  /** the line (or the two) being dragged */
  line?: Line;
  cross?: Meet;
  /** what the board shows meanwhile (moving: as it is) */
  preview: BoardItem[];
  /** what letting go does */
  result: BoardItem[];
  /** moving: where the pointer is (the chip), and where it would land and what that does */
  at?: { x: number; y: number };
  land?: { px: { left: number; top: number; width: number; height: number }; label: string; swap?: boolean; edge?: boolean };
  /** over a page's tab: it goes to that page */
  toPage?: number;
  /** a line: it can't go further that way */
  stuck?: boolean;
  /** one column (a narrow board): the panel it would swap with */
  over?: string;
};

/**
 * The scene area with 3D off (Settings › Scene): a board of panels on a grid that snaps, like a dashboard. 24 columns
 * and 24 rows as shares of the area, so it keeps its shape as the window (or the viewer beside it) changes size; under
 * 560 px wide the panels stack in one column. The panels always fill the area. Drag a panel by its header onto another
 * (its middle swaps them, near an edge it takes that half), or onto the board's own edge to run the full width or
 * height there; drag any line between panels like a split bar, or where two
 * meet to move both; ⤢ to fill the area (Esc to come back). Panels: Agents, Touching, Explains, Tasks, and any explain popped out (live
 * ones keep updating). Each session has its own board, kept as you left it.
 */
export function LiveBoard({ sessionId }: { sessionId: string }) {
  // this session's own board (none yet: the layout new sessions start with)
  const mine = useBrain((s) => s.prefs.boards?.[sessionId]);
  const firstLayout = useBrain((s) => s.prefs.board);
  const all = useMemo(() => (mine ? normalize(mine.items) : template(firstLayout)), [mine, firstLayout]);
  const pages = pageCount(all, mine?.pages ?? 1);
  const pg = Math.min(mine?.page ?? 0, pages - 1);
  const items = useMemo(() => visible(all, sessionId, pg), [all, sessionId, pg]);
  const setPrefs = useBrain.getState().setPrefs;
  // every change builds on the board as it is now, never on what a render saw (a late one, a terminal coming up or a
  // drag finishing, would otherwise put back an older board, and the page it was on)
  const latest = () => {
    const s = useBrain.getState();
    const b = s.prefs.boards?.[sessionId];
    const a = b ? normalize(b.items) : template(s.prefs.board);
    const n = pageCount(a, b?.pages ?? 1);
    return { b, all: a, pages: n, page: Math.min(b?.page ?? 0, n - 1) };
  };
  const setBoard = (next: Partial<SessionBoard>) => {
    const s = useBrain.getState();
    const now = latest();
    const board = { items: now.all, pages: now.pages, page: now.page, ...(now.b?.names ? { names: now.b.names } : {}), ...(now.b?.done ? { done: now.b.done } : {}), ...next };
    setPrefs({ boards: keepBoards(s.prefs.boards, sessionId, board, (id) => !!s.sessions[id]) });
  };
  // a page's panels as they now are (`page`: the page they're on, the one showing unless said)
  const save = (next: BoardItem[], page = pg) => setBoard({ items: merge(latest().all, sessionId, next, page) });
  // one panel's own settings (a terminal's tabs, the Spotlight's pin), on whichever page it is
  const patch = (id: string, p: Partial<BoardItem>) => setBoard({ items: latest().all.map((o) => (o.id === id ? { ...o, ...p } : o)) });
  const goTo = (n: number) => (setMaxed(null), setBoard({ page: n }));
  const data = useBoardData(sessionId);
  const [maxed, setMaxed] = useState<string | null>(null);
  useEffect(() => setMaxed(null), [sessionId]);
  const [menu, setMenu] = useState(false);
  const [act, setAct] = useState<Act | null>(null);
  // the drag in progress (its way to stop): a page or session change stops it, nothing kept
  const dragging = useRef<((keep: boolean) => void) | null>(null);
  useEffect(() => () => dragging.current?.(false), [pg, sessionId]);
  // something the board did that you'd want to know (a panel sent to a page, a page a session added): said in its bar
  // for a few seconds, with the way there (or back)
  const [note, setNote] = useState<BoardNote | null>(null);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), note.undo ? 10_000 : 6000);
    return () => clearTimeout(t);
  }, [note]);
  // what Undo puts back (the Board as it was before a page went, a reset, a page a session added)
  const undoTo = useRef<SessionBoard | null>(null);
  const snapshot = (): SessionBoard => ({ items: all, pages, page: pg, ...(mine?.names ? { names: mine.names } : {}) });
  const names = mine?.names ?? [];
  const named = (page: number, name: string | null) => Object.assign(Array.from({ length: Math.max(names.length, page + 1) }, (_, i) => names[i] ?? null), { [page]: name });
  // a page laid out for a kind of work (or one of yours): after the last one, and shown
  const addLayout = (layout: Parameters<typeof addLayoutPage>[2], name: string) => {
    const r = addLayoutPage(all, pages, layout);
    if (!r) return setNote({ text: `The board has ${MAX_PAGES} pages, the most it can`, icon: 'Info', at: Date.now() });
    setMaxed(null);
    setBoard({ items: r.items, pages: r.page + 1, page: r.page, names: named(r.page, name) });
  };
  const saved = useBrain((s) => s.prefs.layouts) ?? [];

  // a session's ask (its board tool): a page laid out for what it's doing now, once per ask; one already made for that
  // work is gone back to instead. How far it goes is yours (Settings › Sessions › Board): off, add it, or add and show it.
  const mode = useBoardPageMode();
  const version = useBrain((s) => s.versions[sessionId]);
  const ask = useMemo(() => latestBoardAsk(sessionId), [sessionId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ask || !mode || mode === 'off') return;
    const done = mine?.done ?? [];
    if (done.includes(ask.id)) return;
    const marked = [...done, ask.id].slice(-50);
    // asked long ago (an old session opened again): noted, not acted on
    if (Date.now() - ask.ts > ASK_FRESH_MS) return setBoard({ done: marked });
    const name = BOARD_LAYOUT_INFO[ask.layout].name;
    const at = names.indexOf(name);
    if (at >= 0 && at < pages) {
      if (mode === 'show' && at !== pg) {
        setMaxed(null);
        setBoard({ done: marked, page: at });
        setNote({ text: `Claude went to the ${name} page`, icon: BOARD_LAYOUT_INFO[ask.layout].icon, go: pg, at: Date.now() });
      } else setBoard({ done: marked });
      return;
    }
    const r = addLayoutPage(all, pages, LAYOUTS[ask.layout]);
    if (!r) return setBoard({ done: marked });
    if (mode === 'show') setMaxed(null);
    undoTo.current = snapshot();
    setBoard({ items: r.items, pages: r.page + 1, page: mode === 'show' ? r.page : pg, names: named(r.page, name), done: marked });
    setNote(mode === 'show' ? { text: `Claude added a ${name} page`, icon: BOARD_LAYOUT_INFO[ask.layout].icon, undo: true, at: Date.now() } : { text: `Claude added a ${name} page`, icon: BOARD_LAYOUT_INFO[ask.layout].icon, go: r.page, at: Date.now() });
  }, [ask?.id, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const grid = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = size.w > 0 && size.w < NARROW;
  // a cell, gap included: the panels' outer edges meet the area's
  const colW = (size.w + GAP) / COLS;
  const rowH = Math.max(MIN_ROW, (size.h + GAP) / ROWS);
  const rect = (i: BoardItem) => ({
    left: i.x * colW,
    top: i.y * rowH,
    width: i.w * colW - GAP,
    height: i.h * rowH - GAP,
  });

  const maxedPanel = maxed ? items.find((p) => p.id === maxed) : undefined;
  // a panel fills the board: Esc brings the board back
  useEffect(() => {
    if (!maxed) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && setMaxed(null);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [maxed]);
  const pop = (title: string) => save(popExplain(items, sessionId, title));
  // the Board's own shells no panel holds any more (a page removed, the board reset): ended
  // (one just opened isn't held yet: its panel saves it a moment later, so a shell gets a while before it counts)
  const boardShells = useBrain((s) => s.shells.filter((t) => t.sessionId === sessionId && t.place === 'board' && t.alive && Date.now() - t.startedAt > SHELL_GRACE_MS).map((t) => t.terminalId).join(','));
  const ready = useBrain((s) => s.ready);
  useEffect(() => {
    if (!ready || !boardShells) return;
    const held = new Set(all.flatMap(shellsOf));
    for (const id of boardShells.split(',')) if (!held.has(id)) void closeShell(id);
  }, [all, boardShells, ready]);
  // this session's explains that have a panel, and on which page
  const onPage = new Set(items.filter((i) => i.k !== 'spotlight').map((i) => i.k as string));
  const popped = new Map(all.filter((p) => p.k === 'explain' && p.sid === sessionId).map((p) => [p.title!, p.pg ?? 0]));
  const nameOf = (i: BoardItem) => (i.k === 'explain' ? i.title! : PANELS[i.k].name);

  // move a panel (from its header), or drag a line between panels (or where two meet)
  const start = (e: React.PointerEvent, it: BoardItem, mode: Act['mode'], drag?: { line?: Line; cross?: Meet }) => {
    if (e.button !== 0 || (narrow && mode !== 'move') || (mode === 'move' && (e.target as HTMLElement).closest('button'))) return;
    e.preventDefault(); // no text selected on the way
    // one drag at a time (one left over from before goes, unkept)
    dragging.current?.(false);
    const page = pg;
    const el = e.currentTarget as HTMLElement;
    // the pointer is the board's until it's let go, whatever it passes over (a page, a terminal, an explain)
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer already went */
    }
    const x0 = e.clientX;
    const y0 = e.clientY;
    let cur: Act | null = null;
    let key = '';
    let shield: HTMLDivElement | null = null;
    const move = (ev: PointerEvent) => {
      // let go somewhere we didn't hear about (another window, a page that kept the mouse): it ends there
      if (cur && (ev.buttons & 1) === 0) return end(true);
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!cur && Math.hypot(dx, dy) < 4) return;
      if (!cur) {
        document.body.classList.add('ui-dragging');
        // over everything: nothing underneath (an explain's page, a terminal) takes the pointer meanwhile
        shield = document.createElement('div');
        shield.className = `bd-shield ${mode === 'line' ? drag!.line!.axis : mode}`;
        document.body.append(shield);
      }
      if (mode === 'move') {
        const at = { x: ev.clientX, y: ev.clientY };
        // over another page's tab: it goes there
        const tab = [...document.querySelectorAll<HTMLElement>('.live-board .bd-pg[data-pg]')].find((t) => {
          const b = t.getBoundingClientRect();
          return ev.clientX >= b.left && ev.clientX <= b.right && ev.clientY >= b.top && ev.clientY <= b.bottom;
        });
        const toPage = tab && Number(tab.dataset.pg) !== pg ? Number(tab.dataset.pg) : undefined;
        if (toPage != null) {
          key = `page${toPage}`;
          cur = { id: it.id, mode, preview: items, result: items, at, toPage };
          return setAct(cur);
        }
        // one column (a narrow board): the panel under the pointer swaps places with it
        if (narrow) {
          const over = [...(grid.current?.querySelectorAll<HTMLElement>('.bd-cell.stacked[data-id]') ?? [])].find((c) => {
            const b = c.getBoundingClientRect();
            return c.dataset.id !== it.id && ev.clientY >= b.top && ev.clientY <= b.bottom;
          })?.dataset.id;
          cur = { id: it.id, mode, preview: items, result: over ? dropOn(items, it.id, over, 'swap') : items, at, over };
          return setAct(cur);
        }
        const box = grid.current?.querySelector('.bd-canvas')?.getBoundingClientRect();
        const bx = box ? ev.clientX - box.left : 0;
        const by = box ? ev.clientY - box.top : 0;
        const on = box ? dropTarget(items, it.id, bx, by, rect, GAP, { width: box.width, height: box.height }) : null;
        // over a panel: the board stays still, the outline shows where it lands (off the panels: nothing happens)
        const k = on ? `${on.id}:${on.how}` : 'none';
        if (k !== key || !cur) {
          key = k;
          if (on?.edge && on.how !== 'swap') {
            const result = dropEdge(items, it.id, on.how);
            cur = { id: it.id, mode, preview: items, result, at, land: { px: rect(result.find((o) => o.id === it.id)!), label: dropLabel(on.how, '', false, true), edge: true } };
          } else if (on) {
            const result = dropOn(items, it.id, on.id, on.how);
            const t = items.find((o) => o.id === on.id)!;
            const landed = result.find((o) => o.id === it.id)!;
            cur = { id: it.id, mode, preview: items, result, at, land: { px: rect(landed), label: dropLabel(on.how, nameOf(t), on.fallback), swap: on.how === 'swap' } };
          } else cur = { id: it.id, mode, preview: items, result: items, at };
        } else cur = { ...cur, at };
        return setAct(cur);
      }
      // a line (or two): snapped to the grid as it goes; where it's asked to go and where it can differ: it's stuck
      const box = grid.current?.querySelector('.bd-canvas')?.getBoundingClientRect();
      if (!box) return;
      const wantX = Math.round((ev.clientX - box.left + GAP / 2) / colW);
      const wantY = Math.round((ev.clientY - box.top + GAP / 2) / rowH);
      const k = mode === 'line' ? String(drag!.line!.axis === 'x' ? wantX : wantY) : `${wantX},${wantY}`;
      if (k === key && cur) return;
      key = k;
      let result = items;
      let stuck = false;
      if (mode === 'line') {
        const l = drag!.line!;
        const want = l.axis === 'x' ? wantX : wantY;
        result = moveLine(items, l, want);
        stuck = lineAt(result, l) !== want;
      } else {
        const m = drag!.cross!;
        result = moveMeet(items, m, wantX, wantY);
        stuck = m.vs.some((v) => lineAt(result, v) !== wantX) || m.hs.some((h) => lineAt(result, h) !== wantY);
      }
      cur = { id: it.id, mode, ...drag, preview: result, result, stuck };
      setAct(cur);
    };
    const end = (keep: boolean) => {
      if (dragging.current === end) dragging.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', esc, true);
      el.removeEventListener('lostpointercapture', lost);
      document.body.classList.remove('ui-dragging');
      shield?.remove();
      const done = cur;
      cur = null;
      if (done && keep && done.toPage != null) {
        const now = latest();
        setBoard({ items: sendToPage(now.all, sessionId, done.id, page, done.toPage), pages: Math.max(now.pages, done.toPage + 1) });
        setNote({ text: `${nameOf(it)} is on page ${done.toPage + 1}`, icon: 'CornerDownRight', go: done.toPage, at: Date.now() });
      }
      else if (done && keep) save(done.result, page);
      setAct(null);
    };
    dragging.current = end;
    const up = () => end(true);
    const cancel = () => end(false);
    // capture taken away (the panel went, the window lost the mouse): what was showing is kept
    const lost = () => {
      if (cur) end(true);
    };
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', esc, true);
    el.addEventListener('lostpointercapture', lost);
  };

  const shown = act?.preview ?? items;
  // taller than the area only when panels go below it (rows have a least height): only then does the board scroll
  const tall = bottom(shown) * rowH - GAP > size.h + 1;
  const height = tall ? bottom(shown) * rowH - GAP : size.h;
  const lifted = act ? items.find((i) => i.id === act.id) : undefined;
  // the lines to drag, where they are now (following a drag as it goes)
  const bars = useMemo(() => once(lines(shown), (l) => `${l.axis}:${l.id}:${l.from}`), [shown]);
  const meets = useMemo(() => once(crossings(bars), (c) => `${c.vs[0].id}:${c.hs[0].id}`), [bars]);
  const panel = (p: BoardItem, isMax = false) => (
    <BoardPanelView
      p={p}
      data={data}
      sessionId={sessionId}
      max={isMax}
      popped={popped}
      page={pg}
      onPage={onPage}
      onUpdate={(next) => patch(next.id, { pin: next.pin, term: next.term, terms: next.terms })}
      onGo={goTo}
      onPop={pop}
      onMax={() => setMaxed(isMax ? null : p.id)}
      onClose={() => {
        setMaxed(null);
        save(removePanel(items, p.id));
        // a Terminal panel's shells end with it
        for (const id of shellsOf(p)) void closeShell(id);
      }}
      onGrab={isMax ? undefined : (e) => start(e, p, 'move')}
    />
  );

  return (
    <div className={`live-board${act ? ` acting ${act.mode === 'move' ? 'moving' : 'sizing'}` : ''}`}>
      <div
        ref={grid}
        className={`bd-grid${narrow ? ' narrow' : ''}${tall ? ' tall' : ''}`}
        style={{
          ['--cw' as string]: `${colW}px`,
          ['--rh' as string]: `${rowH}px`,
        }}
      >
        {size.w && !items.length ? (
          <div className="bd-empty">
            <b>Page {pg + 1} is empty</b>
            <span>Add panels with + Panel, or drag one onto this page's tab.</span>
            {pages > 1 ? (
              <button
                onClick={() => {
                  setBoard({ items: removePage(all, pg), pages: pages - 1, page: Math.max(0, pg - 1), names: namesWithout(mine?.names, pg) });
                }}
              >
                Remove this page
              </button>
            ) : null}
          </div>
        ) : null}
        {!size.w ? null : narrow ? (
          [...items]
            .sort((a, b) => a.y - b.y || a.x - b.x)
            .map((p) => (
              <div key={p.id} data-id={p.id} className={`bd-cell stacked${act?.id === p.id ? ' lifted' : ''}${act?.over === p.id ? ' target' : ''}`} style={{ height: Math.max(180, p.h * 20) }}>
                {p.id === maxed ? <BoardAway name={nameOf(p)} /> : panel(p)}
              </div>
            ))
        ) : (
          <div className="bd-canvas" style={{ height }}>
            {shown.map((p) => {
              const r = rect(p);
              const me = act?.mode === 'move' && act.id === p.id;
              return (
                <div
                  key={p.id}
                  className={`bd-cell${me ? ` lifted ${act!.mode}` : ''}`}
                  style={{
                    transform: `translate(${r.left}px, ${r.top}px)`,
                    width: r.width,
                    height: r.height,
                  }}
                >
                  {/* filling the board: shown there alone (two of a terminal or a browser would fight) */}
                  {p.id === maxed ? <BoardAway name={nameOf(p)} /> : panel(p)}
                </div>
              );
            })}
            {/* the lines between panels, in the gaps: each drags like a split bar; where two meet, both move */}
            {act?.mode === 'move'
              ? null
              : bars.map((l) => {
                  const on = !!act && (act.line ? sameLine(act.preview, act.line, l) : !!act.cross && [...act.cross.vs, ...act.cross.hs].some((d) => sameLine(act.preview, d, l)));
                  const style =
                    l.axis === 'x'
                      ? { left: l.at * colW - GAP - 3, top: l.from * rowH, width: GAP + 6, height: (l.to - l.from) * rowH - GAP }
                      : { left: l.from * colW, top: l.at * rowH - GAP - 3, width: (l.to - l.from) * colW - GAP, height: GAP + 6 };
                  return (
                    <div
                      key={`${l.axis}:${l.id}:${l.from}`}
                      className={`bd-bar ${l.axis}${on ? ' on' : ''}${on && act?.stuck ? ' stuck' : ''}`}
                      style={style}
                      title="Drag to resize the panels on both sides"
                      onPointerDown={(e) => start(e, items.find((i) => i.id === l.id)!, 'line', { line: l })}
                    >
                      <i />
                    </div>
                  );
                })}
            {act?.mode === 'move'
              ? null
              : meets.map((c) => (
                  <div
                    key={`${c.vs[0].id}:${c.hs[0].id}`}
                    className={`bd-meet${act?.cross && act.cross.vs.some((v) => c.vs.some((w) => sameLine(act.preview, v, w))) && act.cross.hs.some((h) => c.hs.some((w) => sameLine(act.preview, h, w))) ? ` on${act.stuck ? ' stuck' : ''}` : ''}`}
                    style={{ left: c.x * colW - GAP / 2 - 9, top: c.y * rowH - GAP / 2 - 9 }}
                    title="Drag to move both lines"
                    onPointerDown={(e) => start(e, items.find((i) => i.id === c.vs[0].id)!, 'cross', { cross: c })}
                  />
                ))}
            {act?.land ? (
              <div className={`bd-land${act.land.swap ? ' swap' : ''}${act.land.edge ? ' edge' : ''}`} style={{ transform: `translate(${act.land.px.left}px, ${act.land.px.top}px)`, width: act.land.px.width, height: act.land.px.height }}>
                <span>{act.land.label}</span>
              </div>
            ) : null}
          </div>
        )}
      </div>
      {act?.mode === 'move' && act.at && lifted ? (
        <div className="bd-chip" style={{ transform: `translate(${act.at.x + 14}px, ${act.at.y + 12}px)` }}>
          <Icon name={lifted.k === 'explain' ? 'FileText' : PANEL_ICON[lifted.k]} size={13} />
          <b>{nameOf(lifted)}</b>
          {act.toPage != null ? <em>to page {act.toPage + 1}</em> : null}
        </div>
      ) : null}
      {maxedPanel ? <div className="bd-max">{panel(maxedPanel, true)}</div> : null}
      <BoardBar
        pages={pages}
        pg={pg}
        names={names}
        moving={act?.mode === 'move'}
        dropPage={act?.toPage}
        note={note}
        onNote={() => {
          if (!note) return;
          setNote(null);
          if (note.undo && undoTo.current) setBoard({ ...undoTo.current, done: mine?.done });
          else if (note.go != null) goTo(note.go);
        }}
        saved={saved}
        onGo={goTo}
        onRename={(n, name) => setBoard({ names: named(n, name) })}
        onNewPage={(layout) => (layout ? addLayout(layout.items, layout.name) : (setMaxed(null), setBoard({ pages: pages + 1, page: pages })))}
        onSaveLayout={(n, name) => {
          const next: SavedLayout = { id: `layout:${Date.now().toString(36)}`, name, items: asLayout(visible(all, sessionId, n)).map((p, i) => ({ ...p, id: `${p.k}:${i}` })) };
          setPrefs({ layouts: [...saved.filter((l) => l.name.toLowerCase() !== name.toLowerCase()), next] });
          // the page goes by that name too
          setBoard({ names: named(n, name) });
          setNote({ text: `Saved "${name}" as a layout`, icon: 'Bookmark', at: Date.now() });
        }}
        onDeleteLayout={(id) => setPrefs({ layouts: saved.filter((l) => l.id !== id) })}
        onDuplicate={(n) => {
          const r = duplicatePage(all, sessionId, n, pages);
          if (r) setBoard({ items: r.items, pages: r.page + 1, page: r.page, names: named(r.page, names[n] ? `${names[n]} copy` : null) });
        }}
        onMove={(from, to) => setBoard({ items: movePage(all, from, to), names: moveName(names, from, to), page: movedTo(pg, from, to) })}
        onRemove={(n) => {
          undoTo.current = snapshot();
          setMaxed(null);
          setBoard({ items: removePage(all, n), pages: pages - 1, page: pg > n ? pg - 1 : Math.min(pg, pages - 2), names: namesWithout(mine?.names, n) });
          setNote({ text: `Removed ${names[n] || `page ${n + 1}`}`, icon: 'Trash2', undo: true, at: Date.now() });
        }}
        onTemplate={() => (setPrefs({ board: template(items) }), setNote({ text: 'New sessions start with this page', icon: 'LayoutTemplate', at: Date.now() }))}
        onReset={() => {
          undoTo.current = snapshot();
          setMaxed(null);
          setBoard({ items: template(firstLayout), pages: 1, page: 0, names: [] });
          setNote({ text: 'The Board is back to its start', icon: 'RotateCcw', undo: true, at: Date.now() });
        }}
        onSettings={() => openSettings('sessions')}
        panel={
          <span className="bd-tabw">
            <button className={`bd-tb${menu ? ' on' : ''}`} title="Add a panel" onClick={() => setMenu(!menu)}>
              <Icon name="LayoutGrid" size={13} /> Panel
            </button>
            {menu ? <AddMenu items={items} explains={data.explains} onPick={(next) => (save(next), setMenu(false))} onPop={(title) => (pop(title), setMenu(false))} onClose={() => setMenu(false)} /> : null}
          </span>
        }
      />
    </div>
  );
}

/** Each group's tint in the + Panel menu. */
const GROUP_TINT: Record<string, string> = { 'This session': 'var(--cora)', Code: '#a78bfa', Delivery: '#fb923c', 'Around you': '#38bdf8', Tools: '#34d399' };

/** + Panel: the panels not on this page, and this session's explains to pop out. */
function AddMenu({
  items,
  explains,
  onPick,
  onPop,
  onClose,
}: {
  items: BoardItem[];
  explains: BoardExplain[];
  onPick(next: BoardItem[]): void;
  onPop(title: string): void;
  onClose(): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => !box.current?.parentElement?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [onClose]);
  const [q, setQ] = useState('');
  const words = q.trim().toLowerCase();
  const fits = (k: Exclude<PanelKind, 'explain'>) => !words || `${PANELS[k].name} ${PANELS[k].hint} ${PANELS[k].group}`.toLowerCase().includes(words);
  const list = explains.filter((x) => !words || x.title.toLowerCase().includes(words));
  return (
    <div className="bd-menu wide" ref={box} role="menu">
      <label className="bd-mq">
        <Icon name="Search" size={13} />
        <input autoFocus value={q} placeholder="Find a panel" onChange={(e) => setQ(e.target.value)} />
      </label>
      <div className="bd-mbody">
        {PANEL_GROUPS.map((g) => {
          const ks = (Object.keys(PANELS) as Array<Exclude<PanelKind, 'explain'>>).filter((k) => PANELS[k].group === g && fits(k));
          if (!ks.length) return null;
          return (
            <Fragment key={g}>
              <div className="mh">{g}</div>
              <div className="bd-mgrid" style={{ ['--gt' as never]: GROUP_TINT[g] }}>
                {ks.map((k) => {
                  const on = items.some((p) => p.k === k);
                  return (
                    <button key={k} className="bd-mt" disabled={on} onClick={() => onPick(addPanel(items, k))}>
                      <span className="ic">
                        <Icon name={PANEL_ICON[k]} size={15} />
                      </span>
                      <span className="tx">
                        <b>
                          {PANELS[k].name}
                          {on ? <em>On the board</em> : null}
                        </b>
                        <span>{PANELS[k].hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </Fragment>
          );
        })}
        {list.length ? <div className="mh">Explains · pop one out</div> : null}
        {list.map((x) => {
          const on = items.some((p) => p.k === 'explain' && p.title === x.title);
          return (
            <button key={x.title} className="bd-mx" disabled={on} onClick={() => onPop(x.title)}>
              <Icon name={x.format === 'html' ? 'Monitor' : 'FileText'} size={13} />
              <span className="t">{x.title}</span>
              <span className="d">{on ? 'on the board' : x.format === 'html' ? 'page' : 'document'}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A session's ask this old (an old session opened again) is noted, not acted on. */
const ASK_FRESH_MS = 12 * 3600_000;

/** The session's latest ask for a page laid out for its work (its board tool), if any. */
function latestBoardAsk(sessionId: string): { id: string; layout: BoardLayoutId; ts: number } | null {
  let out: { id: string; layout: BoardLayoutId; ts: number } | null = null;
  for (const e of sessionEvents(sessionId)) {
    if (e.kind !== 'tool' || e.phase !== 'start' || !e.tool || !/__board$/.test(e.tool.name)) continue;
    const l = (e.tool.input as { layout?: unknown } | undefined)?.layout;
    if ((BOARD_LAYOUTS as readonly unknown[]).includes(l)) out = { id: e.toolUseId ?? `${e.ts}`, layout: l as BoardLayoutId, ts: e.ts };
  }
  return out;
}

/** How far sessions may go with the Board (Settings › Sessions › Board), read when the board shows. */
function useBoardPageMode(): BoardPageMode | null {
  const [mode, setMode] = useState<BoardPageMode | null>(null);
  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { board?: { pages?: BoardPageMode } } | null) => setMode(j?.board?.pages ?? 'show'))
      .catch(() => setMode(null));
  }, []);
  return mode;
}

/** Each once by its key: two handles with one key would leave one behind on screen (a stray dot from another page). */
function once<T>(list: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((t) => !seen.has(key(t)) && (seen.add(key(t)), true));
}

/** Whether a line on the board (`l`, from lines() of `items`) is the one being dragged (`drag`, as it started). */
function sameLine(items: BoardItem[], drag: Line, l: Line): boolean {
  return l.axis === drag.axis && l.at === lineAt(items, drag) && l.from < drag.to && drag.from < l.to;
}

/** A panel filling the board: its place here, said so (Esc or the button brings it back). */
function BoardAway({ name }: { name: string }) {
  return (
    <section className="bd-pn bd-away">
      <span>{name} fills the board</span>
      <em>Esc to bring it back</em>
    </section>
  );
}

/** One panel: its header (drag it, ⤢, ×) and what it shows. */
function BoardPanelView({
  p,
  data,
  sessionId,
  max,
  popped,
  page,
  onPage,
  onUpdate,
  onGo,
  onPop,
  onMax,
  onClose,
  onGrab,
}: {
  p: BoardItem;
  data: BoardData;
  sessionId: string;
  max: boolean;
  popped: Map<string, number>;
  page: number;
  /** the other panels on the page (the Spotlight never repeats one) */
  onPage: Set<string>;
  onUpdate(p: BoardItem): void;
  onGo(n: number): void;
  onPop(title: string): void;
  onMax(): void;
  onClose(): void;
  onGrab?(e: React.PointerEvent): void;
}) {
  const name = p.k === 'explain' ? p.title! : PANELS[p.k].name;
  const live = p.k === 'explain' ? data.explains.find((x) => x.title === p.title)?.live : undefined;
  const count =
    p.k === 'agents'
      ? `${data.d.agents.filter((a) => !a.diedAt && a.a.state !== 'done').length} live`
      : p.k === 'explains'
        ? String(data.explains.length)
        : p.k === 'tasks' && data.tasks.length
          ? `${taskProgress(data.tasks).done}/${data.tasks.length}`
          : '';
  return (
    <section className="bd-pn" data-id={p.id}>
      <div
        className={`bd-ph${onGrab ? ' grab' : ''}`}
        onPointerDown={onGrab}
        onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && onMax()}
        title={onGrab ? 'Drag to move · double-click to fill the area' : undefined}
      >
        {onGrab ? <Icon name="GripVertical" size={12} className="g" /> : null}
        <span className="nm">{name}</span>
        {live ? <span className="live" title="live" /> : null}
        {count ? <span className="n">{count}</span> : null}
        <span className="sp" />
        {p.k === 'explain' ? (
          <button
            className="ib"
            title="Open in the viewer"
            onClick={() => {
              const x = data.explains.find((e) => e.title === p.title);
              if (x) useBrain.getState().setViewer(x);
            }}
          >
            <Icon name="PanelRight" size={13} />
          </button>
        ) : null}
        <button className="ib" title={max ? 'Back to the board' : 'Fill the area'} onClick={onMax}>
          <Icon name={max ? 'Minimize2' : 'Maximize2'} size={12} />
        </button>
        <button className="ib" title="Remove (Panel brings it back)" onClick={onClose}>
          <Icon name="X" size={13} />
        </button>
      </div>
      <div className="bd-pb">
        {p.k === 'agents' ? (
          <AgentsBody data={data} />
        ) : p.k === 'touching' ? (
          <TouchingBody data={data} sessionId={sessionId} />
        ) : p.k === 'explains' ? (
          <ExplainsBody data={data} onPop={onPop} out={popped} page={page} onGo={onGo} />
        ) : p.k === 'tasks' ? (
          <TasksBody data={data} />
        ) : p.k === 'explain' ? (
          <ExplainBody sessionId={sessionId} title={p.title!} />
        ) : p.k === 'terminal' ? (
          <BoardTerminal sessionId={sessionId} item={p} onUpdate={onUpdate} />
        ) : p.k === 'spotlight' ? (
          <SpotlightPanel key={sessionId} sessionId={sessionId} data={data} item={p} onPage={onPage} onPin={(pin) => onUpdate({ ...p, pin })} render={(s) => <SpotBody spot={s} sessionId={sessionId} data={data} />} />
        ) : (
          <MorePanel k={p.k} sessionId={sessionId} data={data} />
        )}
      </div>
    </section>
  );
}

/** What the Spotlight shows: the panel it is, without its header (the Spotlight's own says what and why). */
function SpotBody({ spot, sessionId, data }: { spot: Spot; sessionId: string; data: BoardData }) {
  if (spot.k === 'agents') return <AgentsBody data={data} />;
  if (spot.k === 'touching') return <TouchingBody data={data} sessionId={sessionId} />;
  if (spot.k === 'tasks') return <TasksBody data={data} />;
  if (spot.k === 'explain') return <ExplainBody sessionId={sessionId} title={spot.title ?? ''} />;
  // what Claude is browsing: the session's own browser (the board's Browser panel is a browser of its own)
  return <MorePanel k={spot.k as PanelKind} sessionId={sessionId} data={data} />;
}

function AgentsBody({ data }: { data: BoardData }) {
  const { rows, per, now, d } = data;
  return (
    <>
      {rows.map(({ a, depth }) => (
        <AgentRow
          key={a.a.agentId}
          a={a}
          depth={depth}
          now={now}
          open={per.open.get(a.a.agentId)}
          spark={per.spark.get(a.a.agentId)}
          files={per.files.get(a.a.agentId)?.size ?? 0}
          report={per.report.get(a.a.agentId)}
          background={!!a.a.parentToolUseId && per.spawnEnd.has(a.a.parentToolUseId) && a.a.state !== 'done' && (per.spawnEnd.get(a.a.parentToolUseId) ?? 0) < a.lastActivity - 2000}
        />
      ))}
      {d.overflow ? <div className="lb-more">+{d.overflow} more agents</div> : null}
    </>
  );
}

function TouchingBody({ data, sessionId }: { data: BoardData; sessionId: string }) {
  const { touching, now, color, name } = data;
  const any = touching.Files.length || touching.Web.length || touching.Shell.length || touching.Tools.length;
  if (!any) return <div className="lb-empty">Nothing in the last 10 minutes.</div>;
  return (
    <>
      {(['Files', 'Web', 'Shell', 'Tools'] as const).map((g) =>
        touching[g].length ? (
          <div key={g} className="lb-grp">
            <div className="lb-gh">{g}</div>
            {touching[g].slice(0, TOUCH_SHOWN).map((t) => (
              <div key={t.key} className={`lb-row${now - t.ts < 4000 ? ' hit' : ''}`} title={t.path ?? t.label}>
                <span className="who" title={t.agents.map((id) => name[id] ?? 'an agent that has finished').join(', ')}>
                  {/* each agent's colour once (the last three); ones that have finished, one grey dot */}
                  {[...new Set(t.agents.map((id) => color[id] ?? 'var(--ink4)'))].slice(-3).map((c) => (
                    <i key={c} style={{ background: c }} />
                  ))}
                </span>
                <span className="p">{t.label}</span>
                <span className={`m${t.failed ? ' bad' : t.live ? ' run' : ''}`}>
                  {t.note}
                  {t.changed && t.path ? (
                    <button className="lb-diff" onClick={() => openChanges(sessionId, t.path!)}>
                      diff
                    </button>
                  ) : null}
                </span>
              </div>
            ))}
            {touching[g].length > TOUCH_SHOWN ? <div className="lb-more in">+{touching[g].length - TOUCH_SHOWN} more</div> : null}
          </div>
        ) : null,
      )}
    </>
  );
}

/** The session's explains as cards: a preview of each (drawn when it scrolls into view), who wrote it, when, versions. */
function ExplainsBody({ data, onPop, out, page, onGo }: { data: BoardData; onPop(title: string): void; out: Map<string, number>; page: number; onGo(n: number): void }) {
  const { explains } = data;
  const [q, setQ] = useState('');
  if (!explains.length) return <div className="lb-empty">No explains in this session yet. They show here with a preview as Claude writes them.</div>;
  const words = q.trim().toLowerCase();
  const list = words ? explains.filter((x) => x.title.toLowerCase().includes(words)) : explains;
  return (
    <div className="lb-exs">
      {explains.length > 4 ? (
        <label className="lb-q">
          <Icon name="Search" size={12} />
          <input value={q} placeholder={`Filter ${explains.length} explains`} onChange={(e) => setQ(e.target.value)} />
        </label>
      ) : null}
      <CardGrid n={list.length}>
        {list.map((x) => (
          <ExplainCard key={x.title} x={x} data={data} out={out.get(x.title)} here={page} onGo={onGo} onPop={() => onPop(x.title)} />
        ))}
        {!list.length ? <div className="lb-empty">None called that.</div> : null}
      </CardGrid>
    </div>
  );
}

/** A card: its preview (16 by 10) and its caption (one line of title, one of who and when). */
const CARD = { gap: 10, min: 130, max: 300, aspect: 10 / 16, extra: 53 };

/** The cards, sized to the panel: as big as they can be with all of them showing; it scrolls only when they can't. */
function CardGrid({ n, children }: { n: number; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setSize((cur) => (cur && cur.w === el.clientWidth && cur.h === el.clientHeight ? cur : { w: el.clientWidth, h: el.clientHeight }));
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);
  const cols = size && n ? fitGrid(n, size.w, size.h, CARD) : null;
  return (
    <div className="lb-cards" ref={box} style={cols ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}>
      {children}
    </div>
  );
}

function ExplainCard({ x, data, out, here, onGo, onPop }: { x: BoardExplain; data: BoardData; out?: number; here: number; onGo(n: number): void; onPop(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const seen = useInView(box);
  const open = () => useBrain.getState().setViewer(x);
  const who = data.name[x.agentId] ?? (x.agentId === 'main' ? 'main' : 'a helper');
  const when = x.versions > 1 ? `First written ${clock(x.first)} · this version ${clock(x.ts)} (${x.versions} versions)` : `Written ${clock(x.ts)}`;
  return (
    <div className="lb-card" ref={box}>
      {/* the preview, with what's on it: Live (top left); in the top right, where its own panel is, or Pop out (on hover) */}
      <div className="lb-pv" onClick={open} title="Open in the viewer">
        {seen ? <ExplainPreview x={x} /> : null}
        {x.live ? (
          <span className="lv">
            <i /> Live
          </span>
        ) : null}
        {out === here ? (
          <span className="lb-chip" title="It has a panel of its own on this page">
            <Icon name="Check" size={11} /> On the board
          </span>
        ) : out != null ? (
          <button className="lb-chip" onClick={(e) => (e.stopPropagation(), onGo(out))} title="It has a panel of its own there: go to it">
            Page {out + 1} <Icon name="ArrowRight" size={11} />
          </button>
        ) : (
          <button className="lb-pop" onClick={(e) => (e.stopPropagation(), onPop())} title="Pop it out into a panel of its own" aria-label="Pop out">
            <Icon name="SquareArrowOutUpRight" size={13} />
          </button>
        )}
      </div>
      <div className="meta">
        <button className="t" onClick={open} title={x.title}>
          {x.title}
        </button>
        <div className="sub" title={when}>
          <Icon name={x.format === 'html' ? 'Monitor' : 'FileText'} size={11} className="f" />
          <i style={{ background: data.color[x.agentId] ?? 'var(--ink4)' }} />
          <span className="who">{who}</span>
          <span className="ago">{ago(data.now - x.ts)} ago</span>
          {x.versions > 1 ? <span className="v">v{x.versions}</span> : null}
        </div>
      </div>
    </div>
  );
}

/** Whether an element is on screen (or near it): previews are only drawn then. */
function useInView(ref: React.RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting), {
      rootMargin: '200px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}

/** A small picture of an explain: the page (or the document) drawn wide and scaled down to the card, not clickable. */
function ExplainPreview({ x }: { x: Explain }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const content = useExplainContent(x);
  const html = x.format === 'html' || (content != null && looksLikeHtmlDoc(content));
  // a page as on a wide screen; a document narrower, so its text still reads
  const vw = html ? PREVIEW_W : 560;
  const scale = w / vw;
  return (
    <div className="lb-thumb" ref={box} aria-hidden>
      {content == null || !w ? null : (
        <div
          className="in"
          style={{
            width: vw,
            height: (vw * 10) / 16,
            transform: `scale(${scale})`,
          }}
        >
          {html ? (
            <ExplainFrame x={x} content={content} />
          ) : (
            <div className="lb-doc">
              <Markdown text={content.slice(0, 4000)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** An explain's content: with the event, or fetched from the transcript (older explains kept only a preview). */
function useExplainContent(x: Explain | undefined) {
  const [content, setContent] = useState<string | null>(x?.content ?? null);
  useEffect(() => {
    setContent(x?.content ?? null);
    if (!x || x.content) return;
    let on = true;
    void fetchToolDetail(x.sessionId, x.toolUseId).then((d) => {
      const c = (d?.input as { content?: string } | undefined)?.content;
      if (on && typeof c === 'string') setContent(c);
    });
    return () => void (on = false);
  }, [x?.toolUseId, x?.content]); // eslint-disable-line react-hooks/exhaustive-deps
  return content;
}

/** An HTML explain, as in the viewer: sandboxed, with Cora's colours and, live, its data coming in with no reload. */
function ExplainFrame({ x, content }: { x: Explain; content: string }) {
  const key = x.live ? liveKey(x.sessionId, x.live) : '';
  const liveData = useLiveData((s) => (key ? s[key] : undefined));
  const dataNow = useRef<unknown>(undefined);
  dataNow.current = liveData;
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (x.live) void loadLiveData(x.sessionId, x.live);
  }, [x.sessionId, x.live]);
  useEffect(() => {
    if (x.live && liveData !== undefined) frame.current?.contentWindow?.postMessage({ cora: 'data', data: liveData }, '*');
  }, [liveData, x.live]);
  const page = useMemo(
    () =>
      sandboxedHtml(
        content,
        explainShim({
          vars: themeVars((n) => getComputedStyle(document.documentElement).getPropertyValue(n)),
          live: !!x.live,
          data: dataNow.current,
        }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, x.live],
  );
  // allow-scripts WITHOUT allow-same-origin: an opaque origin with no access to the dashboard, its cookie or its APIs
  return <iframe ref={frame} className="lb-frame" title={x.title} sandbox="allow-scripts" srcDoc={page} />;
}

function TasksBody({ data }: { data: BoardData }) {
  if (!data.tasks.length) return <div className="lb-empty">No task list in this session.</div>;
  const { done } = taskProgress(data.tasks);
  return (
    <ol className="lb-tasks" style={{ ['--done' as string]: `${(100 * done) / data.tasks.length}%` }}>
      {data.tasks.map((t) => (
        <li key={t.id} className={t.status}>
          <Icon name={t.status === 'completed' ? 'CircleCheck' : t.status === 'in_progress' ? 'LoaderCircle' : 'Circle'} size={13} className="i" />
          <span>{t.status === 'in_progress' ? (t.activeForm ?? t.subject) : t.subject}</span>
        </li>
      ))}
    </ol>
  );
}

/** A popped-out explain: its newest version (it follows new ones), as in the viewer. */
function ExplainBody({ sessionId, title }: { sessionId: string; title: string }) {
  const version = useBrain((s) => s.versions[sessionId]);
  const latest = useMemo(() => {
    const all = sessionEvents(sessionId).flatMap((e) => (e.kind === 'tool' && e.phase === 'start' ? (explainFrom(e) ? [{ ...explainFrom(e)!, ts: e.ts }] : []) : []));
    return versionsOf(all, { sessionId, title, ts: 0 }).at(-1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, title, version]);
  const content = useExplainContent(latest);
  if (!latest) return <div className="lb-empty">This explain isn't in this session.</div>;
  if (content == null) return <div className="lb-empty">loading…</div>;
  if (latest.format === 'html' || looksLikeHtmlDoc(content)) return <ExplainFrame x={latest} content={content} />;
  return (
    <div className="lb-doc">
      <Markdown text={content} />
    </div>
  );
}

/** One agent: who, how it is, what it's doing now (and for how long), its last line or report, its calls. */
function AgentRow({ a, depth, now, open, spark, files, report, background }: { a: AgentView; depth: number; now: number; open?: Map<string, BrainEvent>; spark?: number[]; files: number; report?: string; background: boolean }) {
  const done = a.a.state === 'done' || !!a.diedAt;
  const call = open?.size ? [...open.values()].sort((x, y) => y.ts - x.ts)[0] : undefined;
  const state = done ? 'done' : call ? 'working' : a.thinking ? 'thinking' : a.a.state === 'idle' ? 'idle' : 'working';
  const bars = spark ?? new Array(SPARK).fill(0);
  const max = Math.max(1, ...bars);
  return (
    <div className={`lb-ag ${state}`} style={{ ['--ac' as string]: a.color, paddingLeft: 12 + depth * 22 }}>
      <span className="d" />
      <div className="mid">
        <div className="top">
          <b>{a.name}</b>
          {!a.isMain && a.a.agentType ? <span className={`chip${background ? ' bg' : ''}`}>{background ? 'background' : a.a.agentType}</span> : null}
          <span className={`st ${state}`} title={state === 'thinking' ? 'Waiting on the model' : undefined}>
            {state === 'done' ? '✓ done' : state}
            {state === 'thinking' ? <span className="el"> {secs(now - a.lastActivity)}</span> : null}
          </span>
        </div>
        {state === 'working' && call ? (
          <div className="now">
            <span className="spin" />
            <span className="t">{maskSecrets(`${call.tool?.name ?? ''} ${call.tool?.summary ?? ''}`).text}</span>
            <span className="el">{secs(now - call.ts)}</span>
          </div>
        ) : state !== 'done' && state !== 'thinking' && a.status.text && a.status.text !== state ? (
          <div className="now">
            <span className="t">{maskSecrets(a.status.text).text}</span>
          </div>
        ) : null}
        {done && report ? (
          <div className="rep">
            <b>Report</b> · {report}
          </div>
        ) : a.bubble?.text ? (
          <div className="said">{a.bubble.text}</div>
        ) : null}
      </div>
      <div className="side">
        <div className="spark">
          {bars.map((c, i) => (
            <i key={i} style={{ height: 3 + (19 * c) / max, opacity: c ? 1 : 0.25 }} />
          ))}
        </div>
        <div className="counts" title={`${a.tools} tool call${a.tools === 1 ? '' : 's'}${files ? `, ${files} file${files === 1 ? '' : 's'} touched` : ''}`}>
          {a.tools} call{a.tools === 1 ? '' : 's'}
          {files ? <span className="fl"> · {files} file{files === 1 ? '' : 's'}</span> : null}
        </div>
      </div>
    </div>
  );
}

/** What the session's agents touched lately, newest first: files, the web, the shell, other tools. */
export function touchedBy(events: BrainEvent[], now: number, cwd?: string): Record<'Files' | 'Web' | 'Shell' | 'Tools', Touch[]> {
  const out = { Files: new Map<string, Touch>(), Web: new Map<string, Touch>(), Shell: new Map<string, Touch>(), Tools: new Map<string, Touch>() };
  const ended = new Map<string, BrainEvent>();
  for (const e of events) if (e.kind === 'tool' && e.phase === 'end' && e.toolUseId) ended.set(e.toolUseId, e);
  for (const e of events) {
    if (e.kind !== 'tool' || e.phase !== 'start' || !e.tool || now - e.ts > TOUCH_MS) continue;
    const end = e.toolUseId ? ended.get(e.toolUseId) : undefined;
    const r = e.tool.resource ?? '';
    const f = fileOf(e);
    const put = (g: keyof typeof out, key: string, t: Omit<Touch, 'key' | 'agents' | 'ts'>) => {
      const had = out[g].get(key);
      const agents = had ? (had.agents.includes(e.agentId) ? had.agents : [...had.agents, e.agentId]) : [e.agentId];
      out[g].set(key, { ...had, ...t, key, agents, ts: e.ts, changed: had?.changed || t.changed });
    };
    if (f) {
      const ch = end?.tool?.change;
      const changed = f.op === 'edit' || f.op === 'write';
      put('Files', f.path, { label: displayPath(f.path, cwd), path: f.path, changed, note: ch ? `+${ch.add} −${ch.del}` : f.op === 'read' ? 'read' : f.op === 'write' ? 'written' : 'edited' });
    } else if (r === 'shell') {
      // each command once, as it last ran
      put('Shell', e.tool.summary, { label: e.tool.summary, note: !end ? 'running' : end.tool?.failed ? 'failed' : end.durationMs != null ? secs(end.durationMs) : 'done', live: !end, failed: !!end?.tool?.failed });
    } else if (r.startsWith('web') || r === 'browser') {
      // a browser tool (Playwright): what it did, not its input as JSON
      const label = r === 'browser' ? `${e.tool.name.replace(/^mcp__([^_]+)__/, '$1 · ')}${/^[[{]/.test(e.tool.summary.trim()) ? '' : ` ${e.tool.summary}`}` : e.tool.summary;
      put('Web', label, { label, note: end?.tool?.resultSummary ?? (end ? 'done' : 'loading'), live: !end });
    } else if (r.startsWith('mcp:')) {
      put('Tools', `${e.tool.name} ${e.tool.summary}`, { label: `${e.tool.name.replace(/^mcp__([^_]+)__/, '$1 · ')} ${e.tool.summary}`.trim(), note: end ? 'done' : 'running', live: !end });
    }
  }
  const newest = (m: Map<string, Touch>) => [...m.values()].sort((a, b) => b.ts - a.ts);
  return { Files: newest(out.Files), Web: newest(out.Web), Shell: newest(out.Shell), Tools: newest(out.Tools) };
}
