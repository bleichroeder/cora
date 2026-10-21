import { useEffect, useRef, useState } from 'react';
import type { OpLogin } from '@cora/shared';
import { closeOpMenu, fillOp, hostOf, loginsFor, menuStyle, searchOp, setOverMenu, useOp, type OpPlace } from '../state/onepassword';
import { openSettings } from './SettingsModal';
import { Icon } from './Icon';
import './onepassword.css';

/**
 * The 🔑 menu: the page's logins from 1Password (title, username, vault), and a search for others (one found that way
 * fills only once you say yes to this site). Picking one asks the desktop app to fill it: no password comes here.
 */
export function OpMenu() {
  const menu = useOp((s) => s.menu);
  if (!menu) return null;
  return <Menu key={`${menu.from}:${menu.suggest ? 's' : 'm'}`} from={menu.from} place={menu} />;
}

/** The page's <webview> in Cora's window (a session's tab, or a Tool in the drawer). */
function webviewOf(id: number): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll('webview'))) {
    try {
      if ((el as unknown as { getWebContentsId(): number }).getWebContentsId() === id) return el as HTMLElement;
    } catch {
      /* not attached yet */
    }
  }
  return null;
}

function Menu({ from, place }: { from: number; place: OpPlace }) {
  const [state, setState] = useState<{ url?: string; logins?: OpLogin[]; error?: string } | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<OpLogin[] | null>(null);
  const [confirm, setConfirm] = useState<OpLogin | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const site = hostOf(state?.url ?? useOp.getState().forms[from]?.url ?? '');

  useEffect(() => void loginsFor(from).then(setState), [from]);
  // a suggestion with nothing to suggest (or 1Password said no): it goes, quietly
  useEffect(() => {
    if (place.suggest && state && (state.error || !state.logins?.length)) closeOpMenu();
  }, [place.suggest, state]);
  useEffect(() => () => setOverMenu(false), []);
  const wv = webviewOf(from)?.getBoundingClientRect();
  const style = menuStyle(place, wv && wv.width ? wv : null, { w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && closeOpMenu();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => {
    setConfirm(null);
    if (!q.trim()) return setFound(null);
    let live = true;
    const t = setTimeout(() => void searchOp(q).then((r) => live && (r.error ? setErr(r.error) : setFound(r.logins ?? []))), 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const fill = async (l: OpLogin, anySite: boolean) => {
    setBusy(l.id);
    setErr(null);
    const r = await fillOp(from, l.id, anySite);
    setBusy(null);
    if (r.error) return setErr(r.error);
    const what = r.filled ? [r.filled.username && 'username', r.filled.password && 'password', r.filled.totp && 'code'].filter(Boolean) : [];
    setDone(what.length ? `Filled the ${what.join(', ').replace(/, ([^,]*)$/, ' and $1')}` : 'Nothing on this page to fill: is the form showing?');
    if (what.length) setTimeout(closeOpMenu, 1100);
  };
  const row = (l: OpLogin, anySite: boolean) => (
    <button key={l.id} className="op-row" disabled={!!busy} onClick={() => (anySite ? setConfirm(l) : void fill(l, false))} title={l.urls.join('\n') || 'No website saved'}>
      <span className="op-tile">
        <Icon name="KeyRound" size={13} />
      </span>
      <span className="op-t">
        <b>{l.title || 'Untitled'}</b>
        <span>
          {l.username || 'no username'}
          {l.vault ? ` · ${l.vault}` : ''}
        </span>
      </span>
      {busy === l.id ? <span className="op-busy">filling…</span> : null}
    </button>
  );

  return (
    <div className={`op-bg${place.suggest ? ' suggest' : ''}`} onMouseDown={closeOpMenu}>
      <div className="op-menu" style={style} onMouseDown={(e) => e.stopPropagation()} onMouseEnter={() => setOverMenu(true)} onMouseLeave={() => setOverMenu(false)} role="dialog" aria-label="1Password">
        <div className="op-h">
          <Icon name="KeyRound" size={14} />
          <b>1Password</b>
          <span className="op-site">{site}</span>
          <span className="sp" />
          <button className="icon-btn" title="Close (Esc)" onClick={closeOpMenu}>
            <Icon name="X" size={13} />
          </button>
        </div>
        {done ? <div className="op-done">{done}</div> : null}
        {err ? <div className="ny-err op-err">{err}</div> : null}
        {!state ? (
          <div className="op-note">Asking 1Password… it may ask you to unlock (Windows Hello).</div>
        ) : state.error ? (
          <div className="op-note">
            {state.error}
            <button className="linkish" onClick={() => (closeOpMenu(), openSettings('onepassword'))}>
              1Password settings
            </button>
          </div>
        ) : !found ? (
          state.logins!.length ? (
            <div className="op-list">{state.logins!.map((l) => row(l, false))}</div>
          ) : (
            <div className="op-note">No login in 1Password for {site}. Search for one below.</div>
          )
        ) : null}
        {found ? <div className="op-list">{found.length ? found.map((l) => row(l, true)) : <div className="op-note">Nothing in 1Password matches.</div>}</div> : null}
        {confirm ? (
          <div className="op-confirm">
            <span>
              Fill <b>{confirm.title}</b> on <b>{site}</b>? It isn't saved for this site.
            </span>
            <button className="btn allow" disabled={!!busy} onClick={() => void fill(confirm, true)}>
              Fill
            </button>
            <button className="btn ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        ) : null}
        {state && !state.error ? (
          <label className="dlg-inp op-search">
            <Icon name="Search" size={13} />
            <input ref={searchRef} value={q} placeholder="Search 1Password for another login" onChange={(e) => setQ(e.target.value)} spellCheck={false} />
          </label>
        ) : null}
      </div>
    </div>
  );
}
