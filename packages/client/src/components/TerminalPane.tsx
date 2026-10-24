import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { choiceOpen, isShell, type TerminalInfo } from '@cora/shared';
import { useBrain } from '../state/store';
import { checkRunning, launchTerminal } from '../state/ws';
import { closeShell, loadShellKinds, openShell, shellBusy, useShells, useTermView } from '../state/shells';
import { activeTab, afterClose, atPrompt, commandAt, shellLabel } from '../lib/shellTabs';
import { ago, sessionName, shortCwd } from '../lib/format';
import { activeRegion } from '../lib/termRegion';
import { desktop } from '../lib/desktop';
import { oops } from '../state/oops';
import { Icon } from './Icon';

/** Each terminal's size as its pane last set it: a read-only mirror (the live board's Terminal panel) draws at the same. */
export const useTermSizes = create<Record<string, { cols: number; rows: number }>>(() => ({}));

export const THEME = {
  background: '#05080d',
  foreground: '#d7dde8',
  cursor: '#38bdf8',
  cursorAccent: '#05080d',
  selectionBackground: '#1e3a5f',
  // its scrollbar as the rest of Cora's (the thumb design.css calls --scroll-thumb; a little lighter held)
  scrollbarSliderBackground: '#1d2430',
  scrollbarSliderHoverBackground: '#2a3442',
  scrollbarSliderActiveBackground: '#334155',
  black: '#1e293b', red: '#f87171', green: '#34d399', yellow: '#fbbf24', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#cbd5e1',
  brightBlack: '#475569', brightRed: '#fca5a5', brightGreen: '#6ee7b7', brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#e9d5ff', brightCyan: '#67e8f9', brightWhite: '#f8fafc',
};

/** Rows of the PTY in compact mode: Claude Code lays out a normal-sized screen; we show only its input area. */
const COMPACT_ROWS = 24;

async function readClipboard(): Promise<{ text: string; image: boolean }> {
  if (desktop?.readClipboard) return desktop.readClipboard();
  try {
    return { text: await navigator.clipboard.readText(), image: false };
  } catch {
    return { text: '', image: false };
  }
}
function writeClipboard(text: string) {
  if (desktop?.writeClipboard) desktop.writeClipboard(text);
  else void navigator.clipboard?.writeText(text).catch(() => {});
}

/**
 * xterm.js attached to a PTY hosted by the Cora server: the session's Claude, or one of its shells. Tabs not on show
 * stay mounted (hidden), so switching back is instant and a shell can flag output you haven't seen.
 */
export function LiveTerminal({ terminal, compact, shown = true, sized = false, onChoice }: {
  terminal: TerminalInfo;
  compact: boolean;
  shown?: boolean;
  /** keep it sized to the pane while hidden (Claude's, hidden in composer mode: it shows itself for a choice) */
  sized?: boolean;
  /** Claude Code started or stopped showing a choice (a permission prompt, a question, a picker) */
  onChoice?: (open: boolean) => void;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const compactRef = useRef(compact);
  const shownRef = useRef(shown);
  const sizedRef = useRef(sized);
  const choiceRef = useRef(onChoice);
  sizedRef.current = sized;
  choiceRef.current = onChoice;
  const relayout = useRef<() => void>(() => {});
  const focus = useRef<() => void>(() => {});
  compactRef.current = compact;
  shownRef.current = shown;
  const shell = isShell(terminal);

  useEffect(() => {
    const term = new Terminal({ fontFamily: '"Cascadia Mono", Consolas, ui-monospace, monospace', fontSize: 12.5, lineHeight: 1.15, theme: THEME, cursorBlink: true, scrollback: 8000, allowProposedApi: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    // The server can restart under a live terminal (the terminal itself keeps running in the terminal host):
    // reconnect, clear, and let the server replay the scrollback.
    let ws: WebSocket | null = null;
    let disposed = false;
    let ended = false;
    let retry = 0;
    let retryTimer = 0;
    const send = (m: object) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
    const cellH = () => (term as any)._core?._renderService?.dimensions?.css?.cell?.height || Math.ceil(12.5 * 1.15);

    // Compact: show only Claude's input area (it grows for menus and dialogs). And say when a choice comes up or
    // goes (gone for a moment first: Claude Code redraws in pieces).
    let raf = 0;
    let choice = false;
    let choiceOff = 0;
    const layoutCompact = () => {
      raf = 0;
      const b = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < term.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
      if (choiceRef.current) {
        const open = choiceOpen(lines);
        if (open) {
          clearTimeout(choiceOff);
          choiceOff = 0;
          if (!choice) choiceRef.current((choice = true));
        } else if (choice && !choiceOff) {
          choiceOff = window.setTimeout(() => {
            choiceOff = 0;
            choiceRef.current?.((choice = false));
          }, 400);
        }
      }
      if (!compactRef.current || !outer.current || !host.current) return;
      const { start, end } = activeRegion(lines);
      const h = cellH();
      outer.current.style.height = `${(end - start + 1) * h + 10}px`;
      host.current.style.transform = `translateY(${-start * h}px)`;
    };
    const scheduleCompact = () => {
      if (!raf) raf = requestAnimationFrame(layoutCompact);
    };

    const refit = () => {
      if (!(shownRef.current || sizedRef.current) || !outer.current?.clientWidth) return; // a hidden tab: sized when it's shown
      try {
        if (compactRef.current) {
          host.current!.style.height = `${COMPACT_ROWS * cellH() + 4}px`;
          const dims = fit.proposeDimensions();
          if (dims && (dims.cols !== term.cols || term.rows !== COMPACT_ROWS)) term.resize(dims.cols, COMPACT_ROWS);
          scheduleCompact();
        } else {
          host.current!.style.height = '';
          host.current!.style.transform = '';
          if (outer.current) outer.current.style.height = '';
          fit.fit();
        }
      } catch {
        /* not laid out yet */
      }
      send({ t: 'resize', cols: term.cols, rows: term.rows });
      const had = useTermSizes.getState()[terminal.terminalId];
      if (had?.cols !== term.cols || had?.rows !== term.rows) useTermSizes.setState({ [terminal.terminalId]: { cols: term.cols, rows: term.rows } });
    };
    relayout.current = refit;
    focus.current = () => term.focus();
    // a shell's tab is named after what runs in it (the title its terminal reports)
    const titleSub = term.onTitleChange((t) => shell && useShells.getState().setTitle(terminal.terminalId, t));
    // the line at the cursor (joined with the rows it wrapped from), up to the cursor if asked
    const cursorLine = (toCursor = false) => {
      const b = term.buffer.active;
      let y = b.baseY + b.cursorY;
      let line = b.getLine(y)?.translateToString(!toCursor, 0, toCursor ? b.cursorX : undefined) ?? '';
      while (y > 0 && b.getLine(y)?.isWrapped) line = (b.getLine(--y)?.translateToString(false) ?? '') + line;
      return line;
    };
    // a whole logical line from its first row
    const lineAt = (y: number) => {
      const b = term.buffer.active;
      let line = b.getLine(y)?.translateToString(false) ?? '';
      while (b.getLine(y + 1)?.isWrapped) line += b.getLine(++y)?.translateToString(false) ?? '';
      return line.trimEnd();
    };
    // What a shell is running, for its tab: the command you submitted at its prompt, read again once the shell has
    // redrawn that line (PowerShell greys a guess in after the cursor while you type), until a prompt is back.
    let cmdRow = -1;
    let promptCheck = 0;
    const checkCommand = () => {
      const { setRunning } = useShells.getState();
      if (cmdRow >= 0) {
        const cmd = commandAt(lineAt(cmdRow));
        if (cmd) setRunning(terminal.terminalId, cmd);
        cmdRow = -1;
      }
      if (useShells.getState().running[terminal.terminalId] && atPrompt(cursorLine())) setRunning(terminal.terminalId, null);
    };
    if (shell) shellBusy.set(terminal.terminalId, () => !ended && !atPrompt(cursorLine()));
    // output in the first moments after (re)connecting is the scrollback replay, not news
    let replayUntil = 0;

    const connect = (again: boolean) => {
      const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/pty/${terminal.terminalId}`);
      ws = sock;
      sock.onopen = () => {
        retry = 0;
        replayUntil = Date.now() + 400;
        if (again) term.reset(); // the server replays the scrollback from the start
        refit();
        if (!again && shownRef.current) term.focus();
      };
      sock.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.t === 'out') {
          term.write(msg.d, scheduleCompact);
          if (shell && !shownRef.current && Date.now() > replayUntil) useShells.getState().markUnread(terminal.terminalId);
          if (shell && (cmdRow >= 0 || useShells.getState().running[terminal.terminalId])) {
            clearTimeout(promptCheck);
            promptCheck = window.setTimeout(checkCommand, 150);
          }
        } else if (msg.t === 'exit') {
          ended = true;
          term.write(`\r\n\x1b[90m[${shell ? 'shell exited' : 'session ended'}${msg.code ? ` · exit ${msg.code}` : ''}]\x1b[0m\r\n`, scheduleCompact);
        }
      };
      sock.onclose = () => {
        if (disposed || ended) return;
        retryTimer = window.setTimeout(() => connect(true), Math.min(5000, 300 * 2 ** retry++));
      };
    };
    connect(false);
    const sub = term.onData((d) => {
      // Enter at a shell's prompt: name the tab after the command now, and again once the shell has redrawn it
      if (shell && d.includes('\r')) {
        // (typed fast, the echo may not be back yet: a bare prompt still counts)
        const line = cursorLine(true);
        const cmd = commandAt(line);
        if (cmd || atPrompt(line)) {
          if (cmd) useShells.getState().setRunning(terminal.terminalId, cmd);
          const b = term.buffer.active;
          let y = b.baseY + b.cursorY;
          while (y > 0 && b.getLine(y)?.isWrapped) y--;
          cmdRow = y;
        }
      }
      send({ t: 'in', d });
    });

    // Clipboard, Windows Terminal style: Ctrl+V / Ctrl+Shift+V paste (bracketed, via term.paste);
    // Ctrl+C copies when text is selected (otherwise it's an interrupt); Ctrl+Shift+C always copies.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true;
      const k = e.key.toLowerCase();
      if (k === 'v') {
        // paste ourselves (one deterministic path in browser and desktop; detects image-only clipboards)
        e.preventDefault();
        void readClipboard().then((c) => {
          if (c.text) term.paste(c.text);
          else if (c.image && !shell) send({ t: 'in', d: '\x1bv' });
        });
        return false;
      }
      if (k === 'c' && (e.shiftKey || term.hasSelection())) {
        const sel = term.getSelection();
        if (sel) writeClipboard(sel);
        term.clearSelection();
        e.preventDefault();
        return false;
      }
      return true;
    });
    // A paste with only an image: let Claude Code read the clipboard itself (Alt+V on Windows).
    const onPaste = (e: ClipboardEvent) => {
      const dt = e.clipboardData;
      if (!shell && dt && !dt.getData('text/plain') && [...dt.items].some((i) => i.type.startsWith('image/'))) {
        e.preventDefault();
        e.stopPropagation();
        send({ t: 'in', d: '\x1bv' });
      }
    };
    // Right-click: copy the selection if there is one, otherwise paste.
    const onContext = async (e: MouseEvent) => {
      e.preventDefault();
      if (term.hasSelection()) {
        writeClipboard(term.getSelection());
        term.clearSelection();
        return;
      }
      const c = await readClipboard();
      if (c.text) term.paste(c.text);
      else if (c.image && !shell) send({ t: 'in', d: '\x1bv' });
      term.focus();
    };
    const el = host.current!;
    el.addEventListener('paste', onPaste, true);
    el.addEventListener('contextmenu', onContext);

    const ro = new ResizeObserver(() => requestAnimationFrame(refit));
    ro.observe(outer.current!);
    return () => {
      ro.disconnect();
      sub.dispose();
      titleSub.dispose();
      shellBusy.delete(terminal.terminalId);
      el.removeEventListener('paste', onPaste, true);
      el.removeEventListener('contextmenu', onContext);
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(choiceOff);
      if (choice) choiceRef.current?.(false);
      disposed = true;
      clearTimeout(retryTimer);
      clearTimeout(promptCheck);
      ws?.close();
      term.dispose();
    };
  }, [terminal.terminalId]);

  useEffect(() => relayout.current(), [compact, sized]);
  // shown again: size it to the pane (it may have changed meanwhile) and type into it (unless you're typing elsewhere,
  // say in the composer, when it shows itself for a question)
  useEffect(() => {
    if (!shown) return;
    const raf = requestAnimationFrame(() => {
      relayout.current();
      const el = document.activeElement;
      if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) || el.classList.contains('xterm-helper-textarea')) focus.current();
    });
    return () => cancelAnimationFrame(raf);
  }, [shown]);

  return (
    <div className={`term-window${compact ? ' compact' : ''}${shown ? '' : ' hidden'}`} ref={outer}>
      <div className="xterm-host" ref={host} />
    </div>
  );
}

/** Shown for sessions Cora doesn't host: resume or fork them here. */
function ExternalPanel({ sessionId }: { sessionId: string }) {
  const s = useBrain((st) => st.sessions[sessionId]);
  const [phase, setPhase] = useState<'idle' | 'checking' | 'confirm' | 'blocked' | 'launching'>('idle');
  const [err, setErr] = useState<string | null>(null);
  if (!s) return null;
  const recentlyActive = Date.now() - s.lastTs < 3 * 60_000 && s.state !== 'ended' && s.state !== 'idle';

  const go = async (mode: 'resume' | 'fork') => {
    setPhase('launching');
    const r = await launchTerminal({ mode, sessionId });
    if (!r.ok) {
      setErr(r.error);
      setPhase('idle');
    }
  };
  const askResume = async () => {
    setErr(null);
    setPhase('checking');
    const r = await checkRunning(sessionId);
    setPhase(r.elsewhere ? 'blocked' : 'confirm');
  };

  return (
    <div className="ext-panel">
      <div className="ext-h">
        <Icon name="Eye" size={14} /> <b>Started in another terminal</b>
      </div>
      {phase === 'blocked' ? (
        <p className="warn"><Icon name="TriangleAlert" size={12} /> It's still running in another terminal. Exit it there first, or fork a copy to continue separately.</p>
      ) : phase === 'confirm' ? (
        <p className={recentlyActive ? 'warn' : 'dim'}>
          {recentlyActive ? `It was active ${ago(s.lastTs)} ago, so it's probably still open somewhere. ` : ''}
          Make sure it isn't open in another terminal: resuming it in two places splits the conversation.
        </p>
      ) : (
        <p className="dim">You can read it here. Resume it here to type into it; its history stays in the transcript above.</p>
      )}
      <div className="ext-actions">
        {phase === 'confirm' ? (
          <>
            <button className="btn allow" onClick={() => go('resume')}><Icon name="Play" size={12} /> Resume here</button>
            <button className="btn ghost" onClick={() => setPhase('idle')}>Cancel</button>
          </>
        ) : (
          <button className="btn allow" disabled={phase === 'blocked' || phase === 'checking' || phase === 'launching'} onClick={askResume}>
            <Icon name="Play" size={12} /> {phase === 'checking' ? 'Checking…' : phase === 'launching' ? 'Starting…' : 'Resume here'}
          </button>
        )}
        <button className="btn ghost" disabled={phase === 'launching'} onClick={() => go('fork')} title="Continue in a new copy of this conversation; the original is untouched">
          <Icon name="GitBranch" size={12} /> Fork a copy
        </button>
      </div>
      {err ? <div className="ny-err">{err}</div> : null}
    </div>
  );
}

const NEW_SHELL_KEY = 'Ctrl+Shift+`';

/** A shell's tab: named after what runs in it; a dot for output you haven't seen; × (or a middle click) closes it. */
function ShellTab({ t, on, session, onShow, onClose }: { t: TerminalInfo; on: boolean; session: string; onShow(): void; onClose(): void }) {
  const title = useShells((s) => s.titles[t.terminalId]);
  const running = useShells((s) => s.running[t.terminalId]);
  const unread = useShells((s) => !!s.unread[t.terminalId]);
  const label = shellLabel(running ?? title, t.shell);
  return (
    <div
      className={`term-tab${on ? ' on' : ''}${t.alive ? '' : ' dead'}`}
      title={`${label} · ${session} · ${t.cwd}${t.alive ? '' : ` · exited${t.exitCode ? ` (${t.exitCode})` : ''}`}`}
      onClick={onShow}
      onAuxClick={(e) => e.button === 1 && onClose()}
    >
      <Icon name="Terminal" size={11} />
      <span className="tt-t">{label}</span>
      {unread && !on ? <span className="tt-dot" /> : null}
      <button
        className="tt-x"
        title="Close this shell"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <Icon name="X" size={11} />
      </button>
    </div>
  );
}

export function TerminalPane({ sessionId }: { sessionId: string }) {
  const terminals = useBrain((s) => s.terminals);
  const allShells = useBrain((s) => s.shells);
  const expanded = useBrain((s) => s.expanded);
  const toggleExpanded = useBrain((s) => s.toggleExpanded);
  const session = useBrain((s) => s.sessions[sessionId]);
  const needsYou = (session?.needsYou ?? 0) > 0;
  const mine = terminals.filter((t) => t.sessionId === sessionId);
  const live = mine.find((t) => t.alive);
  const last = live ?? mine[mine.length - 1];
  const [relaunching, setRelaunching] = useState(false);
  const compactPref = useBrain((s) => s.prefs.compactTerminal);
  const mode = useBrain((s) => s.prefs.inputMode);
  const setPrefs = useBrain((s) => s.setPrefs);
  const view = useTermView(sessionId);
  const setPeek = (on: boolean) => useShells.getState().setPeek(sessionId, on);
  const onChoice = (open: boolean) => useShells.getState().setAsking(sessionId, open);
  // (the Board's Terminal panels have shells of their own: they stay there)
  const shells = useMemo(() => allShells.filter((t) => t.sessionId === sessionId && t.place !== 'board'), [allShells, sessionId]);
  const ids = shells.map((t) => t.terminalId);
  const remembered = useShells((s) => s.active[sessionId]);
  const titles = useShells((s) => s.titles);
  const running = useShells((s) => s.running);
  const tab = activeTab(remembered, ids);
  const show = (t: string) => useShells.getState().show(sessionId, t);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const confirming = shells.find((t) => t.terminalId === confirm);

  const newShell = async (kind?: string) => {
    setErr(null);
    setKindMenu(false);
    const e = await openShell(sessionId, kind);
    if (e) setErr(e);
  };
  // which shell: a menu beside + (as Windows Terminal's), the default ticked
  // where it shows: just above the ⌄ (on the screen, so the tab strip can't clip it)
  const [kindMenu, setKindMenu] = useState<{ left: number; bottom: number } | false>(false);
  const kinds = useShells((s) => s.kinds);
  const defaultShell = useBrain((s) => s.prefs.defaultShell);
  const def = kinds?.find((k) => k.id === defaultShell) ?? kinds?.[0];
  const openKinds = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (kindMenu) return setKindMenu(false);
    const r = e.currentTarget.getBoundingClientRect();
    setKindMenu({ left: Math.max(8, r.left - 24), bottom: window.innerHeight - r.top + 4 });
    void loadShellKinds();
  };
  const close = async (id: string, sure = false) => {
    // something still running in it (a dev server, a build): ask first
    if (!sure && shellBusy.get(id)?.()) {
      setConfirm(id);
      return;
    }
    setConfirm(null);
    if (tab === id) show(afterClose(id, ids));
    const e = await closeShell(id);
    if (e) setErr(e);
  };
  useEffect(() => {
    setConfirm(null);
    setErr(null);
  }, [sessionId]);
  // a peek lasts until you hide it or go to another session
  useEffect(() => () => useShells.getState().setPeek(sessionId, false), [sessionId]);

  // Ctrl+Shift+` opens a shell for this session (captured, so it works with a terminal focused too)
  const newShellRef = useRef(newShell);
  newShellRef.current = newShell;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.code !== 'Backquote') return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) void newShellRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const name = session ? sessionName(session) : sessionId.slice(0, 8);
  // composer mode, Claude's tab picked but its terminal hidden: just this bar
  const hiddenClaude = tab === 'claude' && !view.claudeShown;
  const status = !live ? (last ? 'session ended' : 'not hosted') : view.asking && view.composer && !view.peek ? 'asking you' : view.composer && !view.peek ? 'hidden' : 'hosted here';
  return (
    <section className={`term-pane${hiddenClaude ? ' collapsed' : ''}`}>
      <div className="term-h">
        <div className="term-tabs">
          <div
            className={`term-tab${tab === 'claude' ? ' on' : ''}`}
            title={view.composer ? (view.peek ? `Claude · ${name} · click to hide its terminal` : `Claude · ${name} · click to show its terminal`) : `Claude · ${name}`}
            // in composer mode, its tab picked again shows or hides its terminal
            onClick={() => (tab === 'claude' && view.composer ? setPeek(!view.peek) : show('claude'))}
          >
            <Icon name="SquareTerminal" size={12} />
            <span className="tt-t">Claude</span>
            {view.composer && tab === 'claude' ? <Icon name={view.peek ? 'ChevronDown' : 'ChevronRight'} size={11} className="tt-peek" /> : null}
            {needsYou && tab !== 'claude' ? <span className="tt-dot needs" /> : null}
          </div>
          {shells.map((t) => (
            <ShellTab key={t.terminalId} t={t} on={tab === t.terminalId} session={name} onShow={() => show(t.terminalId)} onClose={() => void close(t.terminalId)} />
          ))}
          <span className="tt-new">
            <button className="icon-btn" title={`New ${def?.name ?? 'shell'} in ${session?.cwd ? shortCwd(session.cwd) : "this session's folder"} (${NEW_SHELL_KEY})`} onClick={() => void newShell()}>
              <Icon name="Plus" size={13} />
            </button>
            <button className="icon-btn tt-kinds" title="Open another kind of shell" onClick={openKinds}>
              <Icon name="ChevronDown" size={12} />
            </button>
            {kindMenu ? (
              <div className="tt-menu" style={kindMenu} onMouseLeave={() => setKindMenu(false)}>
                {!kinds ? <span className="tt-menu-note">Looking…</span> : null}
                {kinds?.map((k) => (
                  <button key={k.id} onClick={() => void newShell(k.id)}>
                    <Icon name="Terminal" size={12} />
                    <span className="tt-menu-n">{k.name}</span>
                    {k.id === def?.id ? <span className="tt-menu-d">default</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </span>
        </div>
        {tab === 'claude' && status !== 'hosted here' && status !== 'hidden' ? <span className={`term-st${status === 'asking you' ? ' ask' : ''}`}>{status}</span> : null}
        <span className="spacer" />
        {tab === 'claude' && last && !live ? (
          <button
            className="mini live"
            disabled={relaunching}
            onClick={async () => {
              setRelaunching(true);
              const r = await launchTerminal({ mode: 'resume', sessionId });
              setRelaunching(false);
              if (!r.ok) oops("Couldn't resume it", r.error);
            }}
          >
            ⏵ resume again
          </button>
        ) : null}
        {tab === 'claude' && last && !view.composer ? (
          <button className={`icon-btn${compactPref ? ' on' : ''}`} title={compactPref ? 'Show the full terminal' : "Input only: show just Claude's input area"} onClick={() => setPrefs({ compactTerminal: !compactPref })}>
            <Icon name={compactPref ? 'UnfoldVertical' : 'FoldVertical'} size={13} />
          </button>
        ) : null}
        {live ? (
          <div className="term-mode" role="radiogroup" aria-label="Write prompts in">
            <button
              role="radio"
              aria-checked={mode === 'composer'}
              className={mode === 'composer' ? 'on' : ''}
              title="Write prompts in the composer; Claude's terminal stays hidden and shows itself when Claude Code asks you something"
              onClick={() => (setPrefs({ inputMode: 'composer' }), setPeek(false))}
            >
              <Icon name="PenLine" size={12} />
              <span className="tm-l">Composer</span>
            </button>
            <button role="radio" aria-checked={mode === 'terminal'} className={mode === 'terminal' ? 'on' : ''} title="Write prompts in Claude's terminal" onClick={() => setPrefs({ inputMode: 'terminal' })}>
              <Icon name="SquareTerminal" size={12} />
              <span className="tm-l">Terminal</span>
            </button>
          </div>
        ) : null}
        <button className="icon-btn" title={expanded ? 'Narrow the right column' : 'Widen the right column'} onClick={toggleExpanded}>
          <Icon name={expanded ? 'Minimize2' : 'Maximize2'} size={12} />
        </button>
      </div>
      {confirming ? (
        <div className="term-confirm">
          <Icon name="TriangleAlert" size={12} />
          <span>
            Something may still be running in <b>{shellLabel(running[confirming.terminalId] ?? titles[confirming.terminalId], confirming.shell)}</b>. Closing ends it.
          </span>
          <span className="spacer" />
          <button className="btn deny" onClick={() => void close(confirming.terminalId, true)}>End it</button>
          <button className="btn ghost" onClick={() => setConfirm(null)}>Keep</button>
        </div>
      ) : null}
      {err ? <div className="term-confirm err">{err}</div> : null}
      <div className="term-stack">
        {last ? (
          <LiveTerminal key={last.terminalId} terminal={last} compact={view.claudeCompact} shown={tab === 'claude' && view.claudeShown} sized={view.composer} onChoice={live ? onChoice : undefined} />
        ) : tab === 'claude' ? (
          <ExternalPanel sessionId={sessionId} />
        ) : null}
        {shells.map((t) => (
          <LiveTerminal key={t.terminalId} terminal={t} compact={false} shown={tab === t.terminalId} />
        ))}
      </div>
    </section>
  );
}
