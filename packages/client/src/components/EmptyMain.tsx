import { useBrain } from '../state/store';
import { ago, sessionColor, sessionName, shortCwd } from '../lib/format';
import { openPalette } from './Palette';
import { showSession } from './SessionMenu';
import { Icon } from './Icon';
import './emptyMain.css';

/**
 * The main view with nothing open: quiet type, what to do next, and the last few sessions to go back to (one click
 * shows it here; Resume has the rest).
 */
export function EmptyMain() {
  const sessions = useBrain((s) => s.sessions);
  const now = Date.now();
  const all = Object.values(sessions);
  const recent = [...all].sort((a, b) => b.lastTs - a.lastTs).slice(0, 3);
  const setModal = useBrain((s) => s.setModal);
  return (
    <div className="empty-state em">
      {all.length ? (
        <>
          <h3>Nothing open</h3>
          <p>Start a session, or pick one up where you left it.</p>
        </>
      ) : (
        <>
          <h3>No sessions yet</h3>
          <p>Start Claude Code here, resume an earlier one, or start one in any terminal: it shows up here on its own.</p>
        </>
      )}
      <div className="es-actions">
        <button className="btn em-go" onClick={() => setModal('new-session')}>
          <Icon name="Plus" size={14} /> New session
        </button>
        <button className="btn ghost" onClick={() => setModal('history')}>
          Resume…
        </button>
      </div>
      {recent.length ? (
        <div className="em-recent">
          <div className="em-h">
            <span>Recent</span>
            <i />
          </div>
          {recent.map((s) => (
            <button key={s.id} className="em-row" style={{ '--sc': sessionColor(s) } as React.CSSProperties} onClick={() => showSession(s.id)} title="Show it here (resume it from its composer)">
              <span className="em-tile">{(sessionName(s).match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()}</span>
              <span className="em-t">
                <b>{sessionName(s)}</b>
                <span>{shortCwd(s.cwd)}</span>
              </span>
              <span className="em-ago">{ago(s.lastTs, now)}</span>
              <span className="em-show">show ›</span>
            </button>
          ))}
        </div>
      ) : null}
      <button className="em-hint" onClick={() => openPalette(true)}>
        <kbd>Ctrl</kbd>
        <kbd>K</kbd> go to anything
      </button>
    </div>
  );
}
