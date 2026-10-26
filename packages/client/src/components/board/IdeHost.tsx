import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { desktop } from '../../lib/desktop';
import { WEB_PARTITION } from '../WebPane';

/**
 * The IDE panels' VS Code pages, kept alive across sessions: a page in Cora's window is destroyed when it leaves the
 * page (and starts over when it comes back), so each lives here, in one layer that's always there, laid over its
 * panel while the panel shows and hidden (not closed) while it doesn't. Switching sessions or Board pages then finds
 * VS Code as you left it. The last few stay; older ones close.
 */
const KEEP = 3;

type View = { src: string; key: string; at: number };
/** where a panel showing it is, and how high it must sit to be over that panel (a panel made full size sits higher) */
type Rect = { x: number; y: number; w: number; h: number; z: number };

/**
 * The pages, and where each shows: a session's panel can show more than once (the Board's copy, and the same panel
 * made full size over it): the one shown last has it, and when that goes the one before takes it back.
 */
export const useIdeViews = create<{ views: Record<string, View>; boxes: Record<string, Array<{ id: string; rect: Rect | null }>> }>(() => ({ views: {}, boxes: {} }));

/** How high it sits over a panel: just over the Board (1); a panel made full size sits higher, so just over that. */
function levelOver(el: HTMLElement): number {
  const max = el.closest('.bd-max');
  const z = max ? Number(getComputedStyle(max).zIndex) : NaN;
  return Number.isFinite(z) ? z + 1 : 1;
}

/** A panel shows a session's VS Code: its page (made once), laid over `box` while it's on screen. */
export function useIdeView(sessionId: string, src: string | null, loadKey: string, box: React.RefObject<HTMLElement | null>): void {
  // the page: made (or its address changed) when the panel asks
  useEffect(() => {
    if (!src) return;
    useIdeViews.setState((s) => {
      const cur = s.views[sessionId];
      if (cur && cur.src === src && cur.key === loadKey) return { views: { ...s.views, [sessionId]: { ...cur, at: Date.now() } } };
      const views = { ...s.views, [sessionId]: { src, key: loadKey, at: Date.now() } };
      // the last few stay
      const order = Object.entries(views).sort((a, b) => b[1].at - a[1].at);
      for (const [sid] of order.slice(KEEP)) delete views[sid];
      return { views };
    });
  }, [sessionId, src, loadKey]);
  // where it shows: the panel's box, followed every frame while it's on screen (the Board moves and resizes it); this
  // box is the newest for the session while it's there
  const id = useRef(`b${Math.random().toString(36).slice(2, 9)}`).current;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !src) return;
    let raf = 0;
    let last = '';
    let z = levelOver(el);
    let n = 0;
    const put = (rect: Rect | null) =>
      useIdeViews.setState((s) => {
        // (in its place: only showing up makes a box the newest, not moving)
        const all = s.boxes[sessionId] ?? [];
        const next = all.some((b) => b.id === id) ? all.map((b) => (b.id === id ? { id, rect } : b)) : [...all, { id, rect }];
        return { boxes: { ...s.boxes, [sessionId]: next } };
      });
    const follow = () => {
      const r = el.getBoundingClientRect();
      if (++n % 30 === 0) z = levelOver(el);
      const rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), z };
      const k = `${rect.x},${rect.y},${rect.w},${rect.h},${rect.z}`;
      if (k !== last) (last = k), put(rect.w > 0 && rect.h > 0 ? rect : null);
      raf = requestAnimationFrame(follow);
    };
    follow();
    return () => {
      cancelAnimationFrame(raf);
      useIdeViews.setState((s) => ({ boxes: { ...s.boxes, [sessionId]: (s.boxes[sessionId] ?? []).filter((b) => b.id !== id) } }));
    };
  }, [sessionId, src, box, id]);
}

/** The layer: every kept VS Code page, each over its panel or hidden. Mounted once, beside the Board. */
export function IdeHost() {
  const views = useIdeViews((s) => s.views);
  const boxes = useIdeViews((s) => s.boxes);
  // each over the newest box showing it
  const where = (sid: string) => boxes[sid]?.at(-1)?.rect ?? null;
  return (
    <div className="ide-host" aria-hidden={!Object.keys(views).some((sid) => where(sid))}>
      {Object.entries(views).map(([sid, v]) => (
        <IdeView key={`${sid}:${v.key}`} src={v.src} rect={where(sid)} />
      ))}
    </div>
  );
}

function IdeView({ src, rect }: { src: string; rect: Rect | null }) {
  // its first address only: VS Code moves itself around inside (files, the folder) without a reload
  const [first] = useState(src);
  const el = useRef<HTMLElement>(null);
  const style: React.CSSProperties = rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: rect.z } : { left: -10_000, top: 0, width: 800, height: 600, visibility: 'hidden' };
  return (
    <div className={`ide-view${rect ? ' on' : ''}`} style={style}>
      {desktop?.browser ? <webview ref={el as never} src={first} partition={WEB_PARTITION} {...({ allowpopups: 'true' } as object)} /> : <iframe src={first} title="VS Code" />}
    </div>
  );
}
