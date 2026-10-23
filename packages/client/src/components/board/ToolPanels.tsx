import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { useBrain } from '../../state/store';
import { useShells } from '../../state/shells';
import { useWeb } from '../../state/web';
import { dockBrowser, useBoardDock } from '../../state/boardDock';
import { desktop } from '../../lib/desktop';
import { THEME, useTermSizes } from '../TerminalPane';

/* ------------------------------------------------------------------ Terminal */

/**
 * The session's terminal (Claude's, or one of its shells), live, to watch: drawn at the size its pane gives it and
 * scaled to fit, so it reads as it does there. Typing stays in the terminal pane (two places typing into one terminal,
 * or sizing it, would fight).
 */
export function TerminalPanel({ sessionId }: { sessionId: string }) {
  const allClaude = useBrain((s) => s.terminals);
  const allShells = useBrain((s) => s.shells);
  const claude = useMemo(() => allClaude.filter((t) => t.sessionId === sessionId), [allClaude, sessionId]);
  const shells = useMemo(() => allShells.filter((t) => t.sessionId === sessionId), [allShells, sessionId]);
  const titles = useShells((s) => s.titles);
  const live = claude.find((t) => t.alive) ?? claude.at(-1);
  const opts = [...(live ? [{ id: live.terminalId, label: 'Claude' }] : []), ...shells.map((t, i) => ({ id: t.terminalId, label: titles[t.terminalId] || `Shell ${i + 1}` }))];
  const [pick, setPick] = useState<string | null>(null);
  const cur = opts.find((o) => o.id === pick) ?? opts[0];
  if (!cur) return <div className="lb-empty">No terminal here: the session runs in another terminal and has no shells. Open one from the terminal pane.</div>;
  return (
    <div className="lb-term">
      {opts.length > 1 ? (
        <div className="lb-seg">
          {opts.map((o) => (
            <button key={o.id} className={o === cur ? 'on' : ''} onClick={() => setPick(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
      <Mirror key={cur.id} terminalId={cur.id} />
    </div>
  );
}

function Mirror({ terminalId }: { terminalId: string }) {
  const box = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const size = useTermSizes.getState()[terminalId] ?? { cols: 100, rows: 30 };
    const term = new Terminal({ fontFamily: '"Cascadia Mono", Consolas, ui-monospace, monospace', fontSize: 12.5, lineHeight: 1.15, theme: THEME, cursorBlink: false, disableStdin: true, scrollback: 2000, cols: size.cols, rows: size.rows });
    term.open(host.current!);
    // scaled to fit the panel (never larger than it is)
    const fit = () => {
      const screen = host.current?.querySelector('.xterm-screen') as HTMLElement | null;
      const b = box.current;
      if (!screen || !b || !screen.offsetWidth) return;
      const s = Math.min(1, b.clientWidth / screen.offsetWidth, b.clientHeight / screen.offsetHeight);
      host.current!.style.transform = `scale(${s})`;
    };
    const unsize = useTermSizes.subscribe((all) => {
      const z = all[terminalId];
      if (z && (z.cols !== term.cols || z.rows !== term.rows)) {
        term.resize(z.cols, z.rows);
        requestAnimationFrame(fit);
      }
    });
    const ro = new ResizeObserver(fit);
    ro.observe(box.current!);
    // its output as the pane gets it (the server replays the scrollback first); reconnects if the server restarts
    let ws: WebSocket | null = null;
    let disposed = false;
    let ended = false;
    let retry = 0;
    let timer = 0;
    const connect = (again: boolean) => {
      const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/pty/${terminalId}`);
      ws = sock;
      sock.onopen = () => {
        retry = 0;
        if (again) term.reset();
      };
      sock.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.t === 'out') term.write(msg.d);
        else if (msg.t === 'exit') {
          ended = true;
          term.write('\r\n\x1b[90m[ended]\x1b[0m\r\n');
        }
      };
      sock.onclose = () => {
        if (disposed || ended) return;
        timer = window.setTimeout(() => connect(true), Math.min(5000, 300 * 2 ** retry++));
      };
    };
    connect(false);
    requestAnimationFrame(fit);
    return () => {
      disposed = true;
      clearTimeout(timer);
      ws?.close();
      ro.disconnect();
      unsize();
      term.dispose();
    };
  }, [terminalId]);
  return (
    <div className="lb-mirror" ref={box}>
      <div className="host" ref={host} />
    </div>
  );
}

/* ------------------------------------------------------------------ Browser */

/**
 * The session's browser, in a panel: the browser itself lays itself over this panel and follows it (its pages are
 * never moved, which would reload them); showing the panel shows the browser, and taking it away hides it again.
 */
export function BrowserPanel({ sessionId }: { sessionId: string }) {
  const el = useRef<HTMLDivElement>(null);
  const shown = useWeb((w) => !!w.sessions[sessionId]?.shown);
  const wide = useWeb((w) => w.wide);
  useLayoutEffect(() => {
    if (!desktop?.browser || !el.current) return;
    const undock = dockBrowser(sessionId, el.current);
    useWeb.getState().setShown(sessionId, true);
    return () => {
      undock();
      // the last of its panels gone (not a maximised copy closing): put the browser away
      if (!useBoardDock.getState().browser.some((d) => d.sessionId === sessionId)) useWeb.getState().setShown(sessionId, false);
    };
  }, [sessionId]);
  return (
    <div className="lb-browser" ref={el}>
      {!desktop?.browser ? (
        <div className="lb-empty">The browser is in Cora's desktop app.</div>
      ) : !shown ? (
        <div className="lb-empty">
          The browser is hidden.{' '}
          <button className="lb-pop" onClick={() => useWeb.getState().setShown(sessionId, true)}>
            Show it here
          </button>
        </div>
      ) : wide ? (
        <div className="lb-empty">
          The browser is using the whole width.{' '}
          <button className="lb-pop" onClick={() => useWeb.getState().setWide(false)}>
            Back to this panel
          </button>
        </div>
      ) : null}
    </div>
  );
}
