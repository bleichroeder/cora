import { useEffect, useRef, useState } from 'react';
import type { IdeStatus } from '@cora/shared';
import { useBrain } from '../../state/store';
import { useIdeView } from './IdeHost';
import { Icon } from '../Icon';

/** The folder as VS Code's web address wants it: a path, forward slashes (`/c:/code/cora` on Windows). */
export function ideFolder(cwd: string): string {
  const p = cwd.replace(/\\/g, '/');
  return /^[a-z]:/i.test(p) ? `/${p[0].toLowerCase()}${p.slice(1)}` : p;
}

/**
 * A file in the IDE panel's VS Code (its window open on the file's folder): at a line, or a turn's change to it as a
 * diff (`from`/`to`: the turn). False: no IDE panel open on that folder.
 */
export async function showInIde(sessionId: string, path: string, o: { line?: number; from?: number; to?: number | null } = {}): Promise<boolean> {
  const r = await fetch('/api/ide/show', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, path, ...o }) }).catch(() => null);
  return !!r?.ok && !!((await r.json()) as { ok?: boolean }).ok;
}

async function call(method: 'GET' | 'POST', path: string, body?: object): Promise<IdeStatus | null> {
  const r = await fetch(path, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }).catch(() => null);
  return r?.ok ? ((await r.json()) as IdeStatus) : null;
}

/**
 * The IDE panel: your VS Code (the real one: your extensions, the debugger, git, its terminal), served on this
 * machine by your installed VS Code and opened at the session's folder. Started when you ask (the first time you
 * accept Microsoft's server licence); one VS Code serves every panel.
 */
export function IdePanel({ sessionId }: { sessionId: string }) {
  const cwd = useBrain((s) => s.sessions[sessionId]?.cwd);
  const [st, setSt] = useState<IdeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const sawInstall = useRef(false);
  // how it is; again every second while it starts
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout>;
    const look = async () => {
      const s = await call('GET', '/api/ide');
      if (!live) return;
      setSt(s);
      // (and once it's up, until it's said whether Claude Code's extension is in: it's added then)
      if (s?.claude === 'installing') sawInstall.current = true;
      if (s?.state === 'starting' || s?.claude === 'installing' || (s?.state === 'ready' && !s.claude)) t = setTimeout(look, 1000);
    };
    void look();
    return () => ((live = false), clearTimeout(t));
  }, [busy]);
  const start = async (accept: boolean) => {
    setBusy(true);
    // its theme takes your Cora colour
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--cora').trim();
    setSt(await call('POST', '/api/ide/start', { accept, ...(/^#[0-9a-f]{6}$/i.test(accent) ? { accent } : {}) }));
    setBusy(false);
  };

  // Claude Code's extension just added (we saw it go in): the page again, so VS Code loads it
  const loadKey = sawInstall.current && st?.claude === 'ready' ? 'with-claude' : 'plain';
  const src = st?.state === 'ready' && st.url && cwd ? `${st.url}&folder=${encodeURIComponent(ideFolder(cwd))}` : null;
  // VS Code itself lives in the IDE layer (kept as you switch sessions), laid over this box
  const box = useRef<HTMLDivElement>(null);
  useIdeView(sessionId, src, loadKey, box);
  if (!st) return <div className="lb-empty">Looking for VS Code…</div>;
  if (src)
    return (
      <div className="lb-ide" ref={box}>
        {st.claude === 'installing' ? <span className="lb-ide-note">Adding Claude Code to VS Code…</span> : null}
      </div>
    );
  return (
    <div className="lb-ide-start">
      <Icon name="Code" size={22} />
      {st.state === 'missing' ? (
        <>
          <b>VS Code isn't installed</b>
          <span>The IDE panel is your own VS Code, shown here. Install it, then open this panel again.</span>
          <a href="https://code.visualstudio.com/download" target="_blank" rel="noopener noreferrer">
            Get VS Code
          </a>
        </>
      ) : st.state === 'starting' ? (
        <>
          <b>
            <span className="dl-glyph run" /> {st.message || 'Starting VS Code…'}
          </b>
          <span>The first time it fetches the server that matches your VS Code, which can take a minute.</span>
        </>
      ) : (
        <>
          <b>{st.state === 'error' ? "VS Code didn't start" : 'Your VS Code, in this panel'}</b>
          <span>
            {st.state === 'error'
              ? st.message
              : `Your installed VS Code serves itself on this machine only, opened at ${cwd ?? "the session's folder"}: your extensions, the debugger, git and its terminal.`}
          </span>
          {st.state === 'needs-ok' ? (
            <span className="lic">
              Starting it accepts Microsoft's{' '}
              <a href={st.license} target="_blank" rel="noopener noreferrer">
                VS Code Server licence
              </a>
              .
            </span>
          ) : null}
          <button className="btn allow" disabled={busy || !cwd} onClick={() => void start(st.state === 'needs-ok')}>
            <Icon name="Play" size={12} /> {st.state === 'error' ? 'Try again' : 'Start VS Code'}
          </button>
        </>
      )}
    </div>
  );
}
