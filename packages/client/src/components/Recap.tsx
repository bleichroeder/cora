import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { recapText, type Recap } from '@cora/shared';
import { useBrain } from '../state/store';
import { ago } from '../lib/format';
import { Icon } from './Icon';
import './recap.css';

/**
 * Claude Code's recaps of a session (written when you come back to it after a while away: where it stands, what's
 * next), the way the CLI shows them (※ recap). The latest sits between the transcript and the composer; the board's
 * Recap panel has them all; hovering a session in the nav shows its latest beside the nav.
 */

const HIDDEN = 'cora.recap.hidden';
const hiddenAt = (sid: string): number => {
  try {
    return (JSON.parse(localStorage.getItem(HIDDEN) ?? '{}') as Record<string, number>)[sid] ?? 0;
  } catch {
    return 0;
  }
};
const hide = (sid: string, at: number) => {
  try {
    const m = JSON.parse(localStorage.getItem(HIDDEN) ?? '{}') as Record<string, number>;
    localStorage.setItem(HIDDEN, JSON.stringify({ ...m, [sid]: at }));
  } catch {
    /* not kept: it shows again next time */
  }
};

/** The session's latest recap, between the transcript and the composer (until you put it away; the next one shows). */
export function RecapBar({ sessionId }: { sessionId: string }) {
  const recap = useBrain((s) => s.sessions[sessionId]?.recap);
  const [gone, setGone] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => (setGone(hiddenAt(sessionId)), setOpen(false)), [sessionId]);
  if (!recap || recap.at <= gone) return null;
  return (
    <div className={`recap-bar${open ? ' open' : ''}`} role="note" aria-label="Recap">
      <span className="rc-k">
        <i>※</i> recap
      </span>
      <button className="rc-t" onClick={() => setOpen(!open)} title={open ? 'Show less' : 'Show all of it'}>
        {recapText(recap.text)}
      </button>
      <span className="rc-when" title={new Date(recap.at).toLocaleString()}>
        {ago(recap.at)} ago
      </span>
      <button className="rc-x" title="Put it away (the next recap shows)" onClick={() => (hide(sessionId, recap.at), setGone(recap.at))}>
        <Icon name="X" size={12} />
      </button>
    </div>
  );
}

/** A session's recaps (newest first), fetched again when a new one comes. */
function useRecaps(sessionId: string): Recap[] | null {
  const latest = useBrain((s) => s.sessions[sessionId]?.recap?.at);
  const [list, setList] = useState<Recap[] | null>(null);
  useEffect(() => {
    let on = true;
    void fetch(`/api/recaps?session=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : { recaps: [] }))
      .then((j: { recaps: Recap[] }) => on && setList([...j.recaps].reverse()))
      .catch(() => on && setList([]));
    return () => void (on = false);
  }, [sessionId, latest]);
  return list;
}

/** The board's Recap panel: the session's recaps as the CLI shows them, newest first: the story of the work. */
export function RecapPanel({ sessionId }: { sessionId: string }) {
  const list = useRecaps(sessionId);
  if (!list) return <div className="lb-empty">…</div>;
  if (!list.length) return <div className="lb-empty">No recaps yet. Claude Code writes one when you come back to a session after a while away.</div>;
  return (
    <div className="lb-recaps">
      {list.map((r, i) => (
        <div key={r.id} className={`lb-rc${i === 0 ? ' latest' : ''}`}>
          <div className="rc-h">
            <span className="rc-k">
              <i>※</i> recap
            </span>
            <span className="rc-when" title={new Date(r.at).toLocaleString()}>
              {new Date(r.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} · {ago(r.at)} ago
            </span>
          </div>
          <p>{recapText(r.text)}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Hovering a session in the nav (a moment): its latest recap, beside the nav (where Cora's cards show, never over the
 * nav), pointing at its row.
 */
export function RecapPeek({ sessionId, row }: { sessionId: string; row: HTMLElement }) {
  const recap = useBrain((s) => s.sessions[sessionId]?.recap);
  const [pos, setPos] = useState<{ left: number; top: number; arrow: number } | null>(null);
  useLayoutEffect(() => {
    const nav = row.closest('.rail')?.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (!nav) return;
    const top = Math.max(48, Math.min(r.top - 8, window.innerHeight - 180));
    setPos({ left: nav.right + 12, top, arrow: Math.round(r.top + r.height / 2 - top - 5) });
  }, [row]);
  if (!recap || !pos) return null;
  return createPortal(
    <div className="recap-peek" style={{ left: pos.left, top: pos.top, ['--arrow' as never]: `${pos.arrow}px` }} role="tooltip">
      <div className="rc-h">
        <span className="rc-k">
          <i>※</i> recap
        </span>
        <span className="rc-when">{ago(recap.at)} ago</span>
      </div>
      <p>{recapText(recap.text)}</p>
    </div>,
    document.body,
  );
}
