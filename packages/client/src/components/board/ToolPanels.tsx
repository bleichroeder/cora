import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { useBrain } from '../../state/store';
import { closeShell, loadShellKinds, openBoardShell, useShells } from '../../state/shells';
import { desktop } from '../../lib/desktop';
import { LiveTerminal, THEME, useTermSizes } from '../TerminalPane';
import { shellsOf, type BoardItem } from '../../lib/boardLayout';
import { Icon } from '../Icon';
import { PanelBrowser } from '../WebPane';

/* ------------------------------------------------------------------ Terminal */

/**
 * The session's terminal (Claude's, or one of its shells), live, to watch (the Spotlight shows it when Claude asks): drawn at the size its pane gives it and
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

/**
 * The Board's Terminal panel: shells of its own (not Claude's, not the session's terminal tabs), in the session's folder,
 * to type in, as tabs like the terminal area's: one, or several of any kinds (PowerShell, Command Prompt, Git Bash, a WSL
 * distro…). A new panel opens one of your default kind (PowerShell, unless you chose another); + opens another; a tab's
 * x ends it. Closing the panel ends them all.
 */
export function BoardTerminal({ sessionId, item, onUpdate }: { sessionId: string; item: BoardItem; onUpdate(p: BoardItem): void }) {
  const ids = shellsOf(item);
  const all = useBrain((s) => s.shells);
  const live = useMemo(() => ids.map((id) => all.find((t) => t.terminalId === id && t.alive)).filter((t): t is NonNullable<typeof t> => !!t), [all, ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = useBrain((s) => s.ready);
  const cwd = useBrain((s) => s.sessions[sessionId]?.cwd);
  const fallback = useBrain((s) => s.prefs.defaultShell);
  const titles = useShells((s) => s.titles);
  const kinds = useShells((s) => s.kinds);
  useEffect(() => void loadShellKinds(), []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const on = live.find((t) => t.terminalId === item.term) ?? live[0];
  // shells that ended (typed exit, closed elsewhere): their tabs go
  useEffect(() => {
    if (!ready || live.length === ids.length) return;
    onUpdate({ ...item, terms: live.map((t) => t.terminalId), term: on?.terminalId });
  }, [ready, live.length, ids.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = async (kind?: string) => {
    setMenu(false);
    setBusy(true);
    setErr(null);
    const r = await openBoardShell(sessionId, kind);
    setBusy(false);
    if ('error' in r) return setErr(r.error);
    onUpdate({ ...item, terms: [...live.map((t) => t.terminalId), r.id], term: r.id });
  };
  const close = (id: string) => {
    void closeShell(id);
    const rest = live.filter((t) => t.terminalId !== id);
    const i = live.findIndex((t) => t.terminalId === id);
    onUpdate({ ...item, terms: rest.map((t) => t.terminalId), term: id === on?.terminalId ? (rest[i] ?? rest[i - 1])?.terminalId : on?.terminalId });
  };
  // your default kind; none chosen: PowerShell (7, else Windows'), else the first there is
  const def = kinds?.find((k) => k.id === fallback)?.id ?? kinds?.find((k) => /pwsh/i.test(k.id))?.id ?? kinds?.find((k) => /powershell/i.test(`${k.id} ${k.name}`))?.id ?? kinds?.[0]?.id;
  // its kind (a shell's title is mostly its own path)
  const name = (t: (typeof live)[number]) => t.shell || titles[t.terminalId] || 'Shell';
  // a panel just added (it's never had a terminal): one opens at once, of your default kind
  const fresh = item.terms === undefined && !item.term;
  const started = useRef(false);
  useEffect(() => {
    if (!fresh || started.current || !kinds) return;
    started.current = true;
    void add(def);
  }, [fresh, kinds]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!live.length && ids.length && !ready) return null;
  return (
    <div className="lb-bterm">
      <div className="lb-ttabs" role="tablist">
        {live.map((t) => (
          <span key={t.terminalId} role="tab" aria-selected={t === on} className={`lb-ttab${t === on ? ' on' : ''}`} title={`${name(t)} · ${t.cwd}`} onClick={() => onUpdate({ ...item, terms: live.map((x) => x.terminalId), term: t.terminalId })}>
            <Icon name="SquareTerminal" size={12} />
            <span className="nm">{name(t)}</span>
            <span className="x" role="button" aria-label={`End ${name(t)}`} title="End this terminal" onClick={(e) => (e.stopPropagation(), close(t.terminalId))}>
              <Icon name="X" size={11} />
            </span>
          </span>
        ))}
        <span className="lb-tnew">
          <button className="lb-tadd" title="Another terminal" disabled={busy} onClick={() => setMenu(!menu)}>
            <Icon name="Plus" size={13} />
            <Icon name="ChevronDown" size={10} />
          </button>
          {menu ? (
            <span className="lb-tmenu" onMouseLeave={() => setMenu(false)}>
              {(kinds ?? []).map((k) => (
                <button key={k.id} onClick={() => void add(k.id)}>
                  {k.name}
                  {k.id === def ? <em>default</em> : null}
                </button>
              ))}
            </span>
          ) : null}
        </span>
        {err ? <em className="lb-terr">{err}</em> : null}
      </div>
      <div className="lb-tbody">
        {live.map((t) => (
          <LiveTerminal key={t.terminalId} terminal={t} compact={false} shown={t === on} />
        ))}
        {!live.length ? (
          <div className="lb-tnone">
            <Icon name="SquareTerminal" size={22} />
            <b>{(fresh || busy) && !err ? 'Opening a terminal…' : 'No terminals open'}</b>
            {(fresh || busy) && !err ? null : <span>+ above opens one{cwd ? `, in ${cwd}` : ''}.</span>}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Browser */

/** The board's Browser panel: a browser of its own (WebPane's PanelBrowser), apart from the session's. */
export function BrowserPanel({ sessionId }: { sessionId: string }) {
  if (!desktop?.browser) return <div className="lb-empty">The browser is in Cora's desktop app.</div>;
  return (
    <div className="lb-browser own">
      <PanelBrowser sessionId={sessionId} />
    </div>
  );
}

