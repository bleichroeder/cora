import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionInfo } from '@cora/shared';
import { checkRunning } from '../state/ws';
import { sessionColor, sessionName, shortCwd } from '../lib/format';
import { dismissSession } from './SessionMenu';
import { Icon } from './Icon';
import './dialogs.css';

/** End a session: Ctrl+C twice when it runs in Cora, its claude process when it runs in another terminal. */
export async function endSession(id: string): Promise<{ how: 'hosted' | 'process' | 'none' | 'unknown' } | { error: string }> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  return r.ok ? j : { error: j.error ?? `HTTP ${r.status}` };
}

export type Where = 'checking' | 'hosted' | 'elsewhere' | 'none' | 'unknown';

/**
 * The dialog's keys: Escape closes it and is consumed (marked handled and stopped), so nothing under it (the board
 * leaving Fill the area, a drawer) also takes it; Enter does what it offers. Whether it was one of them.
 */
export function endKey(e: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'stopPropagation'>, o: { close(): void; go(): void }): boolean {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    o.close();
    return true;
  }
  if (e.key === 'Enter') {
    o.go();
    return true;
  }
  return false;
}

/** Where it runs, from the check. A check that failed (or can't run here) is "couldn't tell", never "not running". */
export function whereOf(r: { hosted: boolean; checked: boolean; elsewhere: boolean }): Exclude<Where, 'checking'> {
  return r.hosted ? 'hosted' : !r.checked ? 'unknown' : r.elsewhere ? 'elsewhere' : 'none';
}

/** Its title and icon: what it found; while it checks again, what it found last (so Check again doesn't flicker). */
export function headOf(where: Where, last: Where | null): { title: string; icon: string } {
  const w = where === 'checking' && last ? last : where;
  return w === 'none' ? { title: 'Remove it from the list?', icon: 'EyeOff' } : w === 'unknown' ? { title: 'Is it still running?', icon: 'CircleHelp' } : { title: 'End this session?', icon: 'Power' };
}

/** Asks before ending a live session, saying how it will be ended (it depends on where it runs). */
export function EndSessionConfirm({ s, onClose }: { s: SessionInfo; onClose(): void }) {
  const [where, setWhere] = useState<Where>('checking');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // what the last check found (the title keeps it while it checks again)
  const [last, setLast] = useState<Where | null>(null);
  const check = () => {
    if (where !== 'checking') setLast(where);
    setWhere('checking');
    void checkRunning(s.id).then((r) => setWhere(whereOf(r)));
  };
  useEffect(check, [s.id]);

  const remove = async () => {
    setBusy(true);
    await dismissSession(s.id);
    onClose();
  };
  const go = async () => {
    if (busy || where === 'checking') return;
    // couldn't tell: look again rather than act on a guess
    if (where === 'unknown') return check();
    setBusy(true);
    setErr(null);
    if (where === 'none') {
      await dismissSession(s.id);
      return onClose();
    }
    const r = await endSession(s.id);
    setBusy(false);
    if ('error' in r) setErr(r.error);
    else if (r.how === 'none' || r.how === 'unknown') setWhere(r.how);
    else onClose();
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => endKey(e, { close: onClose, go: () => void go() });
    // (caught first: its Escape is its own, the board's never also fires)
    document.addEventListener('keydown', k, true);
    return () => document.removeEventListener('keydown', k, true);
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
    unknown: 'Cora couldn’t tell whether it’s still running: looking for its process failed. It may still be running in another terminal, so Cora won’t end it or remove it on a guess.',
  };
  const quiet = where === 'none' || where === 'unknown';
  return createPortal(
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal dlg end-session" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dlg-h">
          <span className="dlg-t">
            <Icon name={headOf(where, last).icon} size={15} />
            {headOf(where, last).title}
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
                {quiet ? '' : ` · ${s.state === 'needs-you' ? 'waiting on you' : s.state}`}
              </span>
            </span>
          </div>
          <p className="es-body">{body[where]}</p>
          {!quiet && where !== 'checking' ? <p className="es-note">Its history stays: you can resume it later.</p> : null}
          {err ? <div className="ny-err">{err}</div> : null}
        </div>
        <div className="dlg-f">
          <span className="spacer" />
          {/* your call, knowing Cora couldn't tell (where the check can't run, e.g. not on Windows, this is the only way) */}
          {where === 'unknown' ? (
            <button className="btn ghost" onClick={() => void remove()} disabled={busy}>
              Remove from the list anyway
            </button>
          ) : null}
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className={`btn${quiet ? '' : ' danger'}`} onClick={() => void go()} disabled={busy || where === 'checking'} autoFocus>
            {/* the name is in the card above (truncated there): a long one would run out of the button */}
            {where === 'none' ? 'Remove from the list' : where === 'unknown' ? 'Check again' : busy ? 'Ending…' : 'End session'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
