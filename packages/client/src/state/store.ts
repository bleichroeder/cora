import { create } from 'zustand';
import { isMirror } from '../lib/synced';
import { DEFAULT_TOOLS, type ToolDef } from '../lib/tools';
import { isShell, type AgentInfo, type BrainEvent, type PendingRequest, type SessionInfo, type TerminalInfo } from '@cora/shared';
import { byTime } from '../lib/steps';
import { attentive, desktop } from '../lib/desktop';
import type { Explain } from '../components/Viewer';
import { useWeb } from './web';
import { trackWaits, type Wait } from '../lib/waits';
import { askLine, askSentence } from '../lib/asks';
// (format reads the store only when its functions run, so the two can import each other)
import { sessionName } from '../lib/format';

export type Conn = 'connecting' | 'open' | 'closed' | 'unauthorized';
/** A file's changes on show in the viewer: within a turn (from Claude Code's edits and snapshots), or uncommitted in git. */
export type DiffTarget = { sessionId: string; path: string; mode: 'turn' | 'git'; from?: number; to?: number | null; step?: number; follow?: boolean };
export type Toast = { id: string; sessionId: string; text: string; ts: number };
/**
 * The timeline's playhead in the focused session: the scene and the transcript show that moment instead of now. `wall`:
 * when it was put there. `eventId` / `toolUseId`: what it was put on (a marker, a block), so the transcript finds its step.
 */
export type TimeCursor = { sessionId: string; ts: number; wall: number; eventId?: string; toolUseId?: string };

// Events live outside zustand (they can number in the tens of thousands); a per-session version
// counter in the store triggers re-renders.
const eventMaps = new Map<string, Map<string, BrainEvent>>();
const sortedCache = new Map<string, { v: number; list: BrainEvent[] }>();

export function sessionEvents(sid: string | null | undefined): BrainEvent[] {
  if (!sid) return [];
  const v = useBrain.getState().versions[sid] ?? 0;
  const c = sortedCache.get(sid);
  if (c && c.v === v) return c.list;
  const list = [...(eventMaps.get(sid)?.values() ?? [])].sort(byTime);
  sortedCache.set(sid, { v, list });
  return list;
}

export const agentKey = (sid: string, aid: string) => `${sid}/${aid}`;

// Per-viewer layout preferences (localStorage can be unavailable: always guard).
const pref = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(`ab:${k}`);
    return v == null ? d : (JSON.parse(v) as T);
  } catch {
    return d;
  }
};
/** Opening a diff or an explain puts the session's browser away (its tabs stay loaded). */
const hideWeb = (sid: string | null) => {
  if (sid) useWeb.getState().setShown(sid, false);
  return {};
};

/** Per-viewer UI preferences (server-side settings live in /api/settings). */
export type UiPrefs = {
  /** the scene area in 3D (off: the live board, flat, no graphics engine; the overview shows its grid) */
  scene3d?: boolean;
  /** the live board's layout a new session starts with (lib/boardLayout); missing: the default */
  board?: import('../lib/boardLayout').BoardItem[];
  /** Cora's eye on its card: a main agent's orb (the default) or the lens */
  coraEye?: 'orb' | 'lens';
  /** the timeline under the scene shown (not folded away): with the 3D scene, and with the live board */
  timeline?: { scene?: boolean; board?: boolean };
  /** each session's own live board: its panels and pages */
  boards?: Record<string, import('../lib/boardLayout').SessionBoard>;
  /** the Board's layouts you saved (+ Panel › Save this page as a layout) */
  layouts?: import('../lib/boardLayout').SavedLayout[];
  /** collapse main's replies in hosted sessions (the terminal shows them too) */
  collapseHosted: boolean;
  /** terminal shows only Claude's input area, growing for menus and dialogs (where you type in the terminal) */
  compactTerminal: boolean;
  /** the shell a new shell tab opens (its id, e.g. 'pwsh', 'gitbash', 'wsl:Ubuntu'); missing: the first found */
  defaultShell?: string;
  notifyNeedsYou: boolean;
  notifyFinished: boolean;
  notifyExplains: boolean;
  /** a GitLab pipeline a session follows finished */
  notifyPipelines: boolean;
  /** what the overview (G) shows */
  overviewStyle: 'grid' | 'galaxy' | 'deploys';
  /** Claude's task list expanded above the transcript */
  tasksOpen: boolean;
  /** the scene's connections as liquid tubes with pulses (prototype), instead of lines with comets */
  flowLinks: boolean;
  /** where you write prompts to sessions hosted here: the composer (Claude's terminal hidden, showing itself when
   *  Claude Code asks you something) or the terminal itself */
  inputMode: 'composer' | 'terminal';
  /** in the composer, Enter sends (Shift+Enter: new line), or Enter is a new line (Ctrl+Enter sends) */
  composerEnter: 'enter' | 'ctrl-enter';
  /** web apps in the left nav's Tools drawer (Slack to start with) */
  tools: ToolDef[];
  /** the Tools drawer's width (px) */
  toolWidth: number;
  /** the star system behind the scene (a seed; a jump picks a new one); none yet: one is picked */
  starSystem?: number;
  /** how space looks behind the agents (Settings > Scene); missing parts: the defaults */
  space?: Partial<import('../scene/system/settings').SpaceSettings>;
  /** Cora's colour (Settings > Cora Orchestrator); none: teal */
  coraColor?: string;
};
export const DEFAULT_UI_PREFS: UiPrefs = { collapseHosted: false, compactTerminal: true, notifyNeedsYou: true, notifyFinished: true, notifyExplains: true, notifyPipelines: true, overviewStyle: 'grid', tasksOpen: true, flowLinks: true, inputMode: 'composer', composerEnter: 'enter', tools: DEFAULT_TOOLS, toolWidth: 560 };

/** The saved preferences over the defaults (an old "composer off" meant typing in the terminal). */
function loadPrefs(): UiPrefs {
  const { composer, ...saved } = pref<Partial<UiPrefs> & { composer?: boolean }>('ui', {});
  return { ...DEFAULT_UI_PREFS, ...(composer === false && !saved.inputMode ? { inputMode: 'terminal' as const } : {}), ...saved };
}

const savePref = (k: string, v: unknown) => {
  // a guest's screen (Go live) mirrors the host's look: what they change of it isn't kept
  if (isMirror()) return;
  try {
    localStorage.setItem(`ab:${k}`, JSON.stringify(v));
  } catch {
    /* ignore */
  }
};

type State = {
  conn: Conn;
  /** the server's first snapshot has come in (until then an empty list isn't "no sessions") */
  ready: boolean;
  lastSeq: number;
  sessions: Record<string, SessionInfo>;
  /** the Cora Orchestrator's own session: kept out of `sessions` (and so out of every list); the console shows it */
  agentSession: SessionInfo | null;
  agents: Record<string, AgentInfo>;
  versions: Record<string, number>;
  loaded: Record<string, boolean>;
  pending: PendingRequest[];
  toasts: Toast[];
  /** sessions that finished a turn while you were looking elsewhere (when), until you open them */
  unseen: Record<string, number>;
  /** you're back on this session (the window came back to it): it's seen */
  markSeen(sid: string | null): void;
  focus: string | null;
  agentFilter: 'all' | string;
  overview: boolean;
  /** a project's board open in the main area (its id) */
  projectOpen: string | null;
  openProject(id: string | null): void;
  /** Cora's Inbox (a drawer beside Cora's console) */
  inbox: boolean;
  /** hosted Claude terminals (shells are kept apart, so "the session's terminal" always means its Claude) */
  terminals: TerminalInfo[];
  /** plain shells opened beside sessions */
  shells: TerminalInfo[];
  /** user-chosen right column width (px), null = automatic */
  rightWidth: number | null;
  /** terminal share of the right column height (0..1) */
  termRatio: number;
  expanded: boolean;
  modal: 'new-session' | 'history' | 'settings' | null;
  viewer: Explain | null;
  viewerWide: boolean;
  rightTab: 'transcript' | 'explains' | 'changes';
  diff: DiffTarget | null;
  diffWide: boolean;
  prefs: UiPrefs;
  /** the timeline's playhead (null: live) */
  cursor: TimeCursor | null;
  /** A session just started, resumed or forked from here: its scene opens with a big bang. */
  bang: string | null;
  /** permission prompts and questions seen come and go, for the timeline */
  waits: Wait[];
  setCursor(c: Omit<TimeCursor, 'wall'> | null): void;
  setBang(sid: string | null): void;
  setViewer(p: Explain | null): void;
  setViewerWide(v: boolean): void;
  setRightTab(t: 'transcript' | 'explains' | 'changes'): void;
  setDiff(d: DiffTarget | null): void;
  setDiffWide(v: boolean): void;
  /** the UI preferences as this browser now has them (another screen of yours changed them) */
  reloadPrefs(): void;
  setPrefs(p: Partial<UiPrefs>): void;
  setConn(c: Conn): void;
  applySnapshot(s: { sessions: SessionInfo[]; agents: AgentInfo[]; pending: PendingRequest[]; terminals?: TerminalInfo[]; lastSeq: number; recent: Record<string, BrainEvent[]> }): void;
  /** the server's whole list: Claude terminals and shells */
  setTerminals(t: TerminalInfo[]): void;
  setRightWidth(w: number | null): void;
  setTermRatio(r: number): void;
  toggleExpanded(): void;
  setModal(m: State['modal']): void;
  applyEvents(events: BrainEvent[]): void;
  upsertSession(s: SessionInfo): void;
  upsertAgent(a: AgentInfo): void;
  setPending(p: PendingRequest[]): void;
  markLoaded(sid: string): void;
  setFocus(sid: string | null): void;
  setAgentFilter(f: 'all' | string): void;
  toggleOverview(force?: boolean): void;
  setInbox(on: boolean): void;
  dismissToast(id: string): void;
};

const splitTerminals = (all: TerminalInfo[]) => ({ terminals: all.filter((t) => !isShell(t)), shells: all.filter(isShell) });

function merge(events: BrainEvent[]): Record<string, number> {
  const touched: Record<string, number> = {};
  for (const e of events) {
    let m = eventMaps.get(e.sessionId);
    if (!m) eventMaps.set(e.sessionId, (m = new Map()));
    const prev = m.get(e.id);
    if (!prev || prev.seq <= e.seq) m.set(e.id, e);
    touched[e.sessionId] = 1;
    if (m.size > 30000) {
      const drop = [...m.values()].sort(byTime).slice(0, 5000);
      for (const d of drop) m.delete(d.id);
    }
  }
  return touched;
}

export const useBrain = create<State>((set, get) => ({
  conn: 'connecting',
  ready: false,
  lastSeq: 0,
  sessions: {},
  agentSession: null,
  agents: {},
  versions: {},
  loaded: {},
  pending: [],
  toasts: [],
  unseen: {},
  markSeen: (sid) => {
    if (!sid || !get().unseen[sid]) return;
    const { [sid]: _seen, ...unseen } = get().unseen;
    set({ unseen });
  },
  focus: null,
  agentFilter: 'all',
  overview: false,
  projectOpen: null,
  inbox: false,
  terminals: [],
  shells: [],
  rightWidth: pref<number | null>('rightWidth', null),
  termRatio: pref('termRatio', 0.42),
  expanded: false,
  modal: null,
  viewer: null,
  viewerWide: false,
  rightTab: 'transcript',
  diff: null,
  diffWide: false,
  prefs: loadPrefs(),
  cursor: null,
  bang: null,
  waits: [],

  setConn: (conn) => set({ conn }),
  setBang: (bang) => set({ bang }),
  setCursor: (c) => set({ cursor: c ? { ...c, wall: Date.now() } : null }),

  applySnapshot: (s) => {
    const touched = merge(Object.values(s.recent).flat());
    const versions = { ...get().versions };
    for (const sid of Object.keys(touched)) versions[sid] = (versions[sid] ?? 0) + 1;
    set({
      ready: true,
      sessions: Object.fromEntries(s.sessions.filter((x) => x.id !== hidden).map((x) => [x.id, x])),
      agentSession: s.sessions.find((x) => x.id === hidden) ?? get().agentSession,
      agents: Object.fromEntries(s.agents.map((a) => [agentKey(a.sessionId, a.agentId), a])),
      pending: s.pending,
      waits: trackWaits(get().waits, s.pending),
      ...(s.terminals ? splitTerminals(s.terminals) : {}),
      lastSeq: Math.max(get().lastSeq, s.lastSeq),
      versions,
    });
  },

  setTerminals: (all) => set(splitTerminals(all)),
  setRightWidth: (rightWidth) => {
    savePref('rightWidth', rightWidth);
    set({ rightWidth });
  },
  setTermRatio: (termRatio) => {
    const r = Math.min(0.85, Math.max(0.15, termRatio));
    savePref('termRatio', r);
    set({ termRatio: r });
  },
  toggleExpanded: () => set({ expanded: !get().expanded }),
  setModal: (modal) => set({ modal }),
  setViewer: (viewer) => set({ viewer, ...(viewer ? { diff: null, diffWide: false, ...hideWeb(get().focus) } : { viewerWide: false }) }),
  setViewerWide: (viewerWide) => set({ viewerWide }),
  setRightTab: (rightTab) => set({ rightTab }),
  setDiff: (diff) => set({ diff, ...(diff ? hideWeb(diff.sessionId) : { diffWide: false }) }),
  setDiffWide: (diffWide) => set({ diffWide }),
  reloadPrefs: () => set({ prefs: loadPrefs() }),
  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p };
    savePref('ui', prefs);
    set({ prefs });
  },

  applyEvents: (events) => {
    if (!events.length) return;
    const touched = merge(events);
    const versions = { ...get().versions };
    for (const sid of Object.keys(touched)) versions[sid] = (versions[sid] ?? 0) + 1;
    set({ versions, lastSeq: Math.max(get().lastSeq, ...events.map((e) => e.seq)) });
  },

  upsertSession: (s) => {
    if (s.id === hidden) return set({ agentSession: s });
    const was = get().sessions[s.id]?.state;
    let unseen = get().unseen;
    // its turn ended while you were on another session, or away from the window: it's news until you open it
    if ((was === 'working' || was === 'thinking') && s.state === 'idle' && (get().focus !== s.id || !attentive())) unseen = { ...unseen, [s.id]: Date.now() };
    // working again, or ended: not news any more
    else if (unseen[s.id] && s.state !== 'idle') {
      const { [s.id]: _was, ...rest } = unseen;
      unseen = rest;
    }
    set({ sessions: { ...get().sessions, [s.id]: s }, ...(unseen !== get().unseen ? { unseen } : {}) });
  },
  upsertAgent: (a) => set({ agents: { ...get().agents, [agentKey(a.sessionId, a.agentId)]: a } }),

  setPending: (pending) => {
    const before = new Set(get().pending.map((p) => p.id));
    const focus = get().focus;
    const fresh = pending.filter((p) => !before.has(p.id) && p.sessionId !== focus);
    for (const p of pending.filter((x) => x.sessionId !== hidden && get().prefs.notifyNeedsYou && !before.has(x.id) && (x.sessionId !== focus || !attentive()))) {
      const s = get().sessions[p.sessionId];
      desktop?.notify(`${s ? sessionName(s) : 'A session'} needs you`, askSentence(p), p.sessionId);
    }
    const toasts = [
      ...get().toasts,
      ...fresh.map((p) => ({ id: p.id, sessionId: p.sessionId, ts: Date.now(), text: askLine(p) })),
    ];
    set({ pending, waits: trackWaits(get().waits, pending), toasts: toasts.filter((t) => pending.some((p) => p.id === t.id)) });
  },

  markLoaded: (sid) => set({ loaded: { ...get().loaded, [sid]: true }, versions: { ...get().versions, [sid]: (get().versions[sid] ?? 0) + 1 } }),
  setFocus: (focus) =>
    set({ focus, agentFilter: 'all', overview: false, projectOpen: null, ...(focus && get().unseen[focus] ? { unseen: Object.fromEntries(Object.entries(get().unseen).filter(([k]) => k !== focus)) } : {}), ...(focus !== get().focus ? { cursor: null } : {}), toasts: get().toasts.filter((t) => t.sessionId !== focus), ...(get().viewer?.pinned && focus !== get().focus ? { viewer: null, viewerWide: false } : {}) }),
  setAgentFilter: (agentFilter) => set({ agentFilter }),
  toggleOverview: (force) => {
    const overview = force ?? !get().overview;
    set({ overview, ...(overview ? { projectOpen: null } : {}) });
  },
  openProject: (id) => set({ projectOpen: id, ...(id ? { overview: false } : {}) }),
  setInbox: (on) => set({ inbox: on }),
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** The orchestrator's session (from its status): never in `sessions`, so never in a list. */
let hidden: string | null = null;
export function setHiddenSession(id: string | null): void {
  if (id === hidden) return;
  const prev = hidden;
  hidden = id;
  const st = useBrain.getState();
  const sessions = { ...st.sessions };
  let agentSession = st.agentSession;
  // it moved (turned off, or a fresh session): the old one goes back to being a session like any other
  if (prev && agentSession?.id === prev) {
    sessions[prev] = agentSession;
    agentSession = null;
  }
  if (id && sessions[id]) {
    agentSession = sessions[id];
    delete sessions[id];
  }
  useBrain.setState({ sessions, agentSession, ...(id && st.focus === id ? { focus: null } : {}) });
}

export function mergeFetched(sid: string, events: BrainEvent[]) {
  merge(events);
  useBrain.getState().markLoaded(sid);
}
