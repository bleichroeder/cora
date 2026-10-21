import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionInfo } from '@cora/shared';
import { checkRunning } from '../state/ws';
import { sessionColor, sessionName, shortCwd } from '../lib/format';
import { dismissSession } from './SessionMenu';
import { Icon } from './Icon';
import './dialogs.css';

/** End a session: Ctrl+C twice when it runs in Cora, its claude process when it runs in another terminal. */
export async function endSession(id: string): Promise<{ how: 'hosted' | 'process' | 'none' } | { error: string }> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  return r.ok ? j : { error: j.error ?? `HTTP ${r.status}` };
}

type Where = 'checking' | 'hosted' | 'elsewhere' | 'none';

/** Asks before ending a live session, saying how it will be ended (it depends on where it runs). */
export function EndSessionConfirm({ s, onClose }: { s: SessionInfo; onClose(): void }) {
  const [where, setWhere] = useState<Where>('checking');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void checkRunning(s.id).then((r) => setWhere(r.hosted ? 'hosted' : r.elsewhere ? 'elsewhere' : 'none'));
  }, [s.id]);

  const go = async () => {
    if (busy || where === 'checking') return;
    setBusy(true);
    setErr(null);
    if (where === 'none') {
      await dismissSession(s.id);
      return onClose();
    }
    const r = await endSession(s.id);
    setBusy(false);
    if ('error' in r) setErr(r.error);
    else if (r.how === 'none') setWhere('none');
    else onClose();
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'Enter') void go();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const body: Record<Where, React.ReactNode> = {
    checking: 'Checking where it’s running…',
    hosted: (
      <>
        Cora will press <kbd>Ctrl</kbd>+<kbd>C</kbd> twice in its terminal: the first stops whatever Claude is doing, the second quits Claude Code. If it
        hasn’t quit a few seconds later, Cora closes the terminal.
      </>
    ),
    elsewhere: 'It’s running in a terminal outside Cora, so Cora can’t type into it: it will end that session’s claude process instead. Anything Claude is in the middle of stops.',
    none: 'Cora can’t find it running anywhere: it has probably quit already.',
  };
  return createPortal(
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal dlg end-session" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dlg-h">
          <span className="dlg-t">
            <Icon name={where === 'none' ? 'EyeOff' : 'Power'} size={15} />
            {where === 'none' ? 'Remove it from the list?' : 'End this session?'}
          </span>
        </div>
        <div className="dlg-b">
          {/* which one, unmistakably: the session as the nav shows it */}
          <div className="es-who" style={{ ['--sc' as any]: sessionColor(s) }}>
            <span className={`dl-tile ${s.state === 'working' ? 'work' : s.state === 'thinking' ? 'think' : s.state === 'needs-you' ? 'need' : ''}`}>
              {(sessionName(s).match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()}
              <i />
            </span>
            <span className="es-id">
              <b>{sessionName(s)}</b>
              <span>
                {shortCwd(s.cwd)}
                {where === 'none' ? '' : ` · ${s.state === 'needs-you' ? 'waiting on you' : s.state}`}
              </span>
            </span>
          </div>
          <p className="es-body">{body[where]}</p>
          {where !== 'none' && where !== 'checking' ? <p className="es-note">Its history stays: you can resume it later.</p> : null}
          {err ? <div className="ny-err">{err}</div> : null}
        </div>
        <div className="dlg-f">
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className={`btn${where === 'none' ? '' : ' danger'}`} onClick={() => void go()} disabled={busy || where === 'checking'} autoFocus>
            {/* the name is in the card above (truncated there): a long one would run out of the button */}
            {where === 'none' ? 'Remove from the list' : busy ? 'Ending…' : 'End session'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
