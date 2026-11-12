import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { IMAGE_EXT, fileName, type FileRef } from '../lib/filePaths';
import { previews } from '../state/composer';
import { desktop } from '../lib/desktop';
import { copyText } from './Linkify';
import { Icon } from './Icon';
import './filePeek.css';

/**
 * A file a transcript names, looked at where it's named: a card by the path with what it is (a picture, a text file's
 * first lines at its line, a folder's contents) and Open (a picture in your viewer; text in VS Code when the IDE panel
 * has its folder, else Notepad), Show in folder, Copy path. Nothing else is ever opened (desktop main.ts ab:open-file).
 */

type Peek = { sessionId: string; ref: FileRef; at: DOMRect };
const usePeek = create<{ peek: Peek | null }>(() => ({ peek: null }));

export const openPeek = (sessionId: string, ref: FileRef, el: Element) => usePeek.setState({ peek: { sessionId, ref, at: el.getBoundingClientRect() } });
export const closePeek = () => usePeek.setState({ peek: null });

/** A picture's address: the composer's own copy while it has one, else Cora reads it off disk. */
export const imageUrl = (sessionId: string, path: string) => previews.get(path) ?? `/api/sessions/${encodeURIComponent(sessionId)}/file/raw?path=${encodeURIComponent(path)}`;

type Info =
  | { kind: 'image'; path: string; size: number }
  | { kind: 'text'; path: string; size: number; text: string; truncated: boolean }
  | { kind: 'dir'; path: string; entries: string[] }
  | { kind: 'binary'; path: string; size: number };

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 102.4) / 10} KB` : `${Math.round(n / 104857.6) / 10} MB`);

/** Mounted once (App): the card, while one is open. */
export function FilePeekHost() {
  const peek = usePeek((s) => s.peek);
  return peek ? createPortal(<PeekCard key={`${peek.sessionId}:${peek.ref.path}:${peek.ref.line ?? ''}`} p={peek} />, document.body) : null;
}

function PeekCard({ p }: { p: Peek }) {
  const box = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: p.at.left, top: p.at.bottom + 6 });
  useEffect(() => {
    let live = true;
    fetch(`/api/sessions/${encodeURIComponent(p.sessionId)}/file?path=${encodeURIComponent(p.ref.path)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (r.ok) setInfo(j as Info);
        else setErr((j as { error?: string }).error ?? `HTTP ${r.status}`);
      })
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [p.sessionId, p.ref.path]);
  // beside the path: below it, or above when there's no room; never off the window
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(p.at.left, window.innerWidth - w - 8));
    const below = p.at.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, p.at.top - h - 6) : below;
    setPos({ left, top });
  }, [p.at, info, err]);
  useEffect(() => {
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && closePeek();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), closePeek());
    const away = () => closePeek();
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', away);
    };
  }, []);

  const path = info?.path ?? p.ref.path;
  const image = info?.kind === 'image' || (!info && IMAGE_EXT.test(p.ref.path));
  const open = async () => {
    if (!info || !desktop?.openFile) return;
    if (info.kind === 'image') {
      const r = await desktop.openFile(path, 'viewer');
      if (r.error) setSaid(r.error);
      else closePeek();
      return;
    }
    // text: VS Code at its line, when the IDE panel has its folder open; else Notepad
    const ide = await fetch('/api/ide/show', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: p.sessionId, path, ...(p.ref.line ? { line: p.ref.line } : {}) }) })
      .then((r) => r.json())
      .catch(() => ({}));
    if ((ide as { ok?: boolean }).ok) return closePeek();
    const r = await desktop.openFile(path, 'text');
    if (r.error) setSaid(r.error);
    else closePeek();
  };
  const dir = path.slice(0, Math.max(0, path.length - fileName(path).length)).replace(/[\\/]$/, '');

  return (
    <div className="fp" ref={box} style={{ left: pos.left, top: pos.top }} role="dialog" aria-label={fileName(path)}>
      <div className="fp-h">
        <span className="fp-ico">
          <Icon name={image ? 'Image' : info?.kind === 'dir' ? 'Folder' : info?.kind === 'binary' ? 'File' : 'FileText'} size={14} />
        </span>
        <span className="fp-t">
          <b>
            {fileName(path)}
            {p.ref.line ? <i>:{p.ref.line}</i> : null}
          </b>
          <span title={path}>{dir}</span>
        </span>
        {info && 'size' in info ? <span className="fp-size">{size(info.size)}</span> : null}
        <button className="icon-btn" title="Close (Esc)" onClick={closePeek}>
          <Icon name="X" size={13} />
        </button>
      </div>
      <div className="fp-b">
        {err ? (
          <div className="fp-msg">{err}</div>
        ) : !info ? (
          <div className="fp-msg">Looking…</div>
        ) : info.kind === 'image' ? (
          <img className="fp-img" src={imageUrl(p.sessionId, path)} alt={fileName(path)} />
        ) : info.kind === 'text' ? (
          <TextPeek text={info.text} line={p.ref.line} truncated={info.truncated} />
        ) : info.kind === 'dir' ? (
          <ul className="fp-dir">{info.entries.length ? info.entries.map((e) => <li key={e}>{e}</li>) : <li className="dim">(empty)</li>}</ul>
        ) : (
          <div className="fp-msg">Not a text file ({size(info.size)}): open it from its folder.</div>
        )}
      </div>
      <div className="fp-f">
        {said ? <span className="fp-said">{said}</span> : <span className="spacer" />}
        <button className="btn ghost" onClick={() => (copyText(path), setSaid('Copied'))}>
          <Icon name="Copy" size={12} /> Copy path
        </button>
        {desktop?.openFile && info && info.kind !== 'dir' ? (
          <button className="btn ghost" onClick={() => void desktop!.openFile!(path, 'folder').then((r) => (r.error ? setSaid(r.error) : closePeek()))}>
            <Icon name="FolderOpen" size={12} /> Show in folder
          </button>
        ) : null}
        {desktop?.openFile && info && (info.kind === 'image' || info.kind === 'text') ? (
          <button className="btn" onClick={() => void open()} title={info.kind === 'image' ? 'In your image viewer' : 'In VS Code (when the IDE panel has its folder), else Notepad'}>
            <Icon name="ExternalLink" size={12} /> Open
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A text file's first lines, numbered, at its line (marked) when one was named. */
function TextPeek({ text, line, truncated }: { text: string; line?: number; truncated: boolean }) {
  const pre = useRef<HTMLDivElement>(null);
  const lines = text.split('\n');
  useEffect(() => {
    if (!line) return;
    pre.current?.querySelector('.on')?.scrollIntoView({ block: 'center' });
  }, [line]);
  return (
    <div className="fp-code" ref={pre}>
      {lines.map((l, i) => (
        <div key={i} className={`fp-ln${line === i + 1 ? ' on' : ''}`}>
          <span className="fp-no">{i + 1}</span>
          <span className="fp-tx">{l || ' '}</span>
        </div>
      ))}
      {truncated ? <div className="fp-more">{line && line > lines.length ? `Line ${line} is further in: open the file.` : '…more in the file'}</div> : null}
    </div>
  );
}

/** A prompt's pictures, under its words: small thumbnails; a click looks closer (Open puts it in your viewer). */
export function PromptImages({ sessionId, paths }: { sessionId: string; paths: string[] }) {
  return (
    <div className="p-imgs">
      {paths.map((path) => (
        <Thumb key={path} sessionId={sessionId} path={path} />
      ))}
    </div>
  );
}

function Thumb({ sessionId, path }: { sessionId: string; path: string }) {
  const [gone, setGone] = useState(false);
  return (
    <button className={`p-img${gone ? ' gone' : ''}`} title={path} onClick={(e) => (e.stopPropagation(), openPeek(sessionId, { path }, e.currentTarget))}>
      {gone ? (
        <>
          <Icon name="ImageOff" size={13} /> <span>{fileName(path)}</span>
        </>
      ) : (
        <img src={imageUrl(sessionId, path)} alt={fileName(path)} loading="lazy" onError={() => setGone(true)} />
      )}
    </button>
  );
}
