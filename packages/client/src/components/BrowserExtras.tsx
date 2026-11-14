import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { desktop, type CertAsk, type PageDownload } from '../lib/desktop';
import { problemCount, problemsPrompt, type PageProblem } from '../lib/pageProblems';
import { addToDraft } from '../state/composer';
import { Icon } from './Icon';
import './explainAsk.css';
import './browserExtras.css';

// ---- downloads

const useDownloads = create<{ list: PageDownload[]; seen: number }>(() => ({ list: [], seen: 0 }));
let heard = false;
/** Hear the desktop app's downloads (once, for the app). */
function hearDownloads() {
  if (heard || !desktop?.onDownload) return;
  heard = true;
  void desktop.downloads?.().then((l) => useDownloads.setState({ list: l, seen: l.length }));
  desktop.onDownload((d) =>
    useDownloads.setState((s) => {
      if (!d) return { list: s.list.filter((x) => x.state === 'going') };
      return { list: s.list.some((x) => x.id === d.id) ? s.list.map((x) => (x.id === d.id ? d : x)) : [d, ...s.list] };
    }),
  );
}

const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

/** Downloads, by the address bar: there once something has been downloaded; a ring while one is going. */
export function DownloadsButton({ sessionId }: { sessionId?: string }) {
  const list = useDownloads((s) => s.list);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const count = useRef(list.length);
  useEffect(hearDownloads, []);
  // a new one opens the list (you asked for a file: here it is)
  useEffect(() => {
    // (only the browser you're looking at: every session's browser has this button)
    if (list.length > count.current && box.current?.offsetParent) setOpen(true);
    count.current = list.length;
  }, [list.length]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => (window.removeEventListener('mousedown', away), window.removeEventListener('keydown', esc));
  }, [open]);
  if (!list.length) return null;
  const going = list.filter((d) => d.state === 'going');
  return (
    <span className="bx-wrap" ref={box}>
      <button className={`ib${open ? ' on' : ''}${going.length ? ' bx-going' : ''}`} onClick={() => setOpen((o) => !o)} title={going.length ? `${going.length} downloading` : 'Downloads'}>
        <Icon name="Download" size={13} />
      </button>
      {open ? (
        <div className="bx-pop">
          <div className="bx-h">
            <b>Downloads</b>
            {list.some((d) => d.state !== 'going') ? (
              <button className="bx-link" onClick={() => desktop?.downloadAct?.('clear')}>
                Clear
              </button>
            ) : null}
          </div>
          {list.map((d) => (
            <div className={`bx-dl s-${d.state}`} key={d.id}>
              <div className="n" title={d.path}>
                {d.name}
              </div>
              <div className="m">
                {d.state === 'going' ? `${size(d.received)}${d.total ? ` of ${size(d.total)}` : ''}` : d.state === 'done' ? size(d.received || d.total) : d.state === 'cancelled' ? 'Cancelled' : 'Failed'}
              </div>
              {d.state === 'going' ? (
                <div className="bar">
                  <i style={{ width: d.total ? `${Math.min(100, (d.received / d.total) * 100)}%` : '35%' }} />
                </div>
              ) : null}
              <div className="acts">
                {d.state === 'going' ? <button onClick={() => desktop?.downloadAct?.('cancel', d.id)}>Cancel</button> : null}
                {d.state === 'done' ? <button onClick={() => desktop?.downloadAct?.('show', d.id)}>Show in folder</button> : null}
                {d.state === 'done' ? <button onClick={() => void navigator.clipboard.writeText(d.path)}>Copy path</button> : null}
                {d.state === 'done' && sessionId ? (
                  <button className="main" title="Puts its path in the composer, for the session to read" onClick={() => (addToDraft(sessionId, d.path), setOpen(false))}>
                    Give to the session
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </span>
  );
}

// ---- the page's problems, and its DevTools

/**
 * What the page's console says went wrong (a count, there only when there is something): a click puts it all in the
 * session's composer, to send as it is or with your own words; with no session, it's copied.
 */
export function ProblemsButton({ problems, page, sessionId }: { problems: PageProblem[]; page: { url: string; title?: string }; sessionId?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => setDone(false), [problems]);
  if (!problems.length) return null;
  const n = problemCount(problems);
  const text = problemsPrompt(page, problems);
  const go = () => {
    if (sessionId) addToDraft(sessionId, text);
    else void navigator.clipboard.writeText(text);
    setDone(true);
  };
  const first = problems.slice(-4).map((p) => `• ${p.text.split('\n')[0].slice(0, 110)}`).join('\n');
  return (
    <button className={`ib bx-probs${done ? ' done' : ''}`} onClick={go} title={`${n} ${n === 1 ? 'error' : 'errors'} in this page's console. ${sessionId ? "Click to put them in the session's composer" : 'Click to copy them'}:\n\n${first}`}>
      <Icon name={done ? 'Check' : 'Bug'} size={13} />
      <span>{n > 99 ? '99+' : n}</span>
    </button>
  );
}

/** The page's DevTools (F12 in the page does the same), in a window of their own. */
export function DevToolsButton({ wcId }: { wcId: number }) {
  if (!desktop?.devTools) return null;
  return (
    <button className="ib" disabled={!wcId} onClick={() => wcId && desktop?.devTools?.(wcId)} title="DevTools (F12)">
      <Icon name="SquareTerminal" size={13} />
    </button>
  );
}

// ---- a certificate that isn't trusted

const isCert = (a: unknown): a is CertAsk => !!a && typeof a === 'object' && typeof (a as CertAsk).id === 'string' && typeof (a as CertAsk).host === 'string';
const day = (ms: number) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '?');

/**
 * A page whose certificate Chromium doesn't trust: Cora's card for it (a browser shows "your connection is not
 * private"). Continue holds for that site with that certificate until Cora closes. Not continuing is the default: Enter
 * does nothing here, on purpose.
 */
export function CertAskHost() {
  const [asks, setAsks] = useState<CertAsk[]>([]);
  useEffect(() => {
    if (!desktop?.onCertAsk) return;
    const add = (a: unknown) => isCert(a) && setAsks((l) => (l.some((x) => x.id === a.id) ? l : [...l, a]));
    void desktop.certOpen?.().then((l) => l.forEach(add));
    return desktop.onCertAsk(add);
  }, []);
  const ask = asks[0];
  useEffect(() => {
    if (!ask) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), answer(false));
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [ask?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ask) return null;
  const answer = (ok: boolean) => {
    desktop?.certAnswer?.(ask.id, ok);
    setAsks((l) => l.filter((x) => x.id !== ask.id));
  };
  return (
    <div className="xask-scrim" onMouseDown={(e) => e.target === e.currentTarget && answer(false)}>
      <div className="xask bx-cert" role="dialog" aria-label="This site's certificate isn't trusted">
        <div className="xask-h">
          <Icon name="ShieldAlert" size={14} />
          <b>This site's certificate isn't trusted</b>
          {asks.length > 1 ? <span className="more">1 of {asks.length}</span> : null}
        </div>
        <p>
          <b className="site">{ask.host}</b> {ask.why}
        </p>
        <div className={`bx-note${ask.local ? '' : ' warn'}`}>
          {ask.local
            ? "It's on this PC, which is usual for a dev server with its own certificate."
            : "It isn't on this PC. Someone between you and the site could be reading or changing what you send: continue only if you know why its certificate is like this."}
        </div>
        <dl>
          <dt>Issued to</dt>
          <dd>{ask.subject || '?'}</dd>
          <dt>Issued by</dt>
          <dd>{ask.issuer || '?'}</dd>
          <dt>Valid</dt>
          <dd>
            {day(ask.validFrom)} to {day(ask.validTo)}
          </dd>
          <dt>Fingerprint</dt>
          <dd className="fp">{ask.fingerprint}</dd>
        </dl>
        <div className="xask-f">
          <button className="no" onClick={() => answer(true)} title="For this site, with this certificate, until Cora closes">
            Continue to the site
          </button>
          <button className="yes" autoFocus onClick={() => answer(false)}>
            Don't continue
          </button>
        </div>
      </div>
    </div>
  );
}
