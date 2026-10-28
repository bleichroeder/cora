import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMemeNews } from './memeNews';
import { MEME_TOOL, type MemeMode, type MemePost, type Settings } from '@cora/shared';
import { sessionEvents, useBrain } from '../../state/store';
import { ago } from '../../lib/format';
import { openSettings } from '../SettingsModal';
import { openInBrowser } from '../JiraChip';
import './memes.css';

/** An empty wall: a few blank stickers taped up, waiting (nothing to look at but the shape of what comes). */
function BlankStickers() {
  return (
    <div className="mm-blanks" aria-hidden>
      <i />
      <i />
      <i />
    </div>
  );
}

/**
 * A drawn meme with a size of its own: an SVG with only a viewBox has none, and an image without one shrinks to almost
 * nothing wherever nothing else sizes it (it showed as a sliver when opened large). Its viewBox's, else 600 by 400.
 */
function sized(svg: string): string {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!open || (/\swidth\s*=/.test(open) && /\sheight\s*=/.test(open))) return svg;
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(open);
  const [w, h] = vb ? [vb[1], vb[2]] : ['600', '400'];
  return svg.replace(open, open.replace(/<svg\b/i, `<svg width="${w}" height="${h}"`));
}

/** A meme: its template with the captions drawn on, the way memes look (big white letters with a black outline). */
export function MemeImage({ p, small = false, onShape }: { p: MemePost; small?: boolean; /** its height over its width, once loaded */ onShape?(r: number): void }) {
  const loaded = (e: React.SyntheticEvent<HTMLImageElement>) => onShape?.(e.currentTarget.naturalHeight / Math.max(1, e.currentTarget.naturalWidth));
  if (p.kind === 'gif') return <img className="mm-img" src={p.url} alt={p.query ?? 'GIF'} draggable={false} onLoad={loaded} />;
  // one Claude drew: as an image, so it can't run anything or load anything from outside
  if (p.kind === 'svg') return <img className="mm-img drawn" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized(p.svg ?? ''))}`} alt="" draggable={false} onLoad={loaded} />;
  return (
    <span className={`mm-meme${small ? ' small' : ''}`}>
      <img className="mm-img" src={p.url} alt={p.template ?? 'meme'} draggable={false} onLoad={loaded} />
      {p.top ? <span className="mm-cap top">{p.top}</span> : null}
      {p.bottom ? <span className="mm-cap bottom">{p.bottom}</span> : null}
    </span>
  );
}

/**
 * The Meme panel: what this session posts (its `meme` tool) about what's happening, the latest big with why, the
 * earlier ones under it. Memes are off until you turn them on (Settings › Sessions › Memes).
 */
export function MemePanel({ sessionId }: { sessionId: string }) {
  const version = useBrain((s) => s.versions[sessionId]);
  // a new post shows as the session's meme call ends
  const calls = useMemo(() => sessionEvents(sessionId).filter((e) => e.kind === 'tool' && e.phase === 'end' && e.tool?.name === MEME_TOOL).length, [sessionId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  // and as the server says one was posted (however it was made)
  const posted = useMemeNews((s) => s.by[sessionId] ?? 0);
  const [posts, setPosts] = useState<MemePost[] | null>(null);
  const [mode, setMode] = useState<MemeMode | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void fetch(`/api/memes?session=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : { posts: [] }))
      .then((j: { posts: MemePost[] }) => live && (setPosts(j.posts), setPicked(null)))
      .catch(() => live && setPosts([]));
    return () => void (live = false);
  }, [sessionId, calls, posted]);
  // whether memes are on: looked at again whenever Settings closes (where they're turned on)
  const settingsOpen = useBrain((s) => s.modal === 'settings');
  useEffect(() => {
    if (settingsOpen) return;
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((s: Settings) => setMode(s.memes?.mode ?? 'off'))
      .catch(() => {});
  }, [settingsOpen]);
  if (!posts) return <div className="lb-empty">…</div>;
  if (!posts.length)
    return (
      <div className="mm-empty">
        <BlankStickers />
        {mode == null ? null : mode === 'off' ? (
          <>
            <p>Memes are off, so this session won&apos;t post any.</p>
            <button className="lb-pop" onClick={() => openSettings('sessions')}>
              Turn them on
            </button>
          </>
        ) : (
          <p>Nothing yet. This session posts a meme or a GIF when something happens, or ask it for one.</p>
        )}
      </div>
    );
  // a sticker off the wall, or all of them (the server tells the other panels)
  const remove = async (id?: string) => {
    setPosts((cur) => (cur ? (id ? cur.filter((p) => p.id !== id) : []) : cur));
    if (!id || id === picked) setPicked(null);
    await fetch(`/api/memes?session=${encodeURIComponent(sessionId)}${id ? `&id=${encodeURIComponent(id)}` : ''}`, { method: 'DELETE' }).catch(() => {});
  };
  const show = picked ? posts.find((p) => p.id === picked) : null;
  // one, large (click it, or Esc, to go back to the wall)
  if (show)
    return (
      <div className="lb-memes one" tabIndex={-1} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setPicked(null))}>
        <button className="mm-main" title="Back to all of them" onClick={() => setPicked(null)}>
          <MemeImage p={show} />
        </button>
        <Why p={show} sessionId={sessionId} onRemove={() => void remove(show.id)} />
      </div>
    );
  return <Stickers posts={posts} onPick={setPicked} onRemove={(id) => void remove(id)} onClear={() => void remove()} />;
}

/** What it's about, when, and (a GIF) its source. */
function Why({ p, sessionId, onRemove }: { p: MemePost; sessionId: string; onRemove(): void }) {
  return (
    <div className="mm-why">
      <span>{p.why ?? (p.kind === 'gif' ? `“${p.query}”` : p.kind === 'svg' ? 'Drawn by Claude' : p.template)}</span>
      {p.kind === 'svg' ? <span className="mm-tag">drawn · not saved</span> : null}
      <span className="mm-when">{ago(p.at)} ago</span>
      {p.kind === 'gif' ? (
        <button className="mm-giphy" title="See it on GIPHY" onClick={() => p.page && openInBrowser(p.page, sessionId)}>
          via GIPHY
        </button>
      ) : null}
      <button className="mm-giphy" title="Take it off the wall" onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}

/** A post's own number from its id: where it's stuck, and how crooked, stay the same whatever comes after it. */
const seed = (id: string, salt: number) => {
  let h = 2166136261 ^ salt;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
};
/** Loose spots across the panel (left, top, in %), taken in turn and nudged a little each. */
const SPOTS: Array<[number, number]> = [[6, 8], [46, 6], [24, 38], [54, 40], [2, 52], [36, 18], [60, 12], [14, 24], [42, 56], [0, 4]];
const MAX_STUCK = 10;

/**
 * The panel as a sticker wall: the latest posts slapped on at a slant, overlapping, the newest on top (landing with a
 * slap as it comes in). Each keeps its spot and its angle. Click one to see it large.
 */
function Stickers({ posts, onPick, onRemove, onClear }: { posts: MemePost[]; onPick(id: string): void; onRemove(id: string): void; onClear(): void }) {
  // clearing the wall asks once more (a second click, within a few seconds)
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const t = setTimeout(() => setSure(false), 3500);
    return () => clearTimeout(t);
  }, [sure]);
  // the ones there when it opened don't slap in; only those that come after
  const [seen] = useState(() => new Set(posts.map((p) => p.id)));
  const stuck = posts.slice(-MAX_STUCK);
  // the panel's size, and each picture's shape (height over width) once it has loaded
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setSize((c) => (c && c.w === el.clientWidth && c.h === el.clientHeight ? c : { w: el.clientWidth, h: el.clientHeight }));
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);
  const [shapes, setShapes] = useState<Record<string, number>>({});
  const shape = (id: string) => (r: number) => r > 0 && Math.abs((shapes[id] ?? 0) - r) > 0.01 && setShapes((m) => ({ ...m, [id]: r }));
  // fewer stickers, bigger ones
  const share = stuck.length <= 1 ? 0.62 : stuck.length <= 3 ? 0.5 : stuck.length <= 6 ? 0.42 : 0.36;
  // where you've put them (dragged): kept in this browser, as shares of the panel; the last moved on top
  const [moved, setMoved] = useState<Placed>(loadPlaced);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const press = useRef<{ id: string; px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  const clicked = useRef(false);
  const top = Math.max(0, ...Object.values(moved).map((m) => m.z));
  const grab = (id: string, cx: number, cy: number) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !size) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    press.current = { id, px: e.clientX, py: e.clientY, x: cx / size.w, y: cy / size.h, moved: false };
  };
  const pull = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || !size) return;
    const dx = e.clientX - p.px;
    const dy = e.clientY - p.py;
    if (!p.moved && Math.hypot(dx, dy) < 4) return;
    p.moved = true;
    setDrag({ id: p.id, x: p.x + dx / size.w, y: p.y + dy / size.h });
  };
  const drop = () => {
    const p = press.current;
    press.current = null;
    if (!p?.moved || !drag) return;
    clicked.current = true; // the click that ends a drag doesn't open it
    const next = { ...pruned(moved, posts), [p.id]: { x: drag.x, y: drag.y, z: top + 1 } };
    setMoved(next);
    savePlaced(next);
    setDrag(null);
  };
  return (
    <div className="mm-wall" ref={box}>
      {size
        ? stuck.map((p, i) => {
            const tilt = (seed(p.id, 3) - 0.5) * 26;
            const ratio = shapes[p.id] ?? (p.kind === 'gif' ? 0.75 : 2 / 3);
            const live = drag?.id === p.id ? drag : moved[p.id];
            const at = place(size, share, ratio, tilt, SPOTS[i % SPOTS.length], seed(p.id, 1), seed(p.id, 2), live ? [live.x, live.y] : undefined);
            const h = (at.width - 2 * BORDER) * ratio + 2 * BORDER;
            return (
              <button
                key={p.id}
                className={`mm-sticker${seen.has(p.id) ? '' : ' slap'}${i === stuck.length - 1 ? ' newest' : ''}${drag?.id === p.id ? ' dragging' : ''}`}
                style={{ left: at.left, top: at.top, width: at.width, zIndex: drag?.id === p.id ? 999 : moved[p.id] ? MAX_STUCK + moved[p.id].z : i + 1, ['--tilt' as never]: `${tilt.toFixed(1)}deg` }}
                title={p.why ?? p.template ?? p.query ?? ''}
                onPointerDown={grab(p.id, at.left + at.width / 2, at.top + h / 2)}
                onPointerMove={pull}
                onPointerUp={drop}
                onPointerCancel={() => ((press.current = null), setDrag(null))}
                onClick={() => (clicked.current ? (clicked.current = false) : onPick(p.id))}
              >
                <MemeImage p={p} onShape={shape(p.id)} />
                <span
                  className="mm-x"
                  role="button"
                  aria-label="Take it off the wall"
                  title="Take it off the wall"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => (e.stopPropagation(), onRemove(p.id))}
                >
                  ×
                </span>
              </button>
            );
          })
        : null}
      {posts.length > MAX_STUCK ? <span className="mm-older">+{posts.length - MAX_STUCK} under these</span> : null}
      <button className={`mm-clear${sure ? ' sure' : ''}`} title="Take every sticker off the wall" onClick={() => (sure ? (setSure(false), onClear()) : setSure(true))}>
        {sure ? `Clear all ${posts.length}?` : 'Clear'}
      </button>
    </div>
  );
}

/** Where you've put stickers: each one's centre (shares of the panel) and its turn on top. In this browser only. */
type Placed = Record<string, { x: number; y: number; z: number }>;
const PLACED = 'cora.vibes.placed';
function loadPlaced(): Placed {
  try {
    const v = JSON.parse(localStorage.getItem(PLACED) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function savePlaced(p: Placed): void {
  try {
    localStorage.setItem(PLACED, JSON.stringify(p));
  } catch {
    /* only a convenience */
  }
}
/** Only the stickers still on the wall (and their order on top, closed up). */
function pruned(p: Placed, posts: MemePost[]): Placed {
  const ids = new Set(posts.map((x) => x.id));
  const kept = Object.entries(p).filter(([id]) => ids.has(id)).sort((a, b) => a[1].z - b[1].z);
  return Object.fromEntries(kept.map(([id, m], i) => [id, { ...m, z: i + 1 }]));
}

/** A sticker's border (each side), and the room kept between the stickers and the panel's edges. */
const BORDER = 5;
const MARGIN = 6;

/**
 * Where a sticker goes so that all of it, tilted corners included, is inside the panel: as wide as its share of the
 * panel unless that would make it too tall (or too wide, tilted) to fit, then smaller; its centre somewhere in the room
 * left, by its spot and a little nudge of its own.
 */
export function place(panel: { w: number; h: number }, share: number, shape: number, tilt: number, spot: [number, number], jx: number, jy: number, center?: [number, number]): { left: number; top: number; width: number } {
  const rad = (Math.abs(tilt) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const outline = (w: number) => {
    const h = (w - 2 * BORDER) * shape + 2 * BORDER;
    return { h, bw: w * cos + h * sin, bh: w * sin + h * cos };
  };
  let width = Math.max(40, panel.w * share);
  let o = outline(width);
  const fit = Math.min(1, (panel.w - 2 * MARGIN) / o.bw, (panel.h - 2 * MARGIN) / o.bh);
  if (fit < 1) {
    width = Math.max(30, width * fit);
    o = outline(width);
  }
  // the room for its centre, and where in it (its spot, nudged)
  const fx = Math.max(0, Math.min(1, spot[0] / 60 + (jx - 0.5) * 0.2));
  const fy = Math.max(0, Math.min(1, spot[1] / 56 + (jy - 0.5) * 0.2));
  const x0 = MARGIN + o.bw / 2;
  const x1 = Math.max(x0, panel.w - MARGIN - o.bw / 2);
  const y0 = MARGIN + o.bh / 2;
  const y1 = Math.max(y0, panel.h - MARGIN - o.bh / 2);
  // where you put it (its centre, as a share of the panel), kept inside; else its spot
  const cx = center ? Math.max(x0, Math.min(x1, center[0] * panel.w)) : x0 + fx * (x1 - x0);
  const cy = center ? Math.max(y0, Math.min(y1, center[1] * panel.h)) : y0 + fy * (y1 - y0);
  return { left: Math.round(cx - width / 2), top: Math.round(cy - o.h / 2), width: Math.round(width) };
}
