import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { jumpToHyperspace } from '../scene/system/warp';
import { create } from 'zustand';
import type { BrainEvent, HistoryItem, LaunchPreset, Settings } from '@cora/shared';
import { DEFAULT_VOICE } from '@cora/shared';
import { sessionEvents, useBrain } from '../state/store';
import { useWeb } from '../state/web';
import { useShells } from '../state/shells';
import { useSlack } from '../state/slack';
import { openTool } from './Tools';
import { useTools } from '../state/tools';
import { NOTES_ID, askNotes, useNotes } from '../state/notes';
import { showBrowser } from '../state/browser';
import { fetchHistory, launchTerminal } from '../state/ws';
import { ago, isDismissed, sessionColor, sessionName, shortCwd } from '../lib/format';
import { sortedSessions } from '../lib/sessionOrder';
import { desktop } from '../lib/desktop';
import { stopSpeaking, useVoice, voiceLevels } from '../lib/voice';
import { GROUP_LABEL, lineOf, pushRecent, rank, recentFolders, runs, searchLines, tokensOf, type Entry, type Line } from '../lib/palette';
import { explainFrom } from './Viewer';
import { openNewSession } from './Launchers';
import { SETTINGS_SECTIONS, openSettings } from './SettingsModal';
import { EndSessionConfirm } from './EndSession';
import { clearEnded, dismissSession, showSession, suggestName } from './SessionMenu';
import { Icon } from './Icon';
import { lockNow } from '../state/lock';
import './dialogs.css';
import './palette.css';

/**
 * The command palette (Ctrl+K): one search over sessions, older sessions, folders to start in, transcript text,
 * explains and commands. Lives beside the app, not in the store: its state is its own.
 */
type PaletteState = { open: boolean; /** a session whose end-confirm the palette asked for */ ending: string | null };
export const usePalette = create<PaletteState>(() => ({ open: false, ending: null }));
/** where focus was before the palette took it (the terminal, an input), given back when it closes without acting */
let before: HTMLElement | null = null;
export function openPalette(open = !usePalette.getState().open) {
  if (open === usePalette.getState().open) return;
  if (!open) return closePalette(true);
  before = document.activeElement as HTMLElement | null;
  usePalette.setState({ open });
}
function closePalette(restore: boolean) {
  const el = before;
  before = null;
  usePalette.setState({ open: false });
  if (restore) requestAnimationFrame(() => el?.isConnected && el.focus());
}

type Run = (alt: boolean) => void | Promise<string | void>;
type PEntry = Entry & {
  run: Run;
  icon?: string;
  /** a session's state dot (rail colours) ringed in its colour */
  dot?: string;
  color?: string;
  tag?: string;
  /** what Enter does, and Shift+Enter when there's a second action */
  verb: string;
  alt?: string;
  /** not remembered as a recent pick (transcript hits) */
  fleeting?: boolean;
};

// ---------------------------------------------------------------- remembered between opens

const RECENT_KEY = 'ab:palette.recent';
const loadRecent = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const saveRecent = (l: string[]) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(l));
  } catch {
    /* storage unavailable: no recent picks */
  }
};
/** the last answers, so a reopened palette lists them at once while it asks again */
const cache: { history: HistoryItem[]; explains: BrainEvent[]; presets: LaunchPreset[] } = { history: [], explains: [], presets: [] };
/** each session's searchable lines, rebuilt only when its events change */
const lineCache = new Map<string, { v: number; lines: Line[] }>();
function linesOf(sid: string): Line[] {
  const v = useBrain.getState().versions[sid] ?? 0;
  const c = lineCache.get(sid);
  if (c?.v === v) return c.lines;
  const lines: Line[] = [];
  for (const e of sessionEvents(sid)) {
    const l = lineOf(e);
    if (l) lines.push(l);
  }
  lineCache.set(sid, { v, lines });
  return lines;
}

// ---------------------------------------------------------------- what picking does

/** Focus a session; one hidden from the list comes back into it (focus can't stay on a hidden session). */
function focusSession(sid: string) {
  showSession(sid);
}

/** Show a transcript line: focus its session and put the timeline's playhead on it, which scrolls the transcript there. */
function jumpTo(sid: string, l: Line) {
  focusSession(sid);
  const st = useBrain.getState();
  st.setRightTab('transcript');
  st.setCursor({ sessionId: sid, ts: l.ts, ...(l.kind === 'tool' && l.toolUseId ? { toolUseId: l.toolUseId } : { eventId: l.id }) });
}

function openExplain(e: BrainEvent) {
  const p = explainFrom(e);
  if (!p) return;
  const st = useBrain.getState();
  if (st.sessions[e.sessionId]) {
    focusSession(e.sessionId);
    useBrain.getState().setViewer(p);
  } else {
    // its session is gone from the list: show it over whatever is focused, as the Explains tab does
    st.toggleOverview(false);
    st.setViewer({ ...p, pinned: true });
  }
}

const launched = (r: Awaited<ReturnType<typeof launchTerminal>>) => (r.ok ? undefined : r.error);

async function setVoice(enabled: boolean): Promise<string | void> {
  const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice: { enabled } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return j.error ?? `HTTP ${r.status}`;
  if ((j as Settings).voice) useVoice.setState({ settings: { ...DEFAULT_VOICE, ...(j as Settings).voice } });
}

const STATE_DOT: Record<string, string> = { 'needs-you': 'r', working: 'g', thinking: 'a' };
/** A session's state, on its tile's corner. */
const TILE_OF: Record<string, string> = { r: 'need', g: 'work', a: 'think' };
const LINE_ICON: Record<string, string> = { prompt: 'User', say: 'MessageSquare', report: 'Flag', tool: 'Wrench' };

// ---------------------------------------------------------------- the entries

function useEntries(): PEntry[] {
  const sessions = useBrain((s) => s.sessions);
  const focus = useBrain((s) => s.focus);
  const overview = useBrain((s) => s.overview);
  const cursor = useBrain((s) => s.cursor);
  const viewer = useBrain((s) => s.viewer);
  const prefs = useBrain((s) => s.prefs);
  const hosted = useBrain((s) => s.terminals.some((t) => t.sessionId === s.focus && t.alive));
  const voice = useVoice((s) => s.settings.enabled);
  const voiceKey = useVoice((s) => !!s.key?.set);
  const webShown = useWeb((w) => (focus ? !!w.sessions[focus]?.shown : false));
  const [history, setHistory] = useState(cache.history);
  const [explains, setExplains] = useState(cache.explains);
  const [presets, setPresets] = useState(cache.presets);

  useEffect(() => {
    let live = true;
    void fetchHistory().then((h) => live && setHistory((cache.history = h)));
    void fetch('/api/explains?limit=300')
      .then((r) => (r.ok ? r.json() : { explains: [] }))
      .then((j: { explains: BrainEvent[] }) => live && setExplains((cache.explains = j.explains ?? [])))
      .catch(() => {});
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((s: Settings) => live && setPresets((cache.presets = s.presets ?? [])))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const notes = useNotes((s) => s.list);

  return useMemo(() => {
    const now = Date.now();
    const out: PEntry[] = [];
    const st = useBrain.getState;

    // sessions, grouped as the nav groups them (working, idle, ended and removed), each in the list's order
    const order = sortedSessions(sessions);
    order.forEach((s, i) => {
      const name = sessionName(s);
      const hidden = isDismissed(s);
      out.push({
        id: `session:${s.id}`,
        group: hidden || s.state === 'ended' ? 'ended' : s.state === 'idle' ? 'idle' : 'session',
        label: name,
        detail: `${shortCwd(s.cwd)}${s.title && s.title !== name ? ` · ${s.title}` : ''}`,
        keywords: `${s.project} ${s.id.slice(0, 8)}`,
        boost: 10 * (1 - i / Math.max(order.length, 1)) - (hidden || s.state === 'ended' ? 6 : 0) - (s.id === focus && !overview ? 3 : 0),
        dot: STATE_DOT[s.state] ?? 'z',
        color: sessionColor(s),
        tag: s.id === focus && !overview ? 'here' : hidden ? 'removed' : s.state === 'needs-you' ? 'needs you' : undefined,
        verb: s.state === 'ended' ? 'open' : 'focus',
        run: () => focusSession(s.id),
      });
    });

    // older sessions on disk that aren't in the list
    for (const h of history) {
      if (sessions[h.sessionId] || !h.cwd) continue;
      out.push({
        id: `older:${h.sessionId}`,
        group: 'older',
        label: h.title || h.firstPrompt || h.sessionId.slice(0, 8),
        detail: `${shortCwd(h.cwd)} · ${ago(h.mtime, now)} ago`,
        keywords: h.title ? h.firstPrompt.slice(0, 200) : undefined,
        boost: Math.max(0, 6 - (now - h.mtime) / 86400_000),
        icon: 'History',
        tag: 'resume',
        verb: 'resume',
        alt: 'fork',
        run: async (alt) => launched(await launchTerminal({ mode: alt ? 'fork' : 'resume', sessionId: h.sessionId, cwd: h.cwd })),
      });
    }

    // start Claude: presets, then recent folders
    for (const p of presets) {
      const options = { model: p.model, effort: p.effort, permissionMode: p.permissionMode };
      out.push({
        id: `preset:${p.id}`,
        group: 'new',
        label: p.name,
        detail: [shortCwd(p.cwd), p.model, p.effort && `${p.effort} effort`, p.permissionMode].filter(Boolean).join(' · '),
        keywords: 'new session start launch preset',
        boost: 4,
        icon: 'Rocket',
        verb: 'start',
        alt: 'pick options',
        run: async (alt) => (alt ? openNewSession(p.cwd) : launched(await launchTerminal({ mode: 'new', cwd: p.cwd, options }))),
      });
    }
    const folders = recentFolders([...Object.values(sessions).map((s) => ({ cwd: s.cwd, ts: s.lastTs })), ...history.map((h) => ({ cwd: h.cwd, ts: h.mtime }))]);
    folders.forEach((cwd, i) => {
      out.push({
        id: `folder:${cwd.replace(/\\/g, '/').toLowerCase()}`,
        group: 'new',
        label: `New session in ${cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd}`,
        detail: cwd,
        keywords: 'start launch claude',
        boost: 3 * (1 - i / folders.length),
        icon: 'FolderPlus',
        verb: 'start Claude here',
        alt: 'pick options',
        run: async (alt) => (alt ? openNewSession(cwd) : launched(await launchTerminal({ mode: 'new', cwd }))),
      });
    });

    // explains
    for (const e of explains) {
      const p = explainFrom(e);
      if (!p) continue;
      const s = sessions[e.sessionId];
      out.push({
        id: `explain:${p.toolUseId}`,
        group: 'explain',
        label: p.title,
        detail: `${s ? sessionName(s) : 'older session'} · ${p.format === 'html' ? 'HTML' : 'markdown'} · ${ago(e.ts, now)} ago`,
        boost: (e.sessionId === focus ? 5 : 0) + Math.max(0, 4 - (now - e.ts) / 86400_000),
        icon: 'Presentation',
        verb: 'open',
        run: () => openExplain(e),
      });
    }

    // your notes, by title (open in the drawer), and a new one from each template
    const showNotes = () => useTools.getState().show(NOTES_ID);
    for (const n of notes) {
      if (n.kind === 'template') {
        out.push({ id: `tpl:${n.id}`, group: 'note', label: `New ${n.title}${n.fill ? ' (Cora drafts it)' : ''}`, detail: 'from a template', icon: n.fill ? 'Sparkles' : 'FileText', verb: 'run', keywords: 'note template standup meeting draft', run: () => (showNotes(), askNotes('start', n.id)) });
      } else if (n.kind === 'note') {
        out.push({ id: `note:${n.id}`, group: 'note', label: n.title, detail: n.preview || 'note', icon: 'FileText', verb: 'open', boost: n.pinned ? 2 : 0, run: () => (showNotes(), askNotes('open', n.id)) });
      }
    }

    // commands: whatever exists and makes sense right now
    const cmd = (id: string, label: string, icon: string, run: Run, o: Partial<PEntry> = {}) =>
      out.push({ id: `cmd:${id}`, group: 'command', label, icon, verb: 'run', run, ...o });
    const cur = focus ? sessions[focus] : undefined;
    cmd('new', 'New session…', 'Plus', () => openNewSession(), { keywords: 'start launch claude folder', featured: true, boost: 5 });
    cmd('jira', 'Start from Jira ticket…', 'Ticket', () => openNewSession(undefined, 'jira'), { keywords: 'new session jira ticket issue /jira start', boost: 3 });
    cmd('hyperspace', 'Jump to hyperspace', 'Rocket', () => void jumpToHyperspace(), { keywords: 'scene space star system planet warp jump new background' });
    cmd('older', 'Resume a session…', 'History', () => st().setModal('history'), { keywords: 'history resume fork', featured: true, boost: 4 });
    cmd('overview', overview ? 'Back to the session' : 'Overview', 'LayoutGrid', () => st().toggleOverview(), { keywords: 'grid galaxy all sessions G', featured: true, boost: 3 });
    cmd('settings', 'Settings', 'Settings', () => openSettings(), { keywords: 'preferences options', featured: true, boost: 2 });
    cmd('lock', 'Lock Cora', 'Lock', () => void lockNow(), { keywords: 'lockdown away pin secure screen' });
    for (const sec of SETTINGS_SECTIONS) if (!sec.desktop || desktop) cmd(`settings:${sec.id}`, `Settings: ${sec.label}`, sec.icon, () => openSettings(sec.id), { keywords: 'preferences options' });
    cmd('grid', 'Overview as a grid', 'LayoutGrid', () => (st().setPrefs({ overviewStyle: 'grid' }), st().toggleOverview(true)), { keywords: 'cards' });
    cmd('galaxy', 'Overview as a galaxy', 'Orbit', () => (st().setPrefs({ overviewStyle: 'galaxy' }), st().toggleOverview(true)), { keywords: 'stars space' });
    cmd('notes', 'Notes', 'NotebookPen', () => useTools.getState().show(NOTES_ID), { keywords: 'notepad scratch named notes write Ctrl+Shift+N' });
    if (desktop?.browser) cmd('browser', 'Browser', 'Globe', () => showBrowser(), { keywords: "web browse tabs not tied to a session Cora's own Ctrl+Shift+B" });
    cmd('jot', 'Jot a note', 'NotebookPen', () => (useTools.getState().show(NOTES_ID), useNotes.setState({ focusJot: Date.now() })), { keywords: 'notepad scratch write down remember Ctrl+Alt+N' });
    cmd('deploys', 'Deploys: what each environment runs', 'Rocket', () => (st().setPrefs({ overviewStyle: 'deploys' }), st().toggleOverview(true)), { keywords: 'dev staging prod kubectl tags images bump rollout environments' });
    if (cur && !overview) {
      if (cur.state !== 'ended') cmd('end', `End “${sessionName(cur)}”…`, 'Power', () => usePalette.setState({ ending: cur.id }), { keywords: 'end this session quit stop kill exit close' });
      else if (!isDismissed(cur)) cmd('remove', `Remove “${sessionName(cur)}” from the list`, 'EyeOff', () => void dismissSession(cur.id), { keywords: 'dismiss hide ended' });
      cmd('tab:transcript', 'Show the transcript', 'ScrollText', () => st().setRightTab('transcript'));
      cmd('tab:explains', 'Show this session’s explains', 'Presentation', () => st().setRightTab('explains'), { keywords: 'documents tab' });
      cmd('tab:changes', 'Show the changes', 'FileDiff', () => st().setRightTab('changes'), { keywords: 'diff files edits tab' });
      cmd('name', 'Suggest a name for this session', 'Sparkles', async () => (await suggestName(cur.id)) ?? undefined, { keywords: 'rename auto name' });
      cmd('copy-folder', 'Copy this session’s folder', 'Copy', () => (desktop?.writeClipboard ? desktop.writeClipboard(cur.cwd) : void navigator.clipboard?.writeText(cur.cwd).catch(() => {})), { keywords: 'path cwd clipboard' });
      cmd('expand', st().expanded ? 'Narrow the right column' : 'Widen the right column', 'Columns2', () => st().toggleExpanded(), { keywords: 'expand layout' });
      if (hosted) cmd('input', prefs.inputMode === 'composer' ? 'Write prompts in the terminal' : 'Write prompts in the composer (hide the terminal)', prefs.inputMode === 'composer' ? 'SquareTerminal' : 'PenLine', () => st().setPrefs({ inputMode: prefs.inputMode === 'composer' ? 'terminal' : 'composer' }), { keywords: 'composer terminal hide show input prompt box' });
      if (hosted && prefs.inputMode === 'composer') {
        const peeking = !!useShells.getState().peek[cur.id];
        cmd('peek', peeking ? "Hide Claude's terminal" : "Show Claude's terminal", peeking ? 'EyeOff' : 'Eye', () => useShells.getState().setPeek(cur.id, !peeking), { keywords: 'peek terminal show hide' });
      }
      if (cursor?.sessionId === cur.id) cmd('live', 'Back to live', 'Radio', () => st().setCursor(null), { keywords: 'timeline replay now playhead', featured: true, boost: 6 });
      if (desktop?.browser) {
        cmd('web:new', 'Browser: new tab', 'Globe', () => (useWeb.getState().newTab(cur.id), useWeb.getState().setShown(cur.id, true)), { keywords: 'web open url' });
        cmd('web:toggle', webShown ? 'Hide the browser' : 'Show the browser', 'Globe', () => useWeb.getState().setShown(cur.id, !webShown), { keywords: 'web tabs' });
      }
    }
    if (viewer) cmd('viewer', 'Close the explain', 'X', () => st().setViewer(null), { keywords: 'viewer document' });
    if (voiceKey) cmd('voice', voice ? 'Turn voice off' : 'Turn voice on', voice ? 'MicOff' : 'Mic', () => setVoice(!voice), { keywords: 'speech speak read aloud tts push to talk' });
    else cmd('voice', 'Set up voice…', 'Mic', () => openSettings('voice'), { keywords: 'speech speak read aloud tts push to talk' });
    if (voiceLevels.speaking) cmd('hush', 'Stop speaking', 'VolumeX', () => stopSpeaking(), { keywords: 'quiet silence voice', featured: true, boost: 7 });
    if (Object.values(sessions).some((s) => s.state === 'ended' && !isDismissed(s))) cmd('clear-ended', 'Take ended sessions off the list', 'EyeOff', () => void clearEnded(), { keywords: 'dismiss hide remove' });
    prefs.tools.forEach((t, i) => cmd(`tool:${t.id}`, `Open ${t.name}`, 'Wrench', () => openTool(t), { keywords: `tool ${t.url}${i < 9 ? ` ctrl+${i + 1}` : ''}` }));
    if (!useSlack.getState().status.connected) cmd('slack:connect', 'Slack: connect…', 'MessageSquare', () => openSettings('slack'), { keywords: 'slack token send message' });
    cmd('tubes', prefs.flowLinks ? 'Scene: lines with comets' : 'Scene: flowing tubes', 'Orbit', () => st().setPrefs({ flowLinks: !prefs.flowLinks }), { keywords: 'connections links' });
    if (prefs.inputMode === 'terminal') cmd('compact', prefs.compactTerminal ? 'Terminal: show all of it' : 'Terminal: show only Claude’s input area', 'SquareTerminal', () => st().setPrefs({ compactTerminal: !prefs.compactTerminal }), { keywords: 'compact' });
    return out;
  }, [sessions, focus, overview, cursor, viewer, prefs, hosted, voice, voiceKey, webShown, history, explains, presets, notes]);
}

/** Transcript lines matching the query: the focused session's first, then the rest, newest first. */
function useTranscriptHits(query: string): PEntry[] {
  return useMemo(() => {
    const tokens = tokensOf(query);
    if (tokens.join('').length < 3) return [];
    const st = useBrain.getState();
    const ids = Object.keys(st.sessions).sort((a, b) => (a === st.focus ? -1 : b === st.focus ? 1 : st.sessions[b].lastTs - st.sessions[a].lastTs));
    const now = Date.now();
    const hits = searchLines(ids.map((sid) => ({ sessionId: sid, lines: linesOf(sid), boost: sid === st.focus ? 10 : 0 })), tokens, now);
    return hits.slice(0, 40).map((h) => {
      const s = st.sessions[h.sessionId];
      const who = h.line.agentId === 'main' ? (h.line.kind === 'prompt' ? 'you' : 'main') : st.agents[`${h.sessionId}/${h.line.agentId}`]?.label ?? 'subagent';
      return {
        id: `hit:${h.sessionId}:${h.line.id}`,
        group: 'transcript' as const,
        label: h.snippet,
        detail: `${s ? sessionName(s) : ''} · ${who} · ${ago(h.line.ts, now)} ago`,
        pre: { score: h.score, labelHits: h.hits },
        icon: LINE_ICON[h.line.kind] ?? 'Search',
        verb: 'show in transcript',
        fleeting: true,
        run: () => jumpTo(h.sessionId, h.line),
      };
    });
  }, [query]);
}

// ---------------------------------------------------------------- the view

function Hl({ text, hits }: { text: string; hits: number[] }) {
  if (!hits.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [a, b] of runs(hits)) {
    if (a >= text.length) break;
    if (a > at) parts.push(text.slice(at, a));
    parts.push(<mark key={a}>{text.slice(a, b)}</mark>);
    at = b;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

function Palette() {
  const [q, setQ] = useState('');
  // names rank on every keystroke (Enter must act on what's on screen for what you typed); only the transcript scan,
  // the costly part, may lag a keystroke behind
  const deferred = useDeferredValue(q);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recent, setRecent] = useState(loadRecent);
  const entries = useEntries();
  const hits = useTranscriptHits(deferred);
  const query = q;
  // the session you're in isn't somewhere to go
  const here = useBrain((s) => (s.focus && !s.overview ? `session:${s.focus}` : null));
  const groups = useMemo(() => rank<PEntry>([...entries, ...hits], query, { recent: recent.filter((id) => id !== here) }), [entries, hits, query, recent, here]);
  const flat = useMemo(() => groups.flatMap((g, gi) => g.items.map((r) => ({ ...r, gi }))), [groups]);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setActive(0), [query]);
  useEffect(() => setActive((a) => Math.min(a, Math.max(0, flat.length - 1))), [flat.length]);
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = async (e: PEntry, alt: boolean) => {
    if (busy) return;
    if (!e.fleeting) {
      const next = pushRecent(recent, e.id);
      setRecent(next);
      saveRecent(next);
    }
    const r = e.run(alt && !!e.alt);
    if (r instanceof Promise) {
      setBusy(true);
      setErr(null);
      const fail = await r.catch((x: Error) => x.message);
      setBusy(false);
      if (fail) return setErr(fail);
    }
    closePalette(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const n = flat.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // modals and the viewer underneath listen for Escape too
      closePalette(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      if (n) setActive((a) => Math.max(0, Math.min(n - 1, a + (e.key === 'PageDown' ? 8 : -8))));
    } else if (e.key === 'Tab') {
      // the next (or previous) group's first result
      e.preventDefault();
      if (!n) return;
      const gi = flat[active]?.gi ?? 0;
      const to = (gi + (e.shiftKey ? groups.length - 1 : 1)) % groups.length;
      setActive(flat.findIndex((r) => r.gi === to));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = flat[active];
      if (r) void pick(r.e, e.shiftKey || e.ctrlKey);
    }
  };

  const cur = flat[active]?.e;
  let i = 0;
  return (
    <div className="pal-bg" onMouseDown={() => closePalette(true)}>
      {/* the palette keeps the keyboard: clicks on its rows don't take focus from the search box */}
      <div className="pal" role="dialog" aria-label="Go to anything" onMouseDown={(e) => (e.stopPropagation(), e.target !== input.current && e.preventDefault())}>
        <div className="pal-in">
          <Icon name="Search" size={15} />
          <input
            ref={input}
            autoFocus // at commit, so keys typed right after Ctrl+K land here
            value={q}
            placeholder="Sessions, folders, transcripts, explains, commands…"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => (setQ(e.target.value), setErr(null))}
            onKeyDown={onKey}
            role="combobox"
            aria-expanded
            aria-controls="pal-list"
            aria-activedescendant={flat.length ? `pal-${active}` : undefined}
          />
          {busy ? <span className="pal-busy">starting…</span> : null}
          <kbd>esc</kbd>
        </div>
        <div className="pal-list" id="pal-list" role="listbox" ref={list}>
          {groups.map((g) => (
            <div key={g.id} className="pal-g" role="group" aria-label={GROUP_LABEL[g.id]}>
              <div className="pal-gh">{GROUP_LABEL[g.id]}</div>
              {g.items.map((r) => {
                const at = i++;
                const e = r.e;
                return (
                  <div
                    key={e.id}
                    id={`pal-${at}`}
                    data-i={at}
                    role="option"
                    aria-selected={at === active}
                    className={`pal-row${at === active ? ' on' : ''}`}
                    onMouseMove={() => at !== active && setActive(at)}
                    onClick={(ev) => void pick(e, ev.shiftKey || ev.ctrlKey)}
                  >
                    <span className="pal-ic">
                      {e.dot ? (
                        <span className={`dl-tile ${TILE_OF[e.dot] ?? ''}`} style={{ ['--sc' as any]: e.color }}>
                          {(e.label.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()}
                          <i />
                        </span>
                      ) : (
                        <Icon name={e.icon ?? 'Circle'} size={15} />
                      )}
                    </span>
                    <span className="pal-main">
                      <span className="pal-l"><Hl text={e.label} hits={r.labelHits} /></span>
                      {e.detail ? <span className="pal-d"><Hl text={e.detail} hits={r.detailHits} /></span> : null}
                    </span>
                    {e.tag ? <span className={`pal-tag t-${e.tag.replace(/\s/g, '-')}`}>{e.tag}</span> : null}
                  </div>
                );
              })}
            </div>
          ))}
          {!flat.length ? <div className="pal-empty">{q.trim() ? 'Nothing matches.' : 'Type to search.'}</div> : null}
        </div>
        <div className="pal-f">
          {err ? (
            <span className="pal-err">{err}</span>
          ) : (
            <>
              <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
              <span><kbd>tab</kbd> next group</span>
              {cur ? <span><kbd>↵</kbd> {cur.verb}</span> : null}
              {cur?.alt ? <span><kbd>⇧↵</kbd> {cur.alt}</span> : null}
            </>
          )}
          <span className="spacer" />
          {query.trim() && tokensOf(query).join('').length < 3 ? <span className="dim">3+ letters search transcripts</span> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Always mounted: Ctrl+K anywhere opens the palette (captured before the terminal sees it; a page in the built-in
 * browser forwards it from the desktop app). An element that wants Ctrl+K for itself marks a container with
 * `data-own-ctrl-k`. Also hosts the end-session confirm the palette can ask for.
 */
export function PaletteHost() {
  const open = usePalette((s) => s.open);
  const ending = usePalette((s) => s.ending);
  const s = useBrain((st) => (ending ? st.sessions[ending] : undefined));
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      if ((e.target as HTMLElement | null)?.closest?.('[data-own-ctrl-k]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) openPalette();
    };
    window.addEventListener('keydown', down, true);
    const off = desktop?.onWebTab?.((m) => m.key === 'k' && openPalette(true));
    return () => {
      window.removeEventListener('keydown', down, true);
      off?.();
    };
  }, []);
  return (
    <>
      {open ? <Palette /> : null}
      {s ? <EndSessionConfirm s={s} onClose={() => usePalette.setState({ ending: null })} /> : null}
    </>
  );
}
