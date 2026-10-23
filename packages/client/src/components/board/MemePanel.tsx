import { useEffect, useMemo, useState } from 'react';
import { useMemeNews } from './memeNews';
import { MEME_TOOL, type MemeMode, type MemePost, type Settings } from '@cora/shared';
import { sessionEvents, useBrain } from '../../state/store';
import { ago } from '../../lib/format';
import { openSettings } from '../SettingsModal';
import { openInBrowser } from '../JiraChip';
import './memes.css';

/** The panel's little meme guy: a smug grin, and every few seconds his "deal with it" shades come down. */
function MemeGuy() {
  return (
    <svg className="mm-guy" viewBox="0 0 120 120" aria-hidden>
      <defs>
        <radialGradient id="mm-head" cx="40%" cy="35%" r="70%">
          <stop offset="0" className="s0" />
          <stop offset="1" className="s1" />
        </radialGradient>
      </defs>
      <ellipse className="mm-shadow" cx="60" cy="108" rx="28" ry="5" />
      <g className="mm-body">
        <circle cx="60" cy="58" r="40" fill="url(#mm-head)" />
        {/* eyes, half-lidded, and one raised brow: the smug look */}
        <path d="M38 47 q8 -6 16 0" className="mm-brow" />
        <path d="M68 44 q8 -3 15 2" className="mm-brow" />
        <ellipse cx="46" cy="55" rx="5" ry="3.4" className="mm-eye" />
        <ellipse cx="74" cy="55" rx="5" ry="3.4" className="mm-eye" />
        <path d="M42 70 q18 16 38 -2" className="mm-grin" />
        <path d="M74 66 l7 -1" className="mm-grin" />
        {/* the shades: pixel glasses, dropping in */}
        <g className="mm-shades">
          <rect x="30" y="49" width="24" height="10" />
          <rect x="62" y="49" width="24" height="10" />
          <rect x="52" y="51" width="12" height="4" />
          <rect x="22" y="49" width="10" height="4" />
          <rect x="84" y="49" width="10" height="4" />
          <rect x="34" y="51" width="5" height="3" className="glint" />
          <rect x="66" y="51" width="5" height="3" className="glint" />
        </g>
      </g>
    </svg>
  );
}

/** A meme: its template with the captions drawn on, the way memes look (big white letters with a black outline). */
export function MemeImage({ p, small = false }: { p: MemePost; small?: boolean }) {
  if (p.kind === 'gif') return <img className="mm-img" src={p.url} alt={p.query ?? 'GIF'} draggable={false} />;
  // one Claude drew: as an image, so it can't run anything or load anything from outside
  if (p.kind === 'svg') return <img className="mm-img drawn" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(p.svg ?? '')}`} alt={p.why ?? 'a meme Claude drew'} draggable={false} />;
  return (
    <span className={`mm-meme${small ? ' small' : ''}`}>
      <img className="mm-img" src={p.url} alt={p.template ?? 'meme'} draggable={false} />
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
        <MemeGuy />
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
  const show = picked ? posts.find((p) => p.id === picked) : null;
  // one, large (click it, or Esc, to go back to the wall)
  if (show)
    return (
      <div className="lb-memes one" tabIndex={-1} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setPicked(null))}>
        <button className="mm-main" title="Back to all of them" onClick={() => setPicked(null)}>
          <MemeImage p={show} />
        </button>
        <Why p={show} sessionId={sessionId} />
      </div>
    );
  return <Stickers posts={posts} onPick={setPicked} />;
}

/** What it's about, when, and (a GIF) its source. */
function Why({ p, sessionId }: { p: MemePost; sessionId: string }) {
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
function Stickers({ posts, onPick }: { posts: MemePost[]; onPick(id: string): void }) {
  // the ones there when it opened don't slap in; only those that come after
  const [seen] = useState(() => new Set(posts.map((p) => p.id)));
  const stuck = posts.slice(-MAX_STUCK);
  // fewer stickers, bigger ones
  const w = stuck.length <= 1 ? 62 : stuck.length <= 3 ? 50 : stuck.length <= 6 ? 42 : 36;
  return (
    <div className="mm-wall">
      {stuck.map((p, i) => {
        const [x, y] = SPOTS[i % SPOTS.length];
        const left = Math.max(0, Math.min(100 - w, x + (seed(p.id, 1) - 0.5) * 12));
        const top = Math.max(0, Math.min(62, y + (seed(p.id, 2) - 0.5) * 12));
        const tilt = (seed(p.id, 3) - 0.5) * 26;
        return (
          <button
            key={p.id}
            className={`mm-sticker${seen.has(p.id) ? '' : ' slap'}${i === stuck.length - 1 ? ' newest' : ''}`}
            style={{ left: `${left}%`, top: `${top}%`, width: `${w}%`, zIndex: i + 1, ['--tilt' as never]: `${tilt.toFixed(1)}deg` }}
            title={p.why ?? p.template ?? p.query ?? ''}
            onClick={() => onPick(p.id)}
          >
            <MemeImage p={p} />
          </button>
        );
      })}
      {posts.length > MAX_STUCK ? <span className="mm-older">+{posts.length - MAX_STUCK} under these</span> : null}
    </div>
  );
}

