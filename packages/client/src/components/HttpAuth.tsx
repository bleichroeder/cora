import { useEffect, useRef, useState } from 'react';
import { desktop, type HttpAuthAsk } from '../lib/desktop';
import { Icon } from './Icon';
import './explainAsk.css';
import './httpAuth.css';

const isAsk = (a: unknown): a is HttpAuthAsk => !!a && typeof a === 'object' && typeof (a as HttpAuthAsk).id === 'string' && typeof (a as HttpAuthAsk).host === 'string';

/**
 * A page in Cora's browser wants an HTTP sign-in (Basic and the like, or a proxy's): Cora's own card for it (a browser
 * shows a form of its own; Electron shows none). One site at a time; what you type goes to the desktop app and on to
 * the page, and is kept (when you say so) in memory until Cora closes: never written anywhere.
 */
export function HttpAuthHost() {
  const [asks, setAsks] = useState<HttpAuthAsk[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [keep, setKeep] = useState(true);
  const user = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!desktop?.onHttpAuth) return;
    const add = (a: unknown) => isAsk(a) && setAsks((l) => (l.some((x) => x.id === a.id) ? l : [...l, a]));
    // (the ones still open from before this window loaded)
    void desktop.httpAuthOpen?.().then((l) => l.forEach(add));
    return desktop.onHttpAuth(add);
  }, []);
  const ask = asks[0];
  useEffect(() => {
    setPassword('');
    if (ask) setTimeout(() => user.current?.focus(), 30);
  }, [ask?.id]);
  if (!ask) return null;
  const answer = (ok: boolean) => {
    desktop?.httpAuthAnswer?.(ok ? { id: ask.id, username, password, keep } : { id: ask.id });
    setPassword('');
    setAsks((l) => l.filter((x) => x.id !== ask.id));
  };
  const where = `${ask.host}${ask.port && ask.port !== 80 && ask.port !== 443 ? `:${ask.port}` : ''}`;
  return (
    <div className="xask-scrim" onMouseDown={(e) => e.target === e.currentTarget && answer(false)}>
      <form
        className="xask hauth"
        role="dialog"
        aria-label="Sign in"
        onSubmit={(e) => (e.preventDefault(), username && answer(true))}
        onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), answer(false))}
      >
        <div className="xask-h">
          <Icon name="KeyRound" size={14} />
          <b>{ask.proxy ? 'The proxy wants a sign-in' : 'Sign in'}</b>
          {asks.length > 1 ? <span className="more">1 of {asks.length}</span> : null}
        </div>
        <p>
          <b className="site">{where}</b>
          {ask.realm ? <> asks for a username and password ("{ask.realm}").</> : <> asks for a username and password.</>}
        </p>
        {ask.failed ? (
          <div className="hauth-note bad">
            <Icon name="CircleAlert" size={12} /> That sign-in wasn't accepted. Try again.
          </div>
        ) : null}
        {ask.plain ? (
          <div className="hauth-note warn">
            <Icon name="TriangleAlert" size={12} /> This page isn't encrypted (http): the password crosses the network readable.
          </div>
        ) : null}
        <label>
          <span>Username</span>
          <input ref={user} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} maxLength={256} />
        </label>
        <label>
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" maxLength={1024} />
        </label>
        <label className="keep">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          <span>Keep for this site until Cora closes</span>
        </label>
        <div className="xask-f">
          <button type="button" className="no" onClick={() => answer(false)}>
            Cancel
          </button>
          <button type="submit" className="yes" disabled={!username}>
            Sign in
          </button>
        </div>
      </form>
    </div>
  );
}
