import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { ServerMsg } from '@cora/shared';
import { Icon } from './Icon';
import './remoteBrowser.css';

/**
 * A session's browser on your other devices: its tabs'
 * pages render on your PC (out of sight, with its browser's logins) and show here live; taps, scrolls and keys go back.
 */
type RTab = Extract<ServerMsg, { t: 'rbrowse' }>['tabs'][number];
export const useRBrowse = create<{ available: boolean; tabs: RTab[]; active: Record<string, string> }>(() => ({ available: false, tabs: [], active: {} }));
export const applyRBrowse = (m: Extract<ServerMsg, { t: 'rbrowse' }>) => useRBrowse.setState({ available: m.available, tabs: m.tabs });

const post = (url: string, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json().catch(() => ({})));
/** A page for a session, in its remote browser (and on show there). */
export async function openRemote(sessionId: string, url: string): Promise<void> {
  const j = (await post('/api/browse/open', { sessionId, url })) as { tab?: RTab };
  if (j.tab) useRBrowse.setState((s) => ({ active: { ...s.active, [sessionId]: j.tab!.id } }));
}
const withScheme = (s: string) => {
  const t = s.trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  return /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(t) ? `https://${t}` : `https://www.google.com/search?q=${encodeURIComponent(t)}`;
};

export function RemoteBrowserView({ sessionId }: { sessionId: string }) {
  const all = useRBrowse((s) => s.tabs);
  const available = useRBrowse((s) => s.available);
  const activeId = useRBrowse((s) => s.active[sessionId]);
  const tabs = useMemo(() => all.filter((t) => t.sessionId === sessionId), [all, sessionId]);
  // '' : a new tab (the address bar, nothing open yet)
  const tab = activeId === '' ? undefined : (tabs.find((t) => t.id === activeId) ?? tabs.at(-1));
  const [addr, setAddr] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setAddr(tab?.url ?? '');
  }, [tab?.url, editing]);
  const go = () => {
    const url = withScheme(addr);
    setEditing(false);
    if (!url) return;
    if (tab) sockRef.current?.send(JSON.stringify({ t: 'go', url }));
    else void openRemote(sessionId, url);
  };
  // the page: its picture, and what you do to it
  const sockRef = useRef<WebSocket | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<{ src: string; w: number; h: number } | null>(null);
  useEffect(() => {
    setFrame(null);
    if (!tab || !available) return;
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/browse/${tab.id}`);
    sockRef.current = sock;
    const size = () => {
      const r = box.current?.getBoundingClientRect();
      if (r && sock.readyState === 1) sock.send(JSON.stringify({ t: 'size', w: Math.round(r.width), h: Math.round(r.height) }));
    };
    sock.onopen = size;
    sock.onmessage = (m) => {
      try {
        const j = JSON.parse(String(m.data)) as { t: string; data?: string; w?: number; h?: number };
        if (j.t === 'frame' && j.data) setFrame({ src: `data:image/jpeg;base64,${j.data}`, w: j.w ?? 0, h: j.h ?? 0 });
      } catch {
        /* not ours */
      }
    };
    const ro = new ResizeObserver(size);
    if (box.current) ro.observe(box.current);
    return () => {
      ro.disconnect();
      sock.close();
      if (sockRef.current === sock) sockRef.current = null;
    };
  }, [tab?.id, available]);
  const send = (ev: Record<string, unknown>) => sockRef.current?.readyState === 1 && sockRef.current.send(JSON.stringify({ t: 'input', ev }));
  const nav = (action: string) => sockRef.current?.readyState === 1 && sockRef.current.send(JSON.stringify({ t: 'nav', action }));
  /** a point on the picture, as the page's own */
  const at = (cx: number, cy: number) => {
    const r = box.current!.getBoundingClientRect();
    const sx = frame?.w ? frame.w / r.width : 1;
    const sy = frame?.h ? frame.h / r.height : 1;
    return { x: (cx - r.left) * sx, y: (cy - r.top) * sy };
  };
  const drag = useRef<{ x: number; y: number; lx: number; ly: number; moved: boolean; touch: boolean } | null>(null);
  const lastMove = useRef(0);
  const mods = (e: React.KeyboardEvent | React.PointerEvent) => [e.shiftKey && 'shift', e.ctrlKey && 'control', e.altKey && 'alt', e.metaKey && 'meta'].filter(Boolean);

  return (
    <div className="rb">
      <div className="rb-tabs">
        {tabs.map((t) => (
          <span key={t.id} className={`rb-tab${t.id === tab?.id ? ' on' : ''}`} onClick={() => useRBrowse.setState((s) => ({ active: { ...s.active, [sessionId]: t.id } }))} title={t.url}>
            {t.loading ? <i className="rb-spin" /> : null}
            <span>{t.title}</span>
            <button aria-label="Close tab" onClick={(e) => (e.stopPropagation(), void post(`/api/browse/${t.id}/close`))}>
              <Icon name="X" size={12} />
            </button>
          </span>
        ))}
        <button className="rb-ib" title="New tab" onClick={() => (setAddr(''), setEditing(true), useRBrowse.setState((s) => ({ active: { ...s.active, [sessionId]: '' } })))}>
          <Icon name="Plus" size={15} />
        </button>
      </div>
      <div className="rb-bar">
        <button className="rb-ib" disabled={!tab?.canBack} onClick={() => nav('back')} aria-label="Back">
          <Icon name="ArrowLeft" size={16} />
        </button>
        <button className="rb-ib" disabled={!tab?.canForward} onClick={() => nav('forward')} aria-label="Forward">
          <Icon name="ArrowRight" size={16} />
        </button>
        <button className="rb-ib" disabled={!tab} onClick={() => nav(tab?.loading ? 'stop' : 'reload')} aria-label="Reload">
          <Icon name={tab?.loading ? 'X' : 'RotateCw'} size={15} />
        </button>
        <input value={addr} placeholder="An address, or words to search" onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url" />
        <button className="rb-ib" disabled={!tab} title="Open this page on this device (its own logins)" onClick={() => tab && window.open(tab.url, '_blank', 'noopener')}>
          <Icon name="ExternalLink" size={15} />
        </button>
      </div>
      <div
        className="rb-page"
        ref={box}
        tabIndex={0}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).focus();
          drag.current = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, touch: e.pointerType !== 'mouse' };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d?.touch) {
            // a finger dragging: the page scrolls with it
            const dx = e.clientX - d.lx;
            const dy = e.clientY - d.ly;
            if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 8) d.moved = true;
            if (d.moved && (dx || dy)) {
              const p = at(e.clientX, e.clientY);
              send({ type: 'wheel', ...p, dx: -dx, dy: -dy });
            }
            d.lx = e.clientX;
            d.ly = e.clientY;
          } else if (Date.now() - lastMove.current > 80) {
            // the trackpad's pointer: hovers on the page
            lastMove.current = Date.now();
            send({ type: 'move', ...at(e.clientX, e.clientY) });
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) send({ type: 'tap', ...at(e.clientX, e.clientY) });
        }}
        onWheel={(e) => send({ type: 'wheel', ...at(e.clientX, e.clientY), dx: e.deltaX, dy: e.deltaY })}
        onKeyDown={(e) => {
          if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt') return;
          e.preventDefault();
          send({ type: 'key', key: e.key, mods: mods(e) });
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (text) send({ type: 'text', text });
        }}
      >
        {!available ? (
          <div className="rb-empty">
            <Icon name="MonitorOff" size={18} />
            <b>Your PC's browser isn't here</b>
            <span>The pages render in the Cora app on your PC: it needs to be running.</span>
          </div>
        ) : !tab ? (
          <div className="rb-empty">
            <Icon name="Globe" size={18} />
            <b>No pages yet</b>
            <span>Type an address above. Pages this session opens show here too, signed in as on your PC.</span>
          </div>
        ) : frame ? (
          <img className="rb-img" src={frame.src} alt="" draggable={false} />
        ) : (
          <div className="rb-empty">
            <i className="rb-spin big" />
            <span>Opening it on your PC…</span>
          </div>
        )}
      </div>
    </div>
  );
}
