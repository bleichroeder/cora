import { useBrain } from '../state/store';
import { ago, sessionColor, sessionName, shortCwd } from '../lib/format';
import { openPalette } from './Palette';
import { showSession } from './SessionMenu';
import { Icon } from './Icon';
import './emptyMain.css';

/**
 * The main view with nothing open: Cora's orb in your colour, what to do next, and the last few sessions to go back to
 * (one click shows it here; Resume has the rest).
 */
export function EmptyMain() {
  const sessions = useBrain((s) => s.sessions);
  const now = Date.now();
  const all = Object.values(sessions);
  const recent = [...all].sort((a, b) => b.lastTs - a.lastTs).slice(0, 3);
  const setModal = useBrain((s) => s.setModal);
  return (
    <div className="empty-state em">
      <span className="em-hero" aria-hidden>
        <span className="orb-glyph em-orb" />
      </span>
      {all.length ? (
        <>
          <h3>Nothing open</h3>
          <p>Every session is closed. Start a new one, or pick up where you left off.</p>
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
          <Icon name="History" size={13} /> Resume
        </button>
      </div>
      {recent.length ? (
        <div className="em-recent">
          <div className="em-h">Recent</div>
          {recent.map((s) => (
            <button key={s.id} className="em-row" style={{ '--sc': sessionColor(s) } as React.CSSProperties} onClick={() => showSession(s.id)} title="Show it here (resume it from its composer)">
              <span className="em-dot" />
              <span className="em-t">
                <b>{sessionName(s)}</b>
                <span>
                  {shortCwd(s.cwd)} · {ago(s.lastTs, now)} ago
                </span>
              </span>
              <Icon name="ChevronRight" size={14} />
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
