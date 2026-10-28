import { useEffect, useMemo, useRef } from 'react';
import { useRBrowse } from './RemoteBrowser';
import type { SessionInfo } from '@cora/shared';
import { useBrain } from '../state/store';
import { useOrch, setConsoleOpen } from '../state/orchestrator';
import { setInboxOpen } from '../state/inbox';
import { useProjects } from '../state/projects';
import { tabletScene, useTabletChoice, useTabletUi } from '../lib/tablet';
import { sessionColor, sessionName } from '../lib/format';
import { sortedSessions, SessionRail } from './SessionRail';
import { SessionMenu } from './SessionMenu';
import { Icon } from './Icon';
import { useState } from 'react';
import './tablet.css';
import './projects.css';

/**
 * Cora on the iPad: the slim rail (landscape), the full nav as a
 * drawer (☰, or a swipe from the left edge), and the session's views as tabs.
 */
export function TabletRail() {
  const sessions = useBrain((s) => s.sessions);
  const focus = useBrain((s) => s.focus);
  const overview = useBrain((s) => s.overview);
  const inbox = useBrain((s) => s.inbox);
  const projectOpen = useBrain((s) => s.projectOpen);
  const projects = useProjects((p) => p.projects);
  const coraOpen = useOrch((o) => o.open);
  const live = useMemo(() => projects.filter((p) => !p.archivedAt), [projects]);
  // sessions as the nav lists them: a project's first, then the rest (live ones, and ended ones you're looking at)
  const list = useMemo(() => {
    const all = sortedSessions(sessions).filter((s) => s.state !== 'ended' || s.id === focus);
    const inProject = new Set(live.flatMap((p) => p.sessions));
    return [...live.flatMap((p) => p.sessions.map((id) => sessions[id]).filter((s): s is SessionInfo => !!s && (s.state !== 'ended' || s.id === focus))), ...all.filter((s) => !inProject.has(s.id))];
  }, [sessions, live, focus]);
  const [menu, setMenu] = useState<{ s: SessionInfo; x: number; y: number } | null>(null);
  return (
    <nav className="tb-rail">
      <button className="tb-ib" onClick={() => useTabletUi.setState({ drawer: true })} title="Everything (the full nav)" aria-label="Open the nav">
        <Icon name="Menu" size={18} />
      </button>
      <button className={`tb-ib tb-cora${coraOpen ? ' on' : ''}`} onClick={() => setConsoleOpen(!coraOpen)} title="Cora" aria-label="Cora">
        <span className="tb-orb" />
      </button>
      <button className={`tb-ib${overview ? ' on' : ''}`} onClick={() => useBrain.getState().toggleOverview()} title="Cora's board" aria-label="Cora's board">
        <Icon name="LayoutDashboard" size={17} />
      </button>
      <button className={`tb-ib${inbox ? ' on' : ''}`} onClick={() => setInboxOpen(!inbox)} title="Inbox" aria-label="Inbox">
        <Icon name="Inbox" size={17} />
      </button>
      {live.length ? <i className="tb-sep" /> : null}
      {live.map((p) => (
        <button key={p.id} className={`tb-ib tb-proj${projectOpen === p.id ? ' on' : ''}`} style={{ ['--pc' as any]: p.color }} onClick={() => useBrain.getState().openProject(p.id)} title={p.name} aria-label={p.name}>
          <span className="pj-sq" />
        </button>
      ))}
      <i className="tb-sep" />
      <div className="tb-sessions">
        {list.map((s) => (
          <SessionTile key={s.id} s={s} on={focus === s.id && !overview && !projectOpen} onMenu={(x, y) => setMenu({ s, x, y })} />
        ))}
      </div>
      <button className="tb-ib tb-new" onClick={() => useBrain.getState().setModal('new-session')} title="New session" aria-label="New session">
        <Icon name="Plus" size={18} />
      </button>
      {menu ? <SessionMenu s={sessions[menu.s.id] ?? menu.s} x={menu.x} y={menu.y} onClose={() => setMenu(null)} /> : null}
    </nav>
  );
}

/** A session in the rail: its tile and state; tap to open, long-press (or right-click) for its menu. */
function SessionTile({ s, on, onMenu }: { s: SessionInfo; on: boolean; onMenu(x: number, y: number): void }) {
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const long = useRef(false);
  const name = sessionName(s);
  const st = s.state === 'needs-you' ? ' need' : s.state === 'working' || s.state === 'thinking' ? ' work' : s.state === 'ended' ? ' done' : '';
  const project = useProjects((p) => p.projects.find((x) => !x.archivedAt && x.sessions.includes(s.id))?.color);
  return (
    <button
      data-ping={`ses:${s.id}`}
      className={`tb-tile${st}${on ? ' on' : ''}`}
      style={{ ['--sc' as any]: sessionColor(s), ...(project ? { ['--pc' as any]: project } : {}) }}
      title={name}
      aria-label={name}
      onPointerDown={(e) => {
        long.current = false;
        const { clientX: x, clientY: y } = e;
        press.current = setTimeout(() => ((long.current = true), onMenu(x + 12, y)), 520);
      }}
      onPointerUp={() => press.current && clearTimeout(press.current)}
      onPointerLeave={() => press.current && clearTimeout(press.current)}
      onContextMenu={(e) => (e.preventDefault(), onMenu(e.clientX, e.clientY))}
      onClick={() => !long.current && useBrain.getState().setFocus(s.id)}
    >
      {(name.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()}
      <i />
      {project ? <b className="tb-pdot" /> : null}
    </button>
  );
}

/** The full nav, sliding over from the left (☰, or a swipe in from the left edge); a choice in it closes it. */
export function TabletDrawer() {
  const open = useTabletUi((t) => t.drawer);
  const close = () => useTabletUi.setState({ drawer: false });
  // what you pick in it (a session, the board, a project, the Inbox): it closes
  useEffect(() => {
    if (!open) return;
    return useBrain.subscribe((s, p) => {
      if (s.focus !== p.focus || s.overview !== p.overview || s.projectOpen !== p.projectOpen || s.inbox !== p.inbox || (s.modal && !p.modal)) close();
    });
  }, [open]);
  // a swipe in from the left edge opens it
  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = t && t.clientX < 22 ? { x: t.clientX, y: t.clientY } : null;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      if (t.clientX - start.x > 60 && Math.abs(t.clientY - start.y) < 50) {
        start = null;
        useTabletUi.setState({ drawer: true });
      }
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    return () => (window.removeEventListener('touchstart', down), window.removeEventListener('touchmove', move));
  }, []);
  return (
    <div className={`tb-drawer${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="tb-dim" onClick={close} />
      <div
        className="tb-sheet"
        onClickCapture={(e) => {
          // a choice made in it (a session, a project, the board, the Inbox, a new session): it closes, even when that
          // choice is what's already open
          if ((e.target as Element).closest('.ses:not(.ses-x), .pj-row, .inbox-row, .ses-new, .rf-ib') && !(e.target as Element).closest('.ses-x, .pj-chev, .pj-more')) setTimeout(close, 0);
        }}
      >
        {open ? <SessionRail /> : null}
        <LayoutChoice />
      </div>
    </div>
  );
}

/** This device's layout, and its 3D scene (kept on the device: your other screens don't change). */
export function LayoutChoice() {
  const choice = useTabletChoice((c) => c.choice);
  const [scene, setScene] = useState(tabletScene);
  return (
    <div className="tb-layout">
      <span className="lab">This device</span>
      <span className="pp-seg">
        {(['auto', 'on', 'off'] as const).map((c) => (
          <button key={c} className={choice === c ? 'on' : ''} onClick={() => useTabletChoice.getState().set(c)} title={c === 'auto' ? 'Tablet on a touch screen, else desktop' : c === 'on' ? 'Always the tablet layout here' : 'Always the desktop layout here'}>
            {c === 'auto' ? 'Auto' : c === 'on' ? 'Tablet' : 'Desktop'}
          </button>
        ))}
      </span>
      <button
        className={`pp-tg${scene ? ' on' : ''}`}
        onClick={() => {
          const next = !scene;
          try {
            localStorage.setItem('cora.tablet.scene', next ? 'on' : 'off');
          } catch {
            /* ignore */
          }
          setScene(next);
        }}
        title="The 3D scene on this device (the flat board is smoother)"
      >
        3D scene
      </button>
    </div>
  );
}

/** The session's views, across the top: its board, then its transcript, explains and changes. */
export function TabletTabs({ sessionId, portrait }: { sessionId: string; portrait: boolean }) {
  const pane = useTabletUi((t) => t.pane);
  const tab = useBrain((s) => s.rightTab);
  const pages = useRBrowse((s) => s.tabs.filter((x) => x.sessionId === sessionId).length);
  const pick = (t: 'board' | 'transcript' | 'explains' | 'changes' | 'browser') => {
    if (t === 'board' || t === 'browser') useTabletUi.setState({ pane: t });
    else {
      useTabletUi.setState({ pane: 'session' });
      useBrain.getState().setRightTab(t);
    }
  };
  const on = (t: string) => (t === 'board' || t === 'browser' ? pane === t : pane === 'session' && tab === t);
  return (
    <div className="tb-tabs" role="tablist">
      {portrait ? (
        <button className="tb-ib tb-menu" onClick={() => useTabletUi.setState({ drawer: true })} aria-label="Open the nav">
          <Icon name="Menu" size={18} />
        </button>
      ) : null}
      {(['board', 'transcript', 'explains', 'changes', 'browser'] as const).map((t) => (
        <button key={t} role="tab" aria-selected={on(t)} className={`tb-tab${on(t) ? ' on' : ''}`} onClick={() => pick(t)}>
          {t[0].toUpperCase() + t.slice(1)}
          {t === 'browser' && pages ? <span className="tb-n">{pages}</span> : null}
        </button>
      ))}
    </div>
  );
}
