import { useEffect, useRef, useState } from 'react';
import { desktop } from '../lib/desktop';
import type { SessionInfo } from '@cora/shared';
import { useBrain } from '../state/store';
import { isDismissed, sessionColor, shortCwd } from '../lib/format';
import { ticketLabel } from '../lib/ticket';
import { SessionMenu, clearEnded, dismissSession } from './SessionMenu';
import { Icon } from './Icon';
import { RecapPeek } from './Recap';
import { IssueChip } from './IssuePicker';
import { JiraChip } from './JiraChip';
import { EndSessionConfirm } from './EndSession';
import { GROUPS, dropOrder, inList, sameGroup, saveOrder, sortedSessions } from '../lib/sessionOrder';
import { openPalette } from './Palette';
import { CiGlyph } from './CiStrip';
import { ToolsDock } from './Tools';
import { SecurityBadge } from './SecuritySettings';
import { lockNow } from '../state/lock';
import { CoraEye } from './CoraEye';
import { InboxRow } from './Inbox';
import { useOrch } from '../state/orchestrator';
import { useVoice } from '../lib/voice';
import { oops } from '../state/oops';
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

/** A session's initial, for its tile: the first letter or digit of its name. */
const initialOf = (name: string) => (name.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase();

/**
 * One session: a fixed-height row. Its tile (the session's colour and initial) carries its state on the corner
 * (working, needs you) and a ring when Cora started it; then its name, and its folder with its ticket and pipeline.
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
  const movable = s.state !== 'ended';
  // selected from anywhere (a launch, a toast, the overview): bring it into view in the rail
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focus === s.id) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focus, s.id]);
  const hint = drag?.over?.id === s.id && drag.id !== s.id ? (drag.over.below ? ' drop-below' : ' drop-above') : '';
  const [ending, setEnding] = useState(false);
  const ended = s.state === 'ended';
  const name = ticketLabel(s).text;
  const st = s.state === 'needs-you' ? ' need' : s.state === 'working' || s.state === 'thinking' ? ' work' : s.state === 'idle' ? ' idle' : ' done';
  // finished while you were elsewhere (until you open it), and being read aloud now
  const fresh = useBrain((b) => !!b.unseen[s.id]) && s.state === 'idle';
  const speaking = useVoice((v) => v.reading?.sessionId === s.id);
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
        className={`ses${st}${fresh ? ' fresh' : ''}${speaking ? ' speaking' : ''}${focus === s.id ? ' on' : ''}${byCora || fromJira ? ' cora' : ''}${isDismissed(s) ? ' dismissed' : ''}${drag?.id === s.id ? ' dragging' : ''}${hint}`}
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
        <span className="ses-tile">
          {initialOf(name)}
          <i className="ses-st" />
        </span>
        <span className="ses-txt">
          <span className="ses-nm">{name}</span>
          <span className="ses-l2">
            <span className="ses-dir">{shortCwd(s.cwd)}</span>
            {s.ticket ? <JiraChip jref={{ key: s.ticket.key, ...(s.ticket.site ? { site: s.ticket.site } : {}) }} sessionId={s.id} bare /> : s.issue ? <IssueChip s={s} /> : null}
            <CiGlyph sessionId={s.id} />
          </span>
        </span>
        {/* ended: off the list; live: end it (after asking how, since that depends on where it runs) */}
        {!isDismissed(s) ? (
          <span
            className="ses-x"
            role="button"
            title={ended ? 'Remove from the list (it comes back if it has new activity)' : 'End this session…'}
            onClick={(e) => {
              e.stopPropagation();
              if (ended) void dismissSession(s.id).then((err) => err && oops("Couldn't take it off the list", err));
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
  const list = sortedSessions(sessions).filter((s) => inList(s, now, focus));
  const setModal = useBrain((s) => s.setModal);
  const onMenu = (e: React.MouseEvent, s: SessionInfo) => {
    e.preventDefault();
    setMenu({ s, x: e.clientX, y: e.clientY });
  };
  return (
    <nav className="rail">
      <CoraEye />
      <InboxRow />
      {/* the sessions' section, as Tools has it: its heading with Resume and Search beside it, and the one big button,
          New session (the main thing you do here) */}
      <div className="rail-sessions">
        <div className="rt-h ses-head">
          <span>Sessions</span>
          <span className="rt-hb">
            <button className="rt-add" onClick={() => setModal('history')} title="Resume or fork any session on disk">
              <Icon name="History" size={12} />
            </button>
            <button className="rt-add" onClick={() => openPalette(true)} title="Go to anything: sessions, folders, transcripts, commands (Ctrl+K)">
              <Icon name="Search" size={12} />
            </button>
          </span>
        </div>
        <button className="btn allow ses-new" onClick={() => setModal('new-session')} title="Start a new Claude Code session">
          <Icon name="Plus" size={14} /> New session
        </button>
      </div>
      <div className="rail-scroll">
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
      {!list.length && ready ? <div className="empty">Nothing open. Start a new session, or pick up an earlier one from Resume.</div> : null}
      </div>
      <ToolsDock />
      <RailFooter />
      {menu ? <SessionMenu s={sessions[menu.s.id] ?? menu.s} x={menu.x} y={menu.y} onClose={() => setMenu(null)} /> : null}
    </nav>
  );
}

/** Pinned under the list: settings, the overview toggle, and the connection state when it isn't healthy. */
function RailFooter() {
  const conn = useBrain((s) => s.conn);
  const overview = useBrain((s) => s.overview);
  const toggle = useBrain((s) => s.toggleOverview);
  // brief reconnects (a server restart, sleep/wake) shouldn't flash a warning
  const [down, setDown] = useState(false);
  const isOpen = conn === 'open'; // retries flip closed/connecting; only open vs not matters for the delay
  useEffect(() => {
    if (isOpen) return setDown(false);
    const t = setTimeout(() => setDown(true), 2000);
    return () => clearTimeout(t);
  }, [isOpen]);
  return (
    <div className="rail-foot">
      <UpdateReady />
      <button className={`rf-btn${overview ? ' on' : ''}`} onClick={() => toggle()} title="Overview: grid or galaxy (G)">
        <Icon name="LayoutGrid" size={14} />
        <span>Overview</span>
        <kbd>G</kbd>
      </button>
      <div className="rf-row">
        <button className="rf-btn" title="Settings" onClick={() => useBrain.getState().setModal('settings')}>
          <Icon name="Settings" size={14} />
          <span>Settings</span>
        </button>
        <SecurityBadge />
        <button className="rf-btn rf-lock" title="Lock Cora (Ctrl+Alt+L)" aria-label="Lock Cora" onClick={() => void lockNow()}>
          <Icon name="Lock" size={14} />
        </button>
      </div>
      {down && conn !== 'open' ? (
        <span className="rf-conn" title={conn === 'unauthorized' ? 'Not signed in: open the link printed by cora start' : conn === 'connecting' ? 'Connecting to the Cora server' : 'Lost the connection to the Cora server; retrying'}>
          <span className={`live-dot ${conn}`} />
          {conn === 'unauthorized' ? 'signed out' : 'reconnecting…'}
        </span>
      ) : null}
    </div>
  );
}

/** Installed Cora: a new version is downloaded; restarting installs it (sessions keep running). */
function UpdateReady() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void desktop?.updateReady?.().then(setVersion);
    return desktop?.onUpdate?.(setVersion);
  }, []);
  if (!version) return null;
  return (
    <button className="rf-btn rf-update" onClick={() => desktop?.restartApp?.()} title="Cora restarts on the new version; your sessions keep running">
      <Icon name="ArrowUpCircle" size={14} />
      <span>Restart to update</span>
      <kbd>v{version}</kbd>
    </button>
  );
}

