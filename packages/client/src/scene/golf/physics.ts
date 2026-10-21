/**
 * Gravity golf, the pure part: the field the scene's orbs make, a shot's flight through it, where tees and holes
 * go, and the score. Everything is in the scene's play plane (z = 0), in world units and seconds.
 */
export type V2 = { x: number; y: number };
/** a gravity well: an orb (or radiant) with mass `m` whose core (radius `r`) swallows the ball */
export type Well = { key: string; x: number; y: number; m: number; r: number };
export type Ball = { x: number; y: number; vx: number; vy: number };
export type Bounds = { x0: number; x1: number; y0: number; y1: number };

/** pull strength: main (m = 1) bends a ball strongly within ~3 units and is felt across half the field */
export const G = 60;
/** softening: no infinite pull at a well's centre (the ball is swallowed before it gets there anyway) */
export const SOFT = 0.45;
/**
 * Rolling friction (a constant deceleration) plus a little drag. Friction is what lets a ball come to rest: out in
 * the open the pull is weaker than it and the ball stops; close to a well the pull wins and the ball rolls in, so
 * every well sits in a basin of radius √(G·m / FRICTION).
 */
export const FRICTION = 2.2;
export const DRAG = 0.45;
export const VMAX = 20;
/** launch speed at full pull, and how long a pull (world units) that takes */
export const VSHOT = 16.5;
export const PULL_MAX = 3.6;
/** a pull shorter than this is no shot (a click, or changing your mind) */
export const PULL_MIN = 0.22;
export const BALL_R = 0.13;
/** the wormhole: its mouth, and a faint pull of its own so near misses curl in */
export const HOLE_R = 0.45;
export const HOLE_M = 0.08;
const HOLE_SOFT = 0.5;
/** faster than this the ball skims over the hole: you need the pace right, not just the line */
export const SINK_V = 5.5;
/** a ball slower than this for REST_S seconds is at rest (friction usually stops it dead well before) */
export const REST_V = 0.2;
export const REST_S = 0.35;
/** fixed physics substep */
export const SUB_DT = 1 / 240;
/** room past the edge of the field before a ball is out */
export const OUT_MARGIN = 0.9;

export type Outcome = { kind: 'fly' } | { kind: 'rest' } | { kind: 'sunk' } | { kind: 'out' } | { kind: 'absorbed'; well: Well };
/** `hot`: the ball has rolled over the hole too fast to drop (the game says so, then clears it) */
export type Flight = { ball: Ball; slow: number; t: number; hot: boolean };

export const flight = (x: number, y: number, vx: number, vy: number): Flight => ({ ball: { x, y, vx, vy }, slow: 0, t: 0, hot: false });

/** Softened gravity at (x, y): a = Σ G·m·d / (|d|² + ε²)^(3/2), plus the hole's own small pull. */
export function accel(x: number, y: number, wells: readonly Well[], hole: V2 | null, out: V2 = { x: 0, y: 0 }): V2 {
  let ax = 0, ay = 0;
  for (const w of wells) {
    const dx = w.x - x, dy = w.y - y;
    const k = (G * w.m) / Math.pow(dx * dx + dy * dy + SOFT * SOFT, 1.5);
    ax += dx * k;
    ay += dy * k;
  }
  if (hole) {
    const dx = hole.x - x, dy = hole.y - y;
    const k = (G * HOLE_M) / Math.pow(dx * dx + dy * dy + HOLE_SOFT * HOLE_SOFT, 1.5);
    ax += dx * k;
    ay += dy * k;
  }
  out.x = ax;
  out.y = ay;
  return out;
}

/** How far out a well's pull beats friction: inside this a resting ball would roll in. */
export const basin = (w: Pick<Well, 'm'>) => Math.sqrt((G * w.m) / FRICTION);

export function inBounds(p: V2, b: Bounds, margin = 0): boolean {
  return p.x >= b.x0 - margin && p.x <= b.x1 + margin && p.y >= b.y0 - margin && p.y <= b.y1 + margin;
}

/** The well whose core the point is touching, if any. */
export function touching(p: V2, wells: readonly Well[], pad = BALL_R): Well | null {
  for (const w of wells) if (Math.hypot(p.x - w.x, p.y - w.y) < w.r + pad) return w;
  return null;
}

const _a: V2 = { x: 0, y: 0 };
/**
 * One fixed substep, semi-implicit Euler: gravity into the velocity, then friction and drag take speed off (never
 * reversing it), then the position moves with the new velocity.
 */
function substep(b: Ball, wells: readonly Well[], hole: V2 | null, h: number) {
  accel(b.x, b.y, wells, hole, _a);
  b.vx += _a.x * h;
  b.vy += _a.y * h;
  const s = Math.hypot(b.vx, b.vy);
  if (s > 0) {
    const ns = Math.min(VMAX, Math.max(0, s - FRICTION * h) * (1 - DRAG * h));
    b.vx *= ns / s;
    b.vy *= ns / s;
  }
  b.x += b.vx * h;
  b.y += b.vy * h;
}

/**
 * Moves a ball in flight on by `dt` seconds (in fixed substeps) and says what happened: still flying, came to rest,
 * dropped into the hole, swallowed by a well, or left the field. Mutates `f`.
 */
export function advance(f: Flight, wells: readonly Well[], hole: V2 | null, bounds: Bounds, dt: number): Outcome {
  const n = Math.max(1, Math.ceil(Math.min(dt, 0.1) / SUB_DT - 1e-9));
  const h = Math.min(dt, 0.1) / n;
  const b = f.ball;
  for (let i = 0; i < n; i++) {
    substep(b, wells, hole, h);
    f.t += h;
    const w = touching(b, wells);
    if (w) return { kind: 'absorbed', well: w };
    const s = Math.hypot(b.vx, b.vy);
    if (hole && Math.hypot(b.x - hole.x, b.y - hole.y) < HOLE_R) {
      if (s < SINK_V) return { kind: 'sunk' };
      f.hot = true;
    }
    if (!inBounds(b, bounds, OUT_MARGIN)) return { kind: 'out' };
    f.slow = s < REST_V ? f.slow + h : 0;
    if (f.slow >= REST_S) {
      b.vx = b.vy = 0;
      return { kind: 'rest' };
    }
  }
  return { kind: 'fly' };
}

/** Launch velocity for a pull (drag vector, pointer minus where you pressed): opposite the pull, ∝ its length. */
export function launch(pull: V2): V2 | null {
  const len = Math.hypot(pull.x, pull.y);
  if (len < PULL_MIN) return null;
  const v = (Math.min(len, PULL_MAX) / PULL_MAX) * VSHOT;
  return { x: (-pull.x / len) * v, y: (-pull.y / len) * v };
}

/** 0…1: how hard a pull is (for the aim's colour). */
export const power = (pull: V2) => Math.min(1, Math.hypot(pull.x, pull.y) / PULL_MAX);

/**
 * The first `seconds` of a shot's path, a point every `every` seconds, against the field as it is now. Short on
 * purpose: it shows the launch, not where it ends up. Stops where the ball would.
 */
export function preview(from: V2, v: V2, wells: readonly Well[], hole: V2 | null, bounds: Bounds, seconds = 0.7, every = 0.05): V2[] {
  const f = flight(from.x, from.y, v.x, v.y);
  const pts: V2[] = [];
  for (let t = every; t <= seconds + 1e-9; t += every) {
    const o = advance(f, wells, hole, bounds, every);
    pts.push({ x: f.ball.x, y: f.ball.y });
    if (o.kind !== 'fly') break;
  }
  return pts;
}

/** Pushes a point out of any well's core (with `pad` to spare), e.g. a lie a well has since moved onto. */
export function clearOf(p: V2, wells: readonly Well[], pad = 0.6): V2 {
  const q = { ...p };
  for (let k = 0; k < 6; k++) {
    let moved = false;
    for (const w of wells) {
      const dx = q.x - w.x, dy = q.y - w.y;
      const d = Math.hypot(dx, dy);
      const need = w.r + pad;
      if (d >= need) continue;
      const ux = d > 1e-6 ? dx / d : 1, uy = d > 1e-6 ? dy / d : 0;
      q.x = w.x + ux * need;
      q.y = w.y + uy * need;
      moved = true;
    }
    if (!moved) break;
  }
  return q;
}

export type Rng = () => number;
const inset = (b: Bounds, m: number): Bounds => ({ x0: b.x0 + m, x1: b.x1 - m, y0: b.y0 + m, y1: b.y1 - m });
const pick = (rng: Rng, b: Bounds): V2 => ({ x: b.x0 + rng() * (b.x1 - b.x0), y: b.y0 + rng() * (b.y1 - b.y0) });
/** a hole is never this close to a well's core (it can sit in the well's basin: that's what makes it hard) */
export const HOLE_CLEAR = 1.1;
const TEE_CLEAR = 1.4;

function distToSeg(p: V2, a: V2, b: V2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  const u = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy);
}

const clearOfAll = (p: V2, wells: readonly Well[], pad: number) => wells.every((w) => Math.hypot(p.x - w.x, p.y - w.y) >= w.r + pad);

/**
 * A tee: out in the open, preferably outside every well's basin (not balanced on a ridge between two of them, where
 * any soft shot falls in), else anywhere flat (the pull there weaker than friction), else just clear of the cores.
 */
export function placeTee(rng: Rng, wells: readonly Well[], bounds: Bounds): V2 {
  const area = inset(bounds, 1.2);
  let flat: V2 | null = null, clear: V2 | null = null;
  for (let i = 0; i < 400; i++) {
    const p = pick(rng, area);
    if (!clearOfAll(p, wells, TEE_CLEAR)) continue;
    clear ??= p;
    const a = accel(p.x, p.y, wells, null);
    if (Math.hypot(a.x, a.y) >= FRICTION * 0.8) continue;
    if (wells.every((w) => Math.hypot(p.x - w.x, p.y - w.y) >= basin(w) * 0.9)) return p;
    flat ??= p;
  }
  return flat ?? clear ?? clearOf(pick(rng, area), wells, TEE_CLEAR);
}

/**
 * A hole for a tee: inside the field, never in (or hugging) a well, a decent distance off, and interesting: of a
 * handful of candidates, the one with the most mass near the straight line from the tee (so you have to bend it),
 * with some luck mixed in.
 */
export function placeHole(rng: Rng, wells: readonly Well[], bounds: Bounds, tee: V2): V2 {
  const area = inset(bounds, 1.4);
  const span = Math.hypot(area.x1 - area.x0, area.y1 - area.y0);
  for (const [lo, hi] of [[7, 19], [4, span]] as const) {
    let best: V2 | null = null, bestScore = -1;
    let found = 0;
    for (let i = 0; i < 400 && found < 14; i++) {
      const p = pick(rng, area);
      const d = Math.hypot(p.x - tee.x, p.y - tee.y);
      if (d < lo || d > hi || !clearOfAll(p, wells, HOLE_CLEAR)) continue;
      found++;
      const bend = wells.reduce((s, w) => s + w.m / (distToSeg(w, tee, p) + 0.8), 0);
      const score = bend * (0.55 + 0.45 * rng());
      if (score > bestScore) (best = p), (bestScore = score);
    }
    if (best) return best;
  }
  // a field packed with wells: the clearest spot on a grid
  let best = { x: (area.x0 + area.x1) / 2, y: (area.y0 + area.y1) / 2 }, bestGap = -Infinity;
  for (let i = 0; i <= 24; i++)
    for (let j = 0; j <= 12; j++) {
      const p = { x: area.x0 + ((area.x1 - area.x0) * i) / 24, y: area.y0 + ((area.y1 - area.y0) * j) / 12 };
      const gap = Math.min(...wells.map((w) => Math.hypot(p.x - w.x, p.y - w.y) - w.r), 99);
      if (gap > bestGap) (best = p), (bestGap = gap);
    }
  return best;
}

/** Par from the hole's length: a short one is a 2, a long one a 4. */
export const parFor = (tee: V2, hole: V2) => {
  const d = Math.hypot(hole.x - tee.x, hole.y - tee.y);
  return d < 8 ? 2 : d > 16 ? 4 : 3;
};

// ---------------------------------------------------------------------------- score
/** The run so far: which hole you're on, strokes on it, and how the finished holes went against par. */
/** `tries`: attempts at this hole (a retry starts it again from its tee, strokes wiped) */
export type Card = { hole: number; strokes: number; par: number; toPar: number; streak: number; tries: number };
export const newCard = (par = 3): Card => ({ hole: 1, strokes: 0, par, toPar: 0, streak: 0, tries: 1 });
/** what you keep between runs */
export type Best = { under: number; streak: number; holes: number; aces: number };
export const NO_BEST: Best = { under: 0, streak: 0, holes: 0, aces: 0 };

/** a shot taken (a penalty is one more) */
export const stroke = (c: Card, n = 1): Card => ({ ...c, strokes: c.strokes + n });

export function holeName(strokes: number, par: number): string {
  if (strokes === 1) return 'hole in one';
  const d = strokes - par;
  return d <= -3 ? 'albatross' : d === -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? 'par' : d === 1 ? 'bogey' : d === 2 ? 'double bogey' : `+${d}`;
}

/** The ball dropped: the hole is scored, the streak (holes at par or better) goes on or ends, on to the next. */
export function sink(c: Card, nextPar: number): { card: Card; name: string; diff: number } {
  const diff = c.strokes - c.par;
  return { card: { hole: c.hole + 1, strokes: 0, par: nextPar, toPar: c.toPar + diff, streak: diff <= 0 ? c.streak + 1 : 0, tries: 1 }, name: holeName(c.strokes, c.par), diff };
}

/** Retry: the hole starts again from its tee, its strokes wiped, one more try on the card. */
export const retry = (c: Card): Card => ({ ...c, strokes: 0, tries: c.tries + 1 });

/** A shot from the tee, kept as the ghost line: where it went, and how near it came to the hole (0: it went in). */
export type Line = { pts: V2[]; closest: number };
export const closestTo = (pts: V2[], hole: V2) => pts.reduce((m, p) => Math.min(m, Math.hypot(p.x - hole.x, p.y - hole.y)), Infinity);
/** The better of the ghost so far and a new line: the one that came nearer the hole (a tie keeps the old one). */
export const betterLine = (ghost: Line | null, line: Line): Line => (!ghost || line.closest < ghost.closest ? line : ghost);
/** At most `n` points along a line, evenly by index (always its start and its end). */
export function thin(pts: V2[], n: number): V2[] {
  if (pts.length <= n) return pts;
  return Array.from({ length: n }, (_, i) => pts[Math.round((i * (pts.length - 1)) / (n - 1))]);
}

export function better(b: Best, c: Card, ace = false): Best {
  return { under: Math.max(b.under, -c.toPar), streak: Math.max(b.streak, c.streak), holes: b.holes + 1, aces: b.aces + (ace ? 1 : 0) };
}

/** "3 under", "even", "2 over" */
export const toParText = (n: number) => (n < 0 ? `${-n} under` : n > 0 ? `${n} over` : 'even');

/** A small seeded generator (mulberry32), so placement is reproducible in tests. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
