import { create } from 'zustand';
import type { ShellProfile, TerminalInfo } from '@cora/shared';
import { useBrain } from './store';

/** Shell tabs' UI state: which tab each session shows, what each shell's terminal calls itself, new output unseen. */
type ShellUi = {
  /** session → the tab on show ('claude' or a shell's terminal id) */
  active: Record<string, string>;
  /** shell → the title its terminal last reported */
  titles: Record<string, string>;
  /** shell → the command you started in it that's still running (most programs never set a title) */
  running: Record<string, string>;
  /** shells with output you haven't seen (it came while another tab was on show) */
  unread: Record<string, true>;
  /** composer mode: sessions whose hidden Claude terminal you asked to see (until you hide it again) */
  peek: Record<string, true>;
  /** sessions whose Claude Code is showing a choice (a permission prompt, a question, a picker) */
  asking: Record<string, true>;
  /** the shells a tab can be (PowerShell, Command Prompt, Git Bash, WSL distros), once asked for */
  kinds: ShellProfile[] | null;
  show(sessionId: string, tab: string): void;
  setTitle(terminalId: string, title: string): void;
  setRunning(terminalId: string, cmd: string | null): void;
  markUnread(terminalId: string): void;
  setPeek(sessionId: string, on: boolean): void;
  setAsking(sessionId: string, on: boolean): void;
};

const flag = (m: Record<string, true>, k: string, on: boolean): Record<string, true> | null => {
  if (!!m[k] === on) return null;
  const { [k]: _was, ...rest } = m;
  return on ? { ...rest, [k]: true } : rest;
};

// shells' names (their titles and running commands), kept across a reload (the shells themselves outlive it)
const KEPT = 'cora.shellTabs';
const kept = (() => {
  try {
    const j = JSON.parse(localStorage.getItem(KEPT) ?? '{}');
    return { titles: j.titles ?? {}, running: j.running ?? {} } as { titles: Record<string, string>; running: Record<string, string> };
  } catch {
    return { titles: {}, running: {} };
  }
})();
/** Keep the names of shells that are still open (and of all of them before the list has come). */
function keep(titles: Record<string, string>, running: Record<string, string>): void {
  try {
    const open = new Set(useBrain.getState().shells.map((t) => t.terminalId));
    const only = (m: Record<string, string>) => (open.size ? Object.fromEntries(Object.entries(m).filter(([k]) => open.has(k))) : m);
    localStorage.setItem(KEPT, JSON.stringify({ titles: only(titles), running: only(running) }));
  } catch {
    /* not kept: names come back as the shells report them */
  }
}

export const useShells = create<ShellUi>((set, get) => ({
  active: {},
  titles: kept.titles,
  running: kept.running,
  kinds: null,
  unread: {},
  peek: {},
  asking: {},
  show: (sessionId, tab) => {
    const { [tab]: _seen, ...unread } = get().unread;
    set({ active: { ...get().active, [sessionId]: tab }, unread });
  },
  setTitle: (terminalId, title) => {
    if (get().titles[terminalId] === title) return;
    set({ titles: { ...get().titles, [terminalId]: title } });
    keep(get().titles, get().running);
  },
  setRunning: (terminalId, cmd) => {
    if ((get().running[terminalId] ?? null) === cmd) return;
    const { [terminalId]: _was, ...rest } = get().running;
    set({ running: cmd ? { ...rest, [terminalId]: cmd } : rest });
    keep(get().titles, get().running);
  },
  markUnread: (terminalId) => !get().unread[terminalId] && set({ unread: { ...get().unread, [terminalId]: true } }),
  setPeek: (sessionId, on) => {
    const peek = flag(get().peek, sessionId, on);
    if (peek) set({ peek });
  },
  setAsking: (sessionId, on) => {
    const asking = flag(get().asking, sessionId, on);
    if (asking) set({ asking });
  },
}));

/** Each mounted shell's "is something running?" guess (from the line at its cursor), for closing it. */
export const shellBusy = new Map<string, () => boolean>();

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** The shells a tab can be (asked for once; `fresh` looks again, e.g. after installing Git or a WSL distro). */
export async function loadShellKinds(fresh = false): Promise<ShellProfile[]> {
  if (!fresh && useShells.getState().kinds) return useShells.getState().kinds!;
  const r = await fetch(`/api/shells${fresh ? '?fresh=1' : ''}`).catch(() => null);
  const kinds = r?.ok ? (((await r.json().catch(() => ({}))) as { shells?: ShellProfile[] }).shells ?? []) : [];
  useShells.setState({ kinds });
  return kinds;
}

/** Open a shell beside a session's Claude, in its folder, and show it: the kind asked for, else your default. */
export async function openShell(sessionId: string, kind?: string): Promise<string | null> {
  const shell = kind ?? useBrain.getState().prefs.defaultShell;
  const r = await post('/api/terminals', { mode: 'shell', sessionId, ...(shell ? { shell } : {}) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) return j.error ?? `HTTP ${r.status}`;
  const t = j as TerminalInfo;
  const st = useBrain.getState();
  // the hub's list follows; add it now so the tab is there at once
  st.setTerminals([...st.terminals, ...st.shells.filter((x) => x.terminalId !== t.terminalId), t]);
  useShells.getState().show(sessionId, t.terminalId);
  return null;
}

/** A shell of the Board's own (its Terminal panel), in the session's folder: its terminal id, or why not. */
export async function openBoardShell(sessionId: string, kind?: string): Promise<{ id: string } | { error: string }> {
  const shell = kind ?? useBrain.getState().prefs.defaultShell;
  const r = await post('/api/terminals', { mode: 'shell', sessionId, board: true, ...(shell ? { shell } : {}) }).catch(() => null);
  if (!r) return { error: "Can't reach Cora's server." };
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) return { error: j.error ?? `HTTP ${r.status}` };
  const t = j as TerminalInfo;
  const st = useBrain.getState();
  st.setTerminals([...st.terminals, ...st.shells.filter((x) => x.terminalId !== t.terminalId), t]);
  return { id: t.terminalId };
}

/** End a shell (and whatever runs in it); its tab goes when the server says it's gone. */
export async function closeShell(terminalId: string): Promise<string | null> {
  const r = await post(`/api/terminals/${encodeURIComponent(terminalId)}/close`, {});
  return r.ok ? null : ((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
}

/** Is one of the session's shells on show in its terminal area (rather than its Claude)? */
export function useShellOnShow(sessionId: string): boolean {
  const tab = useShells((s) => s.active[sessionId]);
  return useBrain((s) => !!tab && s.shells.some((t) => t.terminalId === tab && t.sessionId === sessionId));
}

/**
 * What a session's terminal area shows. In composer mode (a session hosted here) Claude's terminal is hidden: you
 * write in the composer, and the terminal shows itself (just its input area) while Claude Code asks you something,
 * or in full while you peek at it. Shells always show when their tab is picked; closing one goes back to this.
 */
export function useTermView(sessionId: string) {
  const onShell = useShellOnShow(sessionId);
  const hosted = useBrain((s) => s.terminals.some((t) => t.sessionId === sessionId && t.alive));
  const mode = useBrain((s) => s.prefs.inputMode);
  const compactPref = useBrain((s) => s.prefs.compactTerminal);
  const peek = useShells((s) => !!s.peek[sessionId]);
  const asking = useShells((s) => !!s.asking[sessionId]);
  const composer = hosted && mode === 'composer';
  return {
    composer,
    onShell,
    peek: composer && peek,
    asking,
    /** Claude's terminal is on show when its tab is */
    claudeShown: !composer || peek || asking,
    /** ...as just its input area */
    claudeCompact: composer ? !peek : compactPref,
  };
}
