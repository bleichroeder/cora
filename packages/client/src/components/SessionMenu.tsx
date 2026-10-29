import { useEffect, useRef, useState } from 'react';
import { ProjectMenuRows } from './Projects';
import { SESSION_ICONS, type SessionInfo } from '@cora/shared';
import { useBrain } from '../state/store';
import { MAIN_COLORS, isDismissed, sessionColor, sessionName, shortCwd } from '../lib/format';
import { Icon } from './Icon';
import { nudgeOrder, saveOrder } from '../lib/sessionOrder';
// (the palette hosts the end-session confirm; it imports this file too, but only uses it when it runs)
import { usePalette } from './Palette';
import './popovers.css';

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function setSessionMeta(id: string, meta: { alias?: string | null; color?: string | null; icon?: string | null; ticket?: null }) {
  const r = await post(`/api/sessions/${encodeURIComponent(id)}/meta`, meta);
  if (r.ok) useBrain.getState().upsertSession(await r.json());
}

/**
 * Its icon: the one it picked when it was named, or yours. A
 * searchable grid of the session icons, and None for the plain square of its colour.
 */
function IconPick({ s }: { s: SessionInfo }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const words = q.trim().toLowerCase();
  const shown = words ? SESSION_ICONS.filter((n) => n.toLowerCase().includes(words.replace(/[^a-z0-9]/g, ''))) : SESSION_ICONS;
  const pick = (icon: string | null) => void setSessionMeta(s.id, { icon }).then(() => setOpen(false));
  return (
    <div className="sm-icons" style={{ ['--sc' as any]: sessionColor(s) }}>
      <div className="sm-icon-now">
        <button className="ses-tile" title={open ? 'Hide the icons' : 'Choose its icon'} onClick={() => setOpen(!open)}>
          {s.icon ? <Icon name={s.icon} size={15} /> : <i className="ses-core" />}
        </button>
        <span>{s.icon ?? 'None'}</span>
        <button className="mini" onClick={() => setOpen(!open)}>
          {open ? 'done' : 'change'}
        </button>
      </div>
      {open ? (
        <>
          <input className="sm-icon-q" value={q} placeholder={`Search ${SESSION_ICONS.length} icons`} autoFocus onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <div className="sm-icon-grid">
            <button className={`sm-icon none${s.icon ? '' : ' on'}`} title="None: a plain square of its colour" onClick={() => pick(null)}>
              <i className="ses-core" />
            </button>
            {shown.map((n) => (
              <button key={n} className={`sm-icon${s.icon === n ? ' on' : ''}`} title={n} onClick={() => pick(n)}>
                <Icon name={n} size={15} />
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Show a session here; one removed from the list comes back into it (focus can't stay on a removed session). */
export function showSession(sid: string): void {
  const st = useBrain.getState();
  const s = st.sessions[sid];
  if (s && isDismissed(s)) {
    st.upsertSession({ ...s, dismissedAt: null });
    void dismissSession(sid, true);
  }
  st.setFocus(sid);
}

export async function dismissSession(id: string, undo = false): Promise<string | null> {
  return (await dismiss(id, { undo }))?.error ?? null;
}

async function dismiss(id: string, body: { undo?: boolean; closeShells?: boolean }): Promise<{ error: string; shells?: number } | null> {
  const r = await post(`/api/sessions/${encodeURIComponent(id)}/dismiss`, body);
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string; shells?: number };
    return { error: j.error ?? 'failed', ...(j.shells ? { shells: j.shells } : {}) };
  }
  useBrain.getState().upsertSession(await r.json());
  return null;
}

/**
 * Take a session off the list. Shells of its still open in Cora (a tab beside it, a shell on its Board) would run on
 * out of sight: you're asked, and they're closed with it. Null when it's off; else why not ('' when you said no).
 */
export async function removeSession(id: string): Promise<string | null> {
  const r = await dismiss(id, {});
  if (!r?.shells) return r?.error ?? null;
  const n = r.shells;
  const ok = window.confirm(`It has ${n === 1 ? 'a shell' : `${n} shells`} open in Cora (beside it, or on its Board). Close ${n === 1 ? 'it' : 'them'} and take the session off the list?\n\nWhatever runs in ${n === 1 ? 'it' : 'them'} ends.`);
  if (!ok) return '';
  return (await dismiss(id, { closeShells: true }))?.error ?? null;
}

/** "Suggest a name": a quick Haiku call names the session from its first prompt (it replaces your name for it). */
export async function suggestName(id: string): Promise<string | null> {
  const r = await post(`/api/sessions/${encodeURIComponent(id)}/autoname`, {});
  if (!r.ok) return (await r.json().catch(() => ({}))).error ?? 'failed';
  useBrain.getState().upsertSession(await r.json());
  return null;
}

export async function clearEnded() {
  await post('/api/sessions/dismiss-ended', {});
}

/** Right-click menu for a session in the list: name, colour, dismiss. */
export function SessionMenu({ s, x, y, onClose }: { s: SessionInfo; x: number; y: number; onClose(): void }) {
  const [name, setName] = useState(s.alias ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const hosted = useBrain((st) => st.terminals.some((t) => t.sessionId === s.id && t.alive));

  useEffect(() => {
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const saveName = () => void setSessionMeta(s.id, { alias: name.trim() || null });
  const suggest = async () => {
    setErr(null);
    setNaming(true);
    const e = await suggestName(s.id);
    setNaming(false);
    if (e) setErr(e);
    else setName('');
  };
  const current = sessionColor(s);

  const label = sessionName(s);
  const go = (f: () => unknown) => () => (f(), onClose());
  return (
    <div className="session-menu" ref={box} style={{ left: x, top: Math.min(y, window.innerHeight - 380) }}>
      {/* the session, as its row */}
      <div className="sm-h" style={{ ['--sc' as any]: current }}>
        <span className="ses-tile sm-tile">{s.icon ? <Icon name={s.icon} size={15} /> : <i className="ses-core" />}</span>
        <span className="sm-t">
          <b>{label}</b>
          <span>{shortCwd(s.cwd)}</span>
        </span>
      </div>
      <div className="sm-gl">Name</div>
      <div className="sm-name">
        <input
          value={name}
          placeholder={sessionName({ ...s, alias: null })}
          maxLength={60}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              saveName();
              onClose();
            }
          }}
        />
        <button className="sm-i" disabled={naming} title={naming ? 'Naming…' : 'Suggest a name (a quick Haiku call names it from its first prompt)'} onMouseDown={(e) => e.preventDefault()} onClick={() => void suggest()}>
          <Icon name={naming ? 'LoaderCircle' : 'Sparkles'} size={14} />
        </button>
      </div>
      <div className="sm-gl">Colour</div>
      <div className="swatches">
        {MAIN_COLORS.map((c) => (
          <button key={c} className={`swatch${c === current ? ' on' : ''}`} style={{ background: c }} onClick={() => void setSessionMeta(s.id, { color: c })} title={c} />
        ))}
        <input type="color" value={current} onChange={(e) => void setSessionMeta(s.id, { color: e.target.value })} title="Custom colour" />
        {s.color ? (
          <button className="mini" onClick={() => void setSessionMeta(s.id, { color: null })}>
            auto
          </button>
        ) : null}
      </div>
      <div className="sm-gl">Icon</div>
      <IconPick s={s} />
      <ProjectMenuRows s={s} onDone={onClose} />
      <div className="sm-sep" />
      {s.state !== 'ended'
        ? ([-1, 1] as const).map((dir) => {
            const ids = nudgeOrder(useBrain.getState().sessions, s.id, dir, (v) => !isDismissed(v));
            return (
              <button key={dir} className="sm-row" disabled={!ids} title="Or drag it in the list" onClick={() => ids && void saveOrder(ids).then(onClose)}>
                <Icon name={dir < 0 ? 'ChevronUp' : 'ChevronDown'} size={14} /> Move {dir < 0 ? 'up' : 'down'}
              </button>
            );
          })
        : null}
      {s.ticket ? (
        <button className="sm-row" title={`It isn't about ${s.ticket.key} after all: no ticket card, not named after it`} onClick={go(() => void setSessionMeta(s.id, { ticket: null }))}>
          <Icon name="TicketX" size={14} /> Not about {s.ticket.key}
        </button>
      ) : null}
      {isDismissed(s) ? (
        <button className="sm-row" onClick={() => void dismissSession(s.id, true).then(onClose)}>
          <Icon name="Eye" size={14} /> Show in the list again
        </button>
      ) : (
        <button
          className="sm-row"
          disabled={hosted}
          title={hosted ? 'Running in Cora: end it first' : 'Off the list until it has new activity; Resume still has it'}
          onClick={async () => {
            const e = await removeSession(s.id);
            if (e) setErr(e);
            else if (e == null) onClose();
          }}
        >
          <Icon name="EyeOff" size={14} /> Remove from the list
        </button>
      )}
      {s.state !== 'ended' ? (
        <>
          <div className="sm-sep" />
          <button className="sm-row bad" onClick={go(() => usePalette.setState({ ending: s.id }))}>
            <Icon name="Power" size={14} /> End session…
          </button>
        </>
      ) : null}
      {err ? <div className="ny-err">{err}</div> : null}
    </div>
  );
}
