import { useEffect, useRef, useState } from 'react';
import type { SessionFlag, SessionInfo } from '@cora/shared';
import { useBrain } from '../state/store';
import { useOnScreen } from '../lib/onScreen';
import { sessionColor, sessionName, shortCwd } from '../lib/format';
import { comeBackTo, flagSession, flagTitle, remindChoices, rowOf, unflagSession, useFlagPop, whenWords, whyKey } from '../lib/sessionFlag';
import { oops } from '../state/oops';
import { Icon } from './Icon';
import './popovers.css';

/**
 * A row's bookmark (its own slot at the end of the row's second line): on hover when it isn't flagged, in the accent
 * colour when it is, brighter once its reminder came. A click flags it (and offers a why and a reminder) or clears it.
 */
export function FlagMark({ id, flag, now = Date.now() }: { id: string; flag: SessionFlag | null | undefined; now?: number }) {
  return (
    <span
      className={`ses-fl${flag ? ' on' : ''}${flag?.due ? ' due' : ''}`}
      role="button"
      aria-label={flag ? 'Clear the flag' : 'Come back to this'}
      aria-pressed={!!flag}
      title={flagTitle(flag, now)}
      onClick={(e) => {
        e.stopPropagation();
        void (flag ? unflagSession(id) : comeBackTo(id)).then((err) => err && oops("Couldn't change the flag", err));
      }}
    >
      <Icon name={flag?.due ? 'BookmarkCheck' : 'Bookmark'} size={11} fill={flag ? 'currentColor' : 'none'} />
    </span>
  );
}

/** The flag's popover, by its row: its why (one line), a reminder, clear it. Everything is optional; Esc or a click away closes it. */
export function FlagPop() {
  const pop = useFlagPop();
  const s = useBrain((st) => (pop.id ? st.sessions[pop.id] : undefined));
  if (!pop.id || !s?.flag || !('x' in pop)) return null;
  return <FlagPopFor key={s.id} s={s as SessionInfo & { flag: SessionFlag }} x={pop.x} y={pop.y} />;
}

function FlagPopFor({ s, x, y }: { s: SessionInfo & { flag: SessionFlag }; x: number; y: number }) {
  const [note, setNote] = useState(s.flag.note ?? '');
  const [picking, setPicking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const at = useOnScreen(box, x, y);
  // closed: back to its row (in the drawer too, which stays open behind it), a beat later: never inside the keystroke
  // or click that closed it, which would press the row
  const close = () => {
    useFlagPop.setState({ id: null });
    setTimeout(() => rowOf(s.id)?.focus(), 0);
  };
  const said = (err: string | null) => err && oops("Couldn't change the flag", err);
  // (saved once, whichever way it closes: Enter, Esc, blur, a click away)
  const kept = useRef(s.flag.note ?? '');
  const saveNote = () => {
    const v = note.trim();
    if (v === kept.current) return;
    kept.current = v;
    void flagSession(s.id, { note: v || null }).then(said);
  };
  const remind = (remindAt: number | null) => void flagSession(s.id, { remindAt }).then(said);
  // a click away or Esc: the why as written is kept
  const latest = useRef(saveNote);
  latest.current = saveNote;
  useEffect(() => {
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && (latest.current(), close());
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), latest.current(), close());
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => (window.removeEventListener('mousedown', down), window.removeEventListener('keydown', key));
  }, []);
  const now = Date.now();
  const r = s.flag.remindAt;
  return (
    <div className="session-menu flag-pop" ref={box} style={{ ...at, ['--sc' as any]: sessionColor(s) }}>
      <div className="sm-h">
        <span className="ses-tile sm-tile">{s.icon ? <Icon name={s.icon} size={15} /> : <i className="ses-core" />}</span>
        <span className="sm-t">
          <b>{sessionName(s)}</b>
          <span>{shortCwd(s.cwd)}</span>
        </span>
      </div>
      <div className="sm-gl">
        <Icon name="Bookmark" size={11} fill="currentColor" className="fp-mark" /> Come back to this
      </div>
      <div className="sm-name">
        <input
          value={note}
          placeholder="Why? (optional)"
          maxLength={120}
          autoFocus
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => whyKey(e, () => (saveNote(), close()))}
        />
      </div>
      <div className="sm-gl">Remind me</div>
      {r ? (
        <div className={`fp-now${s.flag.due ? ' due' : ''}`}>
          <Icon name={s.flag.due ? 'BellRing' : 'Bell'} size={13} />
          <span>{s.flag.due ? `Came ${whenWords(r, now)}` : whenWords(r, now)}</span>
          <button className="mini" onClick={() => remind(null)}>
            remove
          </button>
        </div>
      ) : null}
      <div className="fp-when">
        {remindChoices(now).map((c) => (
          <button key={c.label} className={`fp-chip${r === c.at ? ' on' : ''}`} onClick={() => remind(c.at)}>
            {c.label}
          </button>
        ))}
        <button className={`fp-chip${picking ? ' on' : ''}`} onClick={() => setPicking(!picking)}>
          Pick a time
        </button>
      </div>
      {picking ? (
        <input
          className="fp-pick"
          type="datetime-local"
          autoFocus
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const t = new Date(e.target.value).getTime();
            if (Number.isFinite(t) && t > Date.now()) (remind(t), setPicking(false));
          }}
        />
      ) : null}
      <div className="sm-sep" />
      <button className="sm-row" onClick={() => void unflagSession(s.id).then((err) => (said(err), close()))}>
        <Icon name="BookmarkX" size={14} /> Clear the flag
      </button>
    </div>
  );
}

/** A folded group's flagged sessions, counted (a flag is never out of sight). */
export function FlagCount({ n }: { n: number }) {
  return (
    <span className="ses-flags" title={`${n} flagged to come back to`}>
      <Icon name="Bookmark" size={10} fill="currentColor" />
      {n}
    </span>
  );
}
