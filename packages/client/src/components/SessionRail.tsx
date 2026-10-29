import { useEffect, useMemo, useRef, useState } from 'react';
import { SessionsMute } from './ReadAloudToggle';
import { ProjectsSection } from './Projects';
import { useProjects } from '../state/projects';
import { GuestCard } from './Live';
import { useLive, usePrivate } from '../state/live';
import { useCoraLinks } from '../lib/coraLinks';
import { desktop } from '../lib/desktop';
import type { SessionInfo } from '@cora/shared';
import { useBrain } from '../state/store';
import { isDismissed, sessionColor } from '../lib/format';
import { folderLabel, rowState } from '../lib/navRow';
import { ticketLabel } from '../lib/ticket';
import { SessionMenu, clearEnded, removeSession } from './SessionMenu';
import { Icon } from './Icon';
import { RecapPeek } from './Recap';
import { IssueChip } from './IssuePicker';
import { JiraChip } from './JiraChip';
import { EndSessionConfirm } from './EndSession';
import { GROUPS, dropOrder, inList, sameGroup, saveOrder, sortedSessions } from '../lib/sessionOrder';
import { openPalette } from './Palette';
import { CiGlyph } from './CiStrip';
import { ToolsDock } from './Tools';
import { securityLevel } from '@cora/shared';
import { useSecurity } from '../state/security';
import { openSettings } from './SettingsModal';
import { lockNow } from '../state/lock';
import { CoraEye } from './CoraEye';
import { InboxRow } from './Inbox';
import { useOrch } from '../state/orchestrator';
import { useVoice } from '../lib/voice';
import { oops } from '../state/oops';
import { NAV_DEFAULT, NAV_RESIZED, applyNavWidth, navWidthNow, saveNavWidth } from '../lib/navWidth';
import './nav.css';

export { sortedSessions };

/** Dragging a session to a new place in its group. */
type Drag = { id: string; over?: { id: string; below: boolean } };

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}


/**
 * One session: a fixed-height row of fixed slots. Its swatch
 * (its colour, its own icon; a ring when Cora started it), its name, a word for its state only when something is
 * happening; under them its ticket in a column of its own, its folder, and its pipeline when it's running or failed.
 */
function Entry({ s, onMenu, drag, setDrag }: { s: SessionInfo; onMenu(e: React.MouseEvent, s: SessionInfo): void; drag: Drag | null; setDrag(d: Drag | null): void }) {
  const focus = useBrain((st) => st.focus);
  const setFocus = useBrain((st) => st.setFocus);
  const byCora = useOrch((st) => {
    const g = st.status?.goal;
    return !!g && ['running', 'waiting', 'blocked'].includes(g.state) && g.workers.includes(s.id);
  });
  // started by Cora on a ticket assigned to you: its ring too
  const fromJira = useOrch((st) => st.status?.jiraStarted?.find((r) => r.sessionId === s.id)?.key);
  // Cora and it talking (either way, open or not): a glow in Cora's colour on its row
  const reached = useCoraLinks((st) => !!st.links[s.id]);
  const movable = s.state !== 'ended';
  // selected from anywhere (a launch, a toast, the overview): bring it into view in the rail
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focus === s.id) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focus, s.id]);
  const hint = drag?.over?.id === s.id && drag.id !== s.id ? (drag.over.below ? ' drop-below' : ' drop-above') : '';
  const [ending, setEnding] = useState(false);
  const ended = s.state === 'ended';
  // its Claude Code still open in Cora (it said it ended, and hasn't quit yet): ending it comes before taking it off
  const hosted = useBrain((st) => st.terminals.some((t) => t.sessionId === s.id && t.alive));
  const name = ticketLabel(s).text;
  const st = s.state === 'needs-you' ? ' need' : s.state === 'working' || s.state === 'thinking' ? ' work' : s.state === 'idle' ? ' idle' : ' done';
  // finished while you were elsewhere (until you open it), and being read aloud now
  const fresh = useBrain((b) => !!b.unseen[s.id]) && s.state === 'idle';
  const speaking = useVoice((v) => v.reading?.sessionId === s.id);
  // what it's up to, in a word (and for how long), only when something is happening
  const waitingSince = useBrain((b) => b.pending.find((p) => p.sessionId === s.id)?.createdAt);
  const now = useNow(10_000);
  const state = rowState(s, { now, fresh, speaking, ...(waitingSince ? { waitingSince } : {}) });
  const folder = folderLabel(s.cwd, s.wd);
  // resting on it a moment: its latest recap, beside the nav
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unpeek = () => (peekTimer.current && clearTimeout(peekTimer.current), (peekTimer.current = null), setPeek(false));
  useEffect(() => unpeek, []);

  return (
    <>
      {ending ? <EndSessionConfirm s={s} onClose={() => setEnding(false)} /> : null}
      {peek && s.recap && ref.current ? <RecapPeek sessionId={s.id} row={ref.current} /> : null}
      <button
        ref={ref}
        data-ping={`ses:${s.id}`}
        className={`ses${st}${fresh ? ' fresh' : ''}${speaking ? ' speaking' : ''}${focus === s.id ? ' on' : ''}${byCora || fromJira ? ' cora' : ''}${isDismissed(s) ? ' dismissed' : ''}${drag?.id === s.id ? ' dragging' : ''}${reached ? ' reached' : ''}${hint}`}
        style={{ ['--sc' as any]: sessionColor(s) }}
        onClick={() => (unpeek(), setFocus(s.id))}
        onContextMenu={(e) => (unpeek(), onMenu(e, s))}
        onMouseEnter={() => s.recap && !drag && (peekTimer.current = setTimeout(() => setPeek(true), 550))}
        onMouseLeave={unpeek}
        draggable={movable}
        onDragStart={(e) => {
          unpeek();
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', s.id);
          setDrag({ id: s.id });
        }}
        onDragEnd={() => setDrag(null)}
        onDragOver={(e) => {
          const from = drag && useBrain.getState().sessions[drag.id];
          if (!from || !movable || !sameGroup(from, s)) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const below = e.clientY > r.top + r.height / 2;
          if (drag.over?.id !== s.id || drag.over.below !== below) setDrag({ id: drag.id, over: { id: s.id, below } });
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (drag?.over && drag.id !== drag.over.id) void saveOrder(dropOrder(useBrain.getState().sessions, drag.id, drag.over.id, drag.over.below));
          setDrag(null);
        }}
      >
        {/* its swatch: its colour, holding its own icon (a plain square of its colour until it has one) */}
        <span className="ses-tile">{s.icon ? <Icon name={s.icon} size={15} /> : <i className="ses-core" />}</span>
        <span className="ses-nm">{name}</span>
        {state ? (
          <span className={`ses-word ${state.cls}`}>
            {state.word}
            {state.time ? <small>{state.time}</small> : null}
          </span>
        ) : null}
        {/* its ticket (a column of its own: keys line up), its folder, and its pipeline when it's worth a look */}
        <span className="ses-l2">
          {s.ticket || s.issue ? (
            <span className="ses-tk">{s.ticket ? <JiraChip jref={{ key: s.ticket.key, ...(s.ticket.site ? { site: s.ticket.site } : {}) }} sessionId={s.id} bare /> : <IssueChip s={s} />}</span>
          ) : null}
          <span className="ses-dir" title={folder.title}>
            {folder.text}
          </span>
          <span className="ses-ci">
            <CiGlyph sessionId={s.id} quiet />
          </span>
        </span>
        {/* ended: off the list; live: end it (after asking how, since that depends on where it runs) */}
        {!isDismissed(s) ? (
          <span
            className="ses-x"
            role="button"
            title={ended && !hosted ? 'Remove from the list (it comes back if it has new activity)' : 'End this session…'}
            onClick={(e) => {
              e.stopPropagation();
              if (ended && !hosted) void removeSession(s.id).then((err) => err && oops("Couldn't take it off the list", err));
              else setEnding(true);
            }}
          >
            <Icon name="X" size={11} />
          </span>
        ) : null}
      </button>
    </>
  );
}

/**
 * The nav's right edge: drag it to make the nav wider or narrower (240 to 440px), double-click for 300 again. While
 * you drag, terminals keep their size; they fit the new space once, when you let go.
 */
function NavEdge() {
  const done = (w: number) => {
    delete document.documentElement.dataset.navDrag;
    saveNavWidth(w);
    window.dispatchEvent(new Event(NAV_RESIZED));
  };
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = navWidthNow();
    document.documentElement.dataset.navDrag = '1';
    const move = (ev: PointerEvent) => applyNavWidth(w0 + ev.clientX - x0);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      done(navWidthNow());
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return (
    <div
      className="nav-edge"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      title="Drag to resize · double-click for the default"
      onPointerDown={down}
      onDoubleClick={() => (applyNavWidth(NAV_DEFAULT), done(NAV_DEFAULT))}
    />
  );
}

/** Folded groups (Idle, Ended), remembered. */
function useFolded(): [Record<string, boolean>, (g: string) => void] {
  const [f, setF] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('cora.rail.folded') ?? '{"ended":true}') as Record<string, boolean>;
    } catch {
      return { ended: true };
    }
  });
  const toggle = (g: string) =>
    setF((cur) => {
      const next = { ...cur, [g]: !cur[g] };
      try {
        localStorage.setItem('cora.rail.folded', JSON.stringify(next));
      } catch {}
      return next;
    });
  return [f, toggle];
}

export function SessionRail() {
  const sessions = useBrain((s) => s.sessions);
  const ready = useBrain((s) => s.ready);
  const unseen = useBrain((s) => s.unseen);
  // back at the window on a session that finished while you were away: it's seen
  useEffect(() => {
    const back = () => document.visibilityState === 'visible' && document.hasFocus() && useBrain.getState().markSeen(useBrain.getState().focus);
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => (window.removeEventListener('focus', back), document.removeEventListener('visibilitychange', back));
  }, []);
  const now = useNow(5000);
  const [menu, setMenu] = useState<{ s: SessionInfo; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [folded, toggleFold] = useFolded();
  const focus = useBrain((s) => s.focus);
  // what's live, and what ended in the last few hours; removed ones and older ones are in Resume
  // a project's members show under it, not again in the groups below
  const members = useProjects((p) => p.projects);
  const inProject = useMemo(() => new Set(members.filter((p) => !p.archivedAt).flatMap((p) => p.sessions)), [members]);
  const list = sortedSessions(sessions).filter((s) => inList(s, now, focus) && !inProject.has(s.id));
  const setModal = useBrain((s) => s.setModal);
  const guest = useLive((s) => s.role === 'guest');
  const privateConsole = usePrivate('console');
  const privateInbox = usePrivate('inbox');
  const onMenu = (e: React.MouseEvent, s: SessionInfo) => {
    e.preventDefault();
    if (guest) return;
    setMenu({ s, x: e.clientX, y: e.clientY });
  };
  return (
    <nav className="rail">
      {guest ? null : <NavEdge />}
      {guest && privateConsole ? <GuestCard /> : <CoraEye />}
      <BoardRow />
      {guest && privateInbox ? (
        <div className="inbox-row priv" title="Private">
          <Icon name="Inbox" size={14} />
          <b>Inbox</b>
          <i className="priv-tag">PRIVATE</i>
        </div>
      ) : (
        <InboxRow />
      )}
      {/* the sessions' section, as Tools has it: its heading with Resume and Search beside it, and the one big button,
          New session (the main thing you do here) */}
      <div className="rail-sessions">
        <div className="rt-h ses-head">
          <span>Sessions</span>
          <span className="rt-hb">
            <SessionsMute />
            <button className="rt-add" onClick={() => setModal('history')} title="Resume or fork any session on disk">
              <Icon name="History" size={12} />
            </button>
            <button className="rt-add" onClick={() => openPalette(true)} title="Go to anything: sessions, folders, transcripts, commands (Ctrl+K)">
              <Icon name="Search" size={12} />
            </button>
          </span>
        </div>
        {guest ? null : (
          <button className="btn allow ses-new" onClick={() => setModal('new-session')} title="Start a new Claude Code session">
            <Icon name="Plus" size={14} /> New session
          </button>
        )}
      </div>
      <div className="rail-scroll">
      {guest ? null : <ProjectsSection entry={(s) => <Entry key={s.id} s={s} onMenu={onMenu} drag={drag} setDrag={setDrag} />} dragging={drag?.id ?? null} onDropped={() => setDrag(null)} />}
      {GROUPS.map((g) => {
        const all = list.filter((s) => g.states.includes(s.state));
        if (!all.length) return null;
        const foldable = g.title !== 'working';
        const closed = foldable && !!folded[g.title];
        const needing = all.filter((s) => s.state === 'needs-you');
        const freshOnes = all.filter((s) => s.state === 'idle' && unseen[s.id]);
        return (
          <section key={g.title} className="ses-group">
            <div className={`ses-h${foldable ? ' fold' : ''}${closed ? ' closed' : ''}`} onClick={foldable ? () => toggleFold(g.title) : undefined}>
              {foldable ? <Icon name="ChevronDown" size={11} className="ses-chev" /> : null}
              <span>{g.title}</span>
              <span className="ses-n">{all.length}</span>
              <span className="ses-rule" />
              {needing.length ? (
                <button className="ses-need" title="Waiting for you: show the first one" onClick={(e) => (e.stopPropagation(), useBrain.getState().setFocus(needing[0].id))}>
                  {needing.length}
                </button>
              ) : null}
              {freshOnes.length ? (
                <button className="ses-fresh" title="Finished since you looked: show the newest" onClick={(e) => (e.stopPropagation(), useBrain.getState().setFocus([...freshOnes].sort((a, b) => unseen[b.id] - unseen[a.id])[0].id))}>
                  {freshOnes.length}
                </button>
              ) : null}
              {g.title === 'ended' ? (
                <button className="ses-clear" onClick={(e) => (e.stopPropagation(), void clearEnded())} title="Take the ended sessions off the list (Resume still has them)">
                  clear
                </button>
              ) : null}
            </div>
            {closed ? null : all.map((s) => <Entry key={s.id} s={s} onMenu={onMenu} drag={drag} setDrag={setDrag} />)}
          </section>
        );
      })}
      {!list.length && !inProject.size && ready ? <div className="empty">Nothing open. Start a new session, or pick up an earlier one from Resume.</div> : null}
      </div>
      {guest ? null : <ToolsDock />}
      {guest ? null : <RailFooter />}
      {menu ? <SessionMenu s={sessions[menu.s.id] ?? menu.s} x={menu.x} y={menu.y} onClose={() => setMenu(null)} /> : null}
    </nav>
  );
}

/** Cora's board (the Overview), with Cora's other things at the top of the nav: between its card and the Inbox (the foot). */
function BoardRow() {
  const overview = useBrain((s) => s.overview);
  return (
    <button data-ping="nav:board" className={`inbox-row board-row${overview ? ' on' : ''}`} onClick={() => useBrain.getState().toggleOverview()} title="Cora's board: your sessions, their worktrees, what needs you (G)">
      <Icon name="LayoutDashboard" size={14} />
      <b>Cora's board</b>
      <kbd>G</kbd>
    </button>
  );
}

/**
 * The nav's foot: a quiet line. It says what's wrong in words when something is (the connection, a new version to
 * restart into, security updates), else nothing; Settings and Lock as two icons on the right.
 */
function RailFooter() {
  const conn = useBrain((s) => s.conn);
  // brief reconnects (a server restart, sleep/wake) shouldn't flash a warning
  const [down, setDown] = useState(false);
  const isOpen = conn === 'open'; // retries flip closed/connecting; only open vs not matters for the delay
  useEffect(() => {
    if (isOpen) return setDown(false);
    const t = setTimeout(() => setDown(true), 2000);
    return () => clearTimeout(t);
  }, [isOpen]);
  const update = useUpdateReady();
  const level = useSecurity((s) => securityLevel(s.report));
  // the one thing worth saying, most urgent first
  const say =
    down && conn !== 'open' ? (
      <span className={`rf-say ${conn === 'unauthorized' ? 'bad' : 'warn'}`} title={conn === 'unauthorized' ? 'Not signed in: open the link printed by cora start' : conn === 'connecting' ? 'Connecting to the Cora server' : 'Lost the connection to the Cora server; retrying'}>
        <i />
        {conn === 'unauthorized' ? 'Signed out' : 'Reconnecting…'}
      </span>
    ) : update ? (
      <button className="rf-say cora" onClick={() => desktop?.restartApp?.()} title="Cora restarts on the new version; your sessions keep running">
        <i />
        Restart to update <small>v{update}</small>
      </button>
    ) : level ? (
      <button className={`rf-say ${level === 'high' ? 'bad' : 'warn'}`} onClick={() => openSettings('security')} title="Settings › Updates & security">
        <i />
        {level === 'high' ? 'Security updates needed' : 'Security updates available'}
      </button>
    ) : null;
  return (
    <div className="rail-foot rf-line">
      {say}
      <span className="rf-icons">
        <button className="rf-ib" title="Settings" aria-label="Settings" onClick={() => useBrain.getState().setModal('settings')}>
          <Icon name="Settings" size={15} />
        </button>
        <button className="rf-ib" title="Lock Cora (Ctrl+Alt+L)" aria-label="Lock Cora" onClick={() => void lockNow()}>
          <Icon name="Lock" size={15} />
        </button>
      </span>
    </div>
  );
}

/** Installed Cora: a new version is downloaded (its version), restarting installs it (sessions keep running). */
function useUpdateReady(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void desktop?.updateReady?.().then(setVersion);
    return desktop?.onUpdate?.(setVersion);
  }, []);
  return version;
}

