import { useEffect, useMemo, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BrainEvent } from '@cora/shared';
import { sessionEvents, useBrain } from '../state/store';
import { ago, sessionName } from '../lib/format';
import './viewer.css';
import { fetchToolDetail } from '../state/ws';
import { desktop } from '../lib/desktop';
import { Markdown } from './Markdown';
import { Icon } from './Icon';
import { explainShim, themeVars } from '../lib/explainShim';
import { versionsOf } from '../lib/explainVersions';
import { liveKey, loadLiveData, useLiveData } from '../state/liveExplains';

export { PRESENT_TOOL } from '@cora/shared';
import { artifactUrl, isPresentTool, shareFileName } from '@cora/shared';
export type Explain = {
  sessionId: string;
  toolUseId: string;
  title: string;
  format: 'markdown' | 'html';
  content?: string;
  /** opened from another session's list: shown over whatever session is focused, closed when focus changes */
  pinned?: boolean;
  /** a live explain's folder name: its data comes in as the session writes it */
  live?: string;
  /** you stepped back to an older version: a new one doesn't replace it on screen */
  held?: boolean;
};

/** Content-Security-Policy for model-written HTML: no network except fonts and two script CDNs. */
const CSP =
  "default-src 'none'; img-src data: blob: https:; media-src data: blob:; style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; " +
  "font-src https://fonts.gstatic.com data:; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; connect-src 'none'; form-action 'none'; base-uri 'none'";

const BASE_STYLE = `<style>html{color-scheme:dark}body{margin:0;padding:24px;background:#0b0f17;color:#e2e8f0;font:14px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}</style>`;

/** Wrap HTML (fragment or full document) with the CSP; it is only ever rendered sandboxed. `extra`: Cora's shim. */
export function sandboxedHtml(html: string, extra = ''): string {
  const meta = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">${extra}`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}${BASE_STYLE}</head>`);
  return `<!doctype html><html><head>${meta}${BASE_STYLE}</head><body>${html}</body></html>`;
}

const DOC_STYLE = `<style>
html{color-scheme:dark}body{margin:0 auto;max-width:900px;padding:32px 28px;background:#0b0f17;color:#e2e8f0;font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
h1,h2,h3{color:#f8fafc;line-height:1.25}a{color:#38bdf8}code{font:.9em ui-monospace,Consolas,monospace;background:#111a28;border:1px solid #1e293b;border-radius:4px;padding:.05em .35em;color:#fde68a}
pre{background:#070b12;border:1px solid #1e293b;border-radius:8px;padding:12px;overflow:auto}pre code{background:none;border:none;color:#cbd5e1}
table{border-collapse:collapse}th,td{border:1px solid #263246;padding:6px 10px;text-align:left}th{background:#0f1724}blockquote{border-left:3px solid #334155;margin:0;padding:0 1em;color:#94a3b8}
</style>`;

/** A full HTML document, whatever the format field says (models sometimes label HTML as markdown). */
export const looksLikeHtmlDoc = (s: string) => /^\s*(<!doctype html|<html[\s>])/i.test(s);

export function explainFrom(e: BrainEvent): Explain | null {
  if (!isPresentTool(e.tool?.name) || !e.toolUseId) return null;
  const inp = (e.tool.input ?? {}) as { title?: string; format?: string; content?: unknown; _truncated?: boolean; preview?: string; live?: unknown };
  // Explains stored before inputs were kept whole are truncated to a JSON preview: title and format are near the
  // start of it, and the content is fetched from the transcript when the viewer opens.
  const preview = inp._truncated && typeof inp.preview === 'string' ? inp.preview : '';
  const rawTitle = preview.match(/"title":"((?:[^"\\]|\\.)*)"/)?.[1];
  const title = inp.title ?? (rawTitle != null ? (JSON.parse(`"${rawTitle}"`) as string) : undefined);
  const content = typeof inp.content === 'string' && !inp._truncated ? inp.content : undefined;
  const format = inp.format ?? preview.match(/"format":"(\w+)"/)?.[1];
  return {
    sessionId: e.sessionId,
    toolUseId: e.toolUseId,
    title: String(title ?? 'Document'),
    format: format === 'html' || (content != null && looksLikeHtmlDoc(content)) ? 'html' : 'markdown',
    content,
    ...(typeof inp.live === 'string' && /^[\w-]{1,60}$/.test(inp.live) ? { live: inp.live } : {}),
  };
}

export function Viewer({ p }: { p: Explain }) {
  const close = () => useBrain.getState().setViewer(null);
  // a live explain: its newest data (posted into the page as it comes, no reload), and where you'd scrolled to
  const key = p.live ? liveKey(p.sessionId, p.live) : '';
  const liveData = useLiveData((s) => (key ? s[key] : undefined));
  const frame = useRef<HTMLIFrameElement>(null);
  const scroll = useRef(0);
  const dataNow = useRef<unknown>(undefined);
  dataNow.current = liveData;
  useEffect(() => {
    if (p.live) void loadLiveData(p.sessionId, p.live);
  }, [p.sessionId, p.live]);
  useEffect(() => {
    if (p.live && liveData !== undefined) frame.current?.contentWindow?.postMessage({ cora: 'data', data: liveData }, '*');
  }, [liveData, p.live]);
  useEffect(() => {
    const m = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && e.data?.cora === 'scroll' && typeof e.data.y === 'number') scroll.current = e.data.y;
    };
    window.addEventListener('message', m);
    return () => window.removeEventListener('message', m);
  }, []);
  // its versions (the same title in that session), oldest first
  const sessionVersion = useBrain((s) => s.versions[p.sessionId]);
  const versions = useMemo(
    () => versionsOf(sessionEvents(p.sessionId).flatMap((e) => (e.kind === 'tool' && e.phase === 'start' ? (explainFrom(e) ? [{ ...explainFrom(e)!, ts: e.ts }] : []) : [])), { sessionId: p.sessionId, title: p.title, ts: 0 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.sessionId, p.title, sessionVersion],
  );
  const at = versions.findIndex((v) => v.toolUseId === p.toolUseId);
  const step = (d: -1 | 1) => {
    const v = versions[at + d];
    if (!v) return;
    const { ts: _ts, ...next } = v;
    // stepping back holds this version on screen; back at the newest, it follows again
    useBrain.getState().setViewer({ ...next, pinned: p.pinned, held: at + d < versions.length - 1 });
  };
  const wide = useBrain((s) => s.viewerWide);
  const [content, setContent] = useState<string | null>(p.content ?? null);
  const [err, setErr] = useState<string | null>(null);
  // what the last button did, for a moment ("Copied", "Saved")
  const [done, setDone] = useState<{ what: 'copy' | 'save' | 'link'; text: string } | null>(null);
  const html = p.format === 'html' || (content != null && looksLikeHtmlDoc(content));
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), done.what === 'save' ? 4000 : 1800);
    return () => clearTimeout(t);
  }, [done]);

  useEffect(() => {
    setContent(p.content ?? null);
    setErr(null);
    if (p.content) return;
    void fetchToolDetail(p.sessionId, p.toolUseId).then((d) => {
      const c = (d?.input as { content?: string } | undefined)?.content;
      if (typeof c === 'string') setContent(c);
      else setErr('Could not load this document from the transcript yet.');
    });
  }, [p.sessionId, p.toolUseId, p.content]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && t.tagName !== 'TEXTAREA' && t.tagName !== 'INPUT') close();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // sharing: its session (running here) publishes a copy as a claude.ai artifact; the link is in that publish
  const hosted = useBrain((s) => s.terminals.some((t) => t.sessionId === p.sessionId && t.alive));
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const publish = useMemo(() => {
    const name = shareFileName(p.title).toLowerCase();
    const ev = sessionEvents(p.sessionId)
      .filter((e) => e.kind === 'tool' && e.phase === 'end' && e.tool?.name === 'Artifact' && !e.tool.failed && e.toolUseId)
      .filter((e) => String((e.tool!.input as { file_path?: unknown } | undefined)?.file_path ?? '').replace(/\\/g, '/').toLowerCase().endsWith(`/${name}`))
      .at(-1);
    return ev?.toolUseId ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.sessionId, p.title, sessionVersion]);
  useEffect(() => {
    setShareUrl(null);
    if (!publish) return;
    let on = true;
    void fetchToolDetail(p.sessionId, publish).then((d) => {
      const url = d && !d.isError ? artifactUrl(d.result) : null;
      if (on && url) {
        setShareUrl(url);
        setSharing(false);
      }
    });
    return () => void (on = false);
  }, [p.sessionId, publish]);
  useEffect(() => setSharing(false), [p.sessionId, p.title]);
  const share = (url?: string) => {
    if (content == null) return;
    const copy = html ? sandboxedHtml(content, explainShim({ vars: themeVars((n) => getComputedStyle(document.documentElement).getPropertyValue(n)), live: !!p.live, data: dataNow.current })) : standalone();
    setSharing(true);
    void fetch('/api/explains/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: p.sessionId, title: p.title, html: copy, ...(url ? { url } : {}) }) })
      .then(async (r) => (r.ok ? null : (((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`)))
      .catch((e) => String(e))
      .then((e) => {
        if (e) {
          setSharing(false);
          setErr(`Couldn't share it: ${e}`);
        }
      });
  };

  // when it was written, and by which session (when that isn't the one on show)
  const ev = sessionEvents(p.sessionId).find((e) => e.toolUseId === p.toolUseId);
  const when = ev ? `${ago(ev.ts)} ago` : '';
  const owner = useBrain((s) => (s.sessions[p.sessionId] ? sessionName(s.sessions[p.sessionId]) : ''));

  // the page as it's shown: Cora's theme in every HTML explain; a live one's data and scroll as they were when it (re)loads
  const page = useMemo(
    () => (content != null && html ? sandboxedHtml(content, explainShim({ vars: themeVars((n) => getComputedStyle(document.documentElement).getPropertyValue(n)), live: !!p.live, data: dataNow.current, scroll: scroll.current })) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, html, p.live],
  );

  const standalone = () =>
    html
      ? sandboxedHtml(content ?? '')
      : sandboxedHtml(`<!doctype html><html><head><title>${p.title.replace(/</g, '&lt;')}</title>${DOC_STYLE}</head><body>${renderToStaticMarkup(<Markdown text={content ?? ''} chips={false} />)}</body></html>`);

  return (
    <div className="viewer">
      <div className="viewer-h">
        {/* its format's tile, as in the Explains list */}
        <span className={`vw-tile ${html ? 'html' : 'md'}`}>
          <Icon name={html ? 'Monitor' : 'FileText'} size={14} />
        </span>
        <span className="vw-t">
          <b>{p.title}</b>
          <span>{[html ? 'HTML' : 'markdown', when, owner].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="spacer" />
        {versions.length > 1 && at >= 0 ? (
          <span className="vw-ver" title="Earlier versions of this explain">
            <button className="vw-i" disabled={at === 0} onClick={() => step(-1)} title="An earlier version">
              <Icon name="ChevronLeft" size={14} />
            </button>
            <span>
              {at + 1}/{versions.length}
            </span>
            <button className="vw-i" disabled={at === versions.length - 1} onClick={() => step(1)} title="A later version">
              <Icon name="ChevronRight" size={14} />
            </button>
          </span>
        ) : null}
        {content ? (
          <button
            className={`vw-b${done?.what === 'copy' ? ' done' : ''}`}
            onClick={() =>
              void navigator.clipboard
                ?.writeText(content)
                .then(() => setDone({ what: 'copy', text: 'Copied' }))
                .catch(() => setErr("Couldn't copy it"))
            }
            title="Copy source"
          >
            <Icon name={done?.what === 'copy' ? 'Check' : 'Copy'} size={14} /> {done?.what === 'copy' ? 'Copied' : 'Copy'}
          </button>
        ) : null}
        {content && shareUrl ? (
          <>
            <button
              className={`vw-b${done?.what === 'link' ? ' done' : ''}`}
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(shareUrl)
                  .then(() => setDone({ what: 'link', text: 'Copied' }))
                  .catch(() => setErr("Couldn't copy it"))
              }
              title={`Shared as a claude.ai artifact: ${shareUrl}. Copy the link to send it`}
            >
              <Icon name={done?.what === 'link' ? 'Check' : 'Link'} size={14} /> {done?.what === 'link' ? 'Copied' : 'Copy link'}
            </button>
            <button className="vw-i" disabled={sharing} onClick={() => share(shareUrl)} title={sharing ? 'Its session is updating the shared copy…' : 'Update the shared copy to this version (its session republishes it)'}>
              <Icon name="RefreshCw" size={14} />
            </button>
          </>
        ) : content && hosted ? (
          <button className="vw-b" disabled={sharing} onClick={() => share()} title={sharing ? 'Its session is publishing it (you may be asked to allow it there)…' : 'Share as a claude.ai artifact: its session publishes a private copy you can send a link to'}>
            <Icon name="Share2" size={14} /> {sharing ? 'Sharing…' : 'Share'}
          </button>
        ) : null}
        {desktop?.saveExplain && content ? (
          <button
            className={`vw-b${done?.what === 'save' ? ' done' : ''}`}
            onClick={() =>
              void desktop!.saveExplain!(p.title, html ? 'html' : 'md', html && !looksLikeHtmlDoc(content) ? sandboxedHtml(content) : content).then((r) =>
                r.path ? setDone({ what: 'save', text: r.path }) : setErr(`Couldn't save it: ${r.error ?? 'unknown'}`),
              )
            }
            title={done?.what === 'save' ? done.text : 'Save as a file in Documents\\Cora\\Explains and show it in File Explorer'}
          >
            <Icon name={done?.what === 'save' ? 'Check' : 'FolderOpen'} size={14} /> {done?.what === 'save' ? 'Saved' : 'Save'}
          </button>
        ) : null}
        {desktop && content ? (
          <button className="vw-i" onClick={() => desktop!.popout(p.title, standalone())} title="Pop out into its own window">
            <Icon name="SquareArrowOutUpRight" size={14} />
          </button>
        ) : null}
        <button className="vw-i" onClick={() => useBrain.getState().setViewerWide(!wide)} title={wide ? 'Back to the scene area' : 'Use the whole window'}>
          <Icon name={wide ? 'Minimize2' : 'Maximize2'} size={14} />
        </button>
        <button className="vw-i" onClick={close} title="Close (Esc)">
          <Icon name="X" size={15} />
        </button>
      </div>
      <div className="viewer-body">
        {err ? <div className="ny-err">{err}</div> : null}
        {content == null && !err ? <div className="dim pad">loading…</div> : null}
        {content != null && !html ? (
          <div className="doc">
            <Markdown text={content} />
          </div>
        ) : null}
        {content != null && html ? (
          // allow-scripts WITHOUT allow-same-origin: an opaque origin with no access to the dashboard, its cookie or its APIs.
          <iframe ref={frame} className="html-frame" title={p.title} sandbox="allow-scripts" srcDoc={page} />
        ) : null}
      </div>
    </div>
  );
}
