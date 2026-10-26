import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { useBrain } from '../state/store';
import { shortCwd } from '../lib/format';
import { Icon } from './Icon';
import './dialogs.css';

/** What deep freeze kept: sessions open when Cora (or the PC) last went down, and their shells. */
export type ThawItem = { sessionId: string; cwd: string; claude: boolean; name: string; shells: Array<{ id: string; shell?: string; place?: 'board' }> };

export const useThaw = create<{ items: ThawItem[]; at: number | null; open: boolean }>(() => ({ items: [], at: null, open: false }));

/** What there is to bring back (the card opens by itself once, when Cora starts with something to offer). */
export async function loadThaw(show = false): Promise<void> {
  const r = await fetch('/api/freeze').catch(() => null);
  if (!r?.ok) return;
  const j = (await r.json()) as { at: number | null; items: ThawItem[] };
  useThaw.setState({ items: j.items, at: j.at, ...(show && j.items.length ? { open: true } : {}) });
}

/** A Board's Terminal panels held the old shells: they hold the new ones now. */
function moveShells(map: Record<string, string>): void {
  if (!Object.keys(map).length) return;
  const st = useBrain.getState();
  const boards = st.prefs.boards;
  if (!boards) return;
  const swap = (id: string) => map[id] ?? id;
  const next = Object.fromEntries(
    Object.entries(boards).map(([sid, b]) => [
      sid,
      { ...b, items: b.items.map((p) => (p.k === 'terminal' && (p.term || p.terms) ? { ...p, ...(p.term ? { term: swap(p.term) } : {}), ...(p.terms ? { terms: p.terms.map(swap) } : {}) } : p)) },
    ]),
  );
  st.setPrefs({ boards: next });
}

const when = (at: number | null) => {
  if (!at) return '';
  const d = new Date(at);
  const today = d.toDateString() === new Date().toDateString();
  return `${today ? 'today' : d.toLocaleDateString(undefined, { weekday: 'long' })} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
};

/**
 * Deep freeze, coming back: after the PC restarted (the terminal host and its sessions gone), Cora offers what was open:
 * each session resumed in its folder with its conversation, its terminals opened again. What was running in them (a dev
 * server, a long command) doesn't come back. Bring back all or some, not now (the palette offers it again), or forget.
 */
export function ThawCard() {
  const { items, at, open } = useThaw();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setPicked(new Set(items.map((i) => i.sessionId))), [items]);
  if (!open || !items.length) return null;
  const close = () => useThaw.setState({ open: false });
  const toggle = (sid: string) => setPicked((p) => (p.has(sid) ? new Set([...p].filter((x) => x !== sid)) : new Set([...p, sid])));
  const bring = async () => {
    setBusy(true);
    setErr(null);
    const r = await fetch('/api/freeze/thaw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionIds: [...picked] }) }).catch(() => null);
    setBusy(false);
    const j = r ? ((await r.json().catch(() => ({}))) as { started?: number; shells?: Record<string, string>; errors?: string[]; error?: string }) : { error: "Can't reach Cora's server." };
    if (j.shells) moveShells(j.shells);
    if (j.error || j.errors?.length) setErr(j.error ?? j.errors!.join(' · '));
    await loadThaw();
    if (!j.error && !j.errors?.length) close();
  };
  const forget = async () => {
    await fetch('/api/freeze/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }).catch(() => {});
    useThaw.setState({ items: [], open: false });
  };
  const n = picked.size;
  return createPortal(
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal dlg thaw" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dlg-h">
          <span className="dlg-t">
            <Icon name="Snowflake" size={15} />
            Pick up where you left off
          </span>
          <span className="spacer" />
          <button className="dlg-x" title="Not now" onClick={close}>
            <Icon name="X" size={15} />
          </button>
        </div>
        <div className="dlg-b">
          <p className="th-why">
            {items.length === 1 ? 'A session was' : `${items.length} sessions were`} open when Cora last closed{at ? `, ${when(at)}` : ''}. Bring them back: each resumes in its folder with its
            conversation, and its terminals open again.
          </p>
          <div className="th-list">
            {items.map((it) => (
              <label key={it.sessionId} className={`th-row${picked.has(it.sessionId) ? ' on' : ''}`}>
                <input type="checkbox" checked={picked.has(it.sessionId)} onChange={() => toggle(it.sessionId)} />
                <span className="th-name">
                  <b>{it.name}</b>
                  <span>{shortCwd(it.cwd)}</span>
                </span>
                <span className="th-what">
                  {it.claude ? <em>Claude</em> : null}
                  {it.shells.length ? <em>{it.shells.length === 1 ? '1 terminal' : `${it.shells.length} terminals`}</em> : null}
                </span>
              </label>
            ))}
          </div>
          <p className="th-note">Anything that was running in them (a dev server, a long command) won't restart: start it again yourself.</p>
          {err ? <div className="ny-err">{err}</div> : null}
        </div>
        <div className="dlg-f">
          <button className="btn ghost" onClick={() => void forget()} title="Don't offer these again">
            Forget them
          </button>
          <span className="spacer" />
          <button className="btn ghost" onClick={close}>
            Not now
          </button>
          <button className="btn allow" disabled={!n || busy} onClick={() => void bring()} autoFocus>
            {busy ? 'Bringing back…' : `Bring back ${n === items.length && n > 1 ? `all ${n}` : n}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
