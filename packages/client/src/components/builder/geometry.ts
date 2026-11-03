/**
 * The builder canvas's geometry, pure so it's
 * tested without a DOM: boxes for seats and groups, where arrows leave and arrive, their curves and chips, fitting and
 * zooming, where a dragged seat lands, and the marks for a proposal and for Cora's live changes.
 */
import { FIX_W, LABEL_H, LOOP_OUT, LOOP_STEP, NODE_H, NODE_W, PAD, approxMeasure, autoLayout, chipSize, depthOf, dispatchText, groupById, idOf, parentsOf, sameValue, seatById, seatsOf, type Endpoint, type FontKind, type Group, type LintTarget, type Measure, type Pos, type Route, type Seat, type Team, type TeamLayout } from '@cora/shared';

let measure: Measure = approxMeasure;
/** The screen's own measure (a canvas's measureText), once its fonts are in. */
export function setMeasure(m: Measure): void {
  measure = m;
}
export const textWidth = (s: string, f: FontKind) => measure(s, f);
/** A name cut to fit its row (with an ellipsis). */
export function fitText(s: string, f: FontKind, max: number): string {
  if (measure(s, f) <= max) return s;
  let t = s;
  while (t.length > 1 && measure(`${t}…`, f) > max) t = t.slice(0, -1);
  return `${t}…`;
}
/** The browser's measure for the canvas's fonts (null without a DOM). */
export function canvasMeasure(): Measure | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas').getContext('2d');
  if (!c) return null;
  const F: Record<FontKind, string> = { chip: '500 9.5px "JetBrains Mono Variable"', name: '500 13px "Figtree Variable"', sub: '400 10.5px "JetBrains Mono Variable"', label: '600 9.5px "JetBrains Mono Variable"', labelDim: '400 9.5px "JetBrains Mono Variable"' };
  return (s, f) => {
    c.font = F[f];
    return c.measureText(s).width + (f === 'label' ? 1.33 * s.length : 0);
  };
}

export type Box = { x: number; y: number; w: number; h: number };
export type View = { x: number; y: number; k: number };
export const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
export const inside = (p: Pos, b: Box) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
/** A layout whose seats have sizes of their own (the board's team map: its tiles are HTML, taller than the builder's). */
export type SizedLayout = TeamLayout & { size?: Record<string, { w: number; h: number }> };
export function seatBox(look: SizedLayout, id: string): Box | null {
  const p = look.pos[id];
  const s = look.size?.[id];
  return p ? { x: p.x, y: p.y, w: s?.w ?? NODE_W, h: s?.h ?? NODE_H } : null;
}
const regionLabelW = (g: Group) => measure(g.name.toUpperCase(), 'label') + 8 + measure(dispatchText(g), 'labelDim');

/** Each group's region: around its members (nested groups inside), room for its label above. */
export function groupBoxes(t: Team, look: TeamLayout): Record<string, Box | null> {
  const memo: Record<string, Box | null> = {};
  const box = (gid: string, seen: Set<string>): Box | null => {
    if (gid in memo) return memo[gid];
    if (seen.has(gid)) return null;
    seen.add(gid);
    const g = groupById(t, gid);
    let b: Box | null = null;
    for (const m of g?.members ?? []) {
      const mb = groupById(t, m) ? box(m, seen) : seatBox(look, m);
      if (mb) b = b ? union(b, mb) : { ...mb };
    }
    if (b && g) {
      b = { x: b.x - PAD, y: b.y - LABEL_H, w: b.w + PAD * 2, h: b.h + LABEL_H + PAD };
      b.w = Math.max(b.w, Math.ceil(regionLabelW(g)) + PAD * 2);
    }
    return (memo[gid] = b);
  };
  for (const g of t.groups) box(g.id, new Set());
  return memo;
}
export function epBox(t: Team, look: TeamLayout, e: Endpoint, gb: Record<string, Box | null>): Box | null {
  if (e === 'user' || e === 'cora') {
    const p = look.pos[`@${e}`];
    return p ? { x: p.x, y: p.y, w: FIX_W, h: NODE_H } : null;
  }
  return e.startsWith('seat:') ? seatBox(look, idOf(e)) : (gb[idOf(e)] ?? null);
}

export type Ports = { tip(r: Route): number; src(r: Route, f: Endpoint): number; routes: Route[] };
/** Where arrows leave and arrive: spread 10px apart when several share a side. */
export function ports(routes: Route[]): Ports {
  const inc: Record<string, string[]> = {};
  const out: Record<string, string[]> = {};
  for (const r of routes) {
    (inc[r.to] ??= []).push(r.id);
    for (const f of r.from) (out[f] ??= []).push(r.id);
  }
  return {
    tip: (r) => ((inc[r.to] ?? [r.id]).indexOf(r.id) - ((inc[r.to] ?? [r.id]).length - 1) / 2) * 10,
    src: (r, f) => (out[f] ? (out[f].indexOf(r.id) - (out[f].length - 1) / 2) * 10 : 0),
    routes,
  };
}
export const curve = (a: Pos, b: Pos) => {
  const dx = Math.max(24, (b.x - a.x) / 2);
  return `M${a.x} ${a.y} C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
};

/** A loop's straight run: under (or, for a group to itself, over) everything it passes. */
export type Run = { x0: number; x1: number; y: number };
export type Leg = { d: string; full: string; f: Endpoint; i: number; ghost?: true; run?: Run };
/** `ext`: everything the route draws (its arrows, loops and chip), for fitting. */
export type RouteGeom = { legs: Leg[]; trunk: string | null; T: Pos; chip: Pos | null; cs: { w: number; h: number; lines: string[] }; ext: Box };
type Src = { f: Endpoint; i: number; ghost?: true; b: Box };
type Parts = { tb: Box; T: Pos; fwd: Src[]; back: Src[]; S: (s: Src) => Pos; cs: RouteGeom['cs'] };
/** A route's ends: its target, and its senders split into those well to the left (straight on) and the rest (a loop). */
function partsOf(t: Team, look: TeamLayout, r: Route, gb: Record<string, Box | null>, P: Ports, ghostFrom: Endpoint[], tip = P.tip(r)): Parts | null {
  const tb = epBox(t, look, r.to, gb);
  if (!tb) return null;
  const T = { x: tb.x - 3, y: tb.y + tb.h / 2 + tip };
  const all: Array<Omit<Src, 'b'>> = [...r.from.map((f, i) => ({ f, i })), ...ghostFrom.map((f) => ({ f, i: -1, ghost: true as const }))];
  const srcs = all.map((s) => ({ ...s, b: epBox(t, look, s.f, gb) })).filter((s): s is Src => !!s.b);
  if (!srcs.some((s) => !s.ghost)) return null;
  const S = (s: Src): Pos => ({ x: s.b.x + s.b.w, y: s.b.y + s.b.h / 2 + P.src(r, s.f) });
  const fwd = srcs.filter((s) => s.f !== r.to && s.b.x + s.b.w + 48 < T.x);
  return { tb, T, fwd, back: srcs.filter((s) => !fwd.includes(s)), S, cs: chipSize(r, measure) };
}
/** The chip of a route with a sender straight on: on its curve, or where its senders merge. */
function fwdChip({ fwd, T, S, cs }: Parts): Pos | null {
  if (fwd.length >= 2) return { x: Math.max(T.x - 16 - cs.w, Math.max(...fwd.map((s) => S(s).x)) + 28) + cs.w / 2, y: T.y };
  if (!fwd.length) return null;
  const a = S(fwd[0]);
  const dx = Math.max(24, (T.x - a.x) / 2);
  return { x: (a.x + 3 * (a.x + dx) + 3 * (T.x - dx) + T.x) / 8, y: (a.y + T.y) / 2 };
}
const chipRect = (c: Pos, cs: { w: number; h: number }): Box => ({ x: c.x - cs.w / 2, y: c.y - cs.h / 2, w: cs.w, h: cs.h });

/**
 * A loop's lane: from `base`, pushed past every other lane it's nearer to than their gap (down, or up for a group's
 * loop over itself). A lane put exactly one gap past another can measure a rounding short of that gap (241.6655… and
 * 265.6655… are 23.99999999999997 apart, not 24): without a hair's tolerance it was pushed to the same place for ever
 * and the whole window froze (found live, on Tidy, whose easing gives such in-between positions). Each pass moves it
 * at least the tolerance, so it ends; the passes are capped as well.
 */
export function laneY(base: number, others: Array<{ y: number; sep: number }>, up: boolean): number {
  const HAIR = 0.01;
  let y = base;
  for (let moved = true, pass = 0; moved && pass <= others.length + 1; pass++) {
    moved = false;
    for (const q of others)
      if (Math.abs(q.y - y) < q.sep - HAIR) {
        const next = up ? q.y - q.sep : q.y + q.sep;
        if (next !== y) (y = next), (moved = true);
      }
  }
  return y;
}

type Lane = { y: number; out: number };
type Lanes = { at: Map<string, Lane>; tips: Map<string, number> };
const laneKey = (r: Route, f: Endpoint) => `${r.id} ${f}`;
const laneCache = new WeakMap<Ports, { t: Team; look: TeamLayout; gb: Record<string, Box | null>; lanes: Lanes }>();
/**
 * Every loop's lane, for all the routes the ports know: each under every seat, region and chip its run passes (a group
 * to itself: over its own region), stacked so no two runs or chips that share some width touch. Shorter runs, then lower
 * senders, take the inner lanes; each lane outside another swings out further, and the routes that only loop into a
 * seat arrive in the order of their lanes (the outermost on top), so the loops nest instead of crossing.
 */
function lanesOf(t: Team, look: TeamLayout, gb: Record<string, Box | null>, P: Ports): Lanes {
  const hit = laneCache.get(P);
  if (hit && hit.t === t && hit.look === look && hit.gb === gb) return hit.lanes;
  const boxes: Box[] = [...t.seats.map((s) => seatBox(look, s.id)), ...Object.values(gb), epBox(t, look, 'user', gb), epBox(t, look, 'cora', gb)].filter((b): b is Box => !!b);
  type Loop = { key: string; r: Route; only: boolean; up: boolean; sx: number; tx: number; x0: number; x1: number; lo: number; hi: number; base: number; e: number; sy: number; n: number };
  const loops: Loop[] = [];
  for (const r of P.routes) {
    const p = partsOf(t, look, r, gb, P, []);
    if (!p) continue;
    const fc = fwdChip(p);
    if (fc) boxes.push(chipRect(fc, p.cs));
    p.back.forEach((s, i) => {
      const a = p.S(s);
      const up = s.f === r.to;
      const x0 = Math.min(a.x, p.T.x);
      const x1 = Math.max(a.x, p.T.x);
      // the route's chip rides its first loop when no sender goes straight on
      const chip = !fc && i === 0;
      const cx = (a.x + p.T.x) / 2;
      const base = up ? Math.min(s.b.y, p.tb.y) - 30 : Math.max(s.b.y + s.b.h, p.tb.y + p.tb.h) + 34;
      loops.push({ key: laneKey(r, s.f), r, only: !p.fwd.length, up, sx: a.x, tx: p.T.x, x0, x1, lo: chip ? Math.min(x0, cx - p.cs.w / 2) : x0, hi: chip ? Math.max(x1, cx + p.cs.w / 2) : x1, base, e: chip ? p.cs.h / 2 : 0, sy: a.y, n: loops.length });
    });
  }
  for (const l of loops) if (!l.up) for (const b of boxes) if (b.x < l.x1 && l.x0 < b.x + b.w) l.base = Math.max(l.base, b.y + b.h + 34);
  const at = new Map<string, Lane>();
  const sep = (a: Loop, b: Loop) => Math.max(12, a.e + b.e + 8);
  const near = (a: Loop, b: Loop) => a.lo < b.hi && b.lo < a.hi;
  // runs within a region's padding of each other count as the same length
  const len = (l: Loop) => Math.round((l.x1 - l.x0) / 48);
  const placed: Array<Loop & Lane> = [];
  for (const up of [false, true]) {
    const order = loops.filter((l) => l.up === up).sort((a, b) => len(a) - len(b) || (up ? a.sy - b.sy : b.sy - a.sy) || a.n - b.n);
    for (const l of order) {
      const y = laneY(
        l.base,
        placed.filter((q) => q.up === up && near(q, l)).map((q) => ({ y: q.y, sep: sep(q, l) })),
        up,
      );
      // out past every loop inside it, on both sides (a curve reaches three quarters of the way to its control points)
      const inner = placed.filter((q) => q.up === up && near(q, l) && (up ? q.y > y : q.y < y));
      let out = LOOP_OUT + LOOP_STEP * inner.length;
      for (const q of inner) out = Math.max(out, (q.sx + 0.75 * q.out + 12 - l.sx) / 0.75, (l.tx - q.tx + 0.75 * q.out + 12) / 0.75);
      placed.push({ ...l, y, out });
      at.set(l.key, { y, out });
    }
  }
  // the routes that only loop into a seat swap their arrival points: the deepest lane arrives on top
  const tips = new Map<string, number>();
  const into: Record<string, Map<Route, number>> = {};
  for (const l of placed) if (!l.up && l.only) (into[l.r.to] ??= new Map()).set(l.r, Math.max(into[l.r.to]?.get(l.r) ?? -Infinity, l.y));
  for (const m of Object.values(into)) {
    const slots = [...m.keys()].map((r) => P.tip(r)).sort((a, b) => a - b);
    [...m.entries()].sort((a, b) => b[1] - a[1]).forEach(([r], i) => tips.set(r.id, slots[i]));
  }
  const lanes = { at, tips };
  laneCache.set(P, { t, look, gb, lanes });
  return lanes;
}

/**
 * A route's arrows: from each sender's right edge to the target's left. Senders well to the left merge into a trunk
 * before the target; one that isn't (or the target itself) loops round, above for itself, below otherwise, in a lane of
 * its own (lanesOf). `ghostFrom`: senders a proposal takes away (drawn faint).
 */
export function routeGeom(t: Team, look: TeamLayout, r: Route, gb: Record<string, Box | null>, P: Ports, ghostFrom: Endpoint[] = []): RouteGeom | null {
  const { at, tips } = lanesOf(t, look, gb, P);
  const p = partsOf(t, look, r, gb, P, ghostFrom, tips.get(r.id));
  if (!p) return null;
  const { T, fwd, back, S, cs, tb } = p;
  const legs: Leg[] = [];
  let chip = fwdChip(p);
  let trunk: string | null = null;
  let ext: Box = { x: T.x, y: T.y, w: 0, h: 0 };
  const leg = (s: Src, d: string, full: string, run?: Run): Leg => ({ d, full, f: s.f, i: s.i, ...(s.ghost ? { ghost: true as const } : {}), ...(run ? { run } : {}) });
  for (const s of fwd) ext = union(ext, { x: S(s).x, y: Math.min(S(s).y, T.y), w: 0, h: Math.abs(S(s).y - T.y) });
  if (fwd.length >= 2) {
    const M = { x: chip!.x - cs.w / 2, y: T.y };
    for (const s of fwd) legs.push(leg(s, curve(S(s), M), `${curve(S(s), M)} L${T.x} ${T.y}`));
    trunk = `M${M.x} ${M.y} L${T.x} ${T.y}`;
  } else if (fwd.length === 1) legs.push(leg(fwd[0], curve(S(fwd[0]), T), curve(S(fwd[0]), T)));
  back.forEach((s, i) => {
    const a = S(s);
    const self = s.f === r.to;
    // a sender the lanes don't know (a ghost) loops just under (or over) its own two boxes
    const { y, out } = at.get(laneKey(r, s.f)) ?? { y: self ? Math.min(s.b.y, tb.y) - 30 - i * 12 : Math.max(s.b.y + s.b.h, tb.y + tb.h) + 34 + i * 12, out: LOOP_OUT };
    const d = `M${a.x} ${a.y} C${a.x + out} ${a.y} ${a.x + out} ${y} ${a.x} ${y} L${T.x} ${y} C${T.x - out} ${y} ${T.x - out} ${T.y} ${T.x} ${T.y}`;
    legs.push(leg(s, d, d, { x0: Math.min(a.x, T.x), x1: Math.max(a.x, T.x), y }));
    // a curve's bulge reaches three quarters of the way to its control points
    const x0 = Math.min(a.x, T.x - 0.75 * out);
    const y0 = Math.min(a.y, T.y, y);
    ext = union(ext, { x: x0, y: y0, w: Math.max(a.x + 0.75 * out, T.x) - x0, h: Math.max(a.y, T.y, y) - y0 });
    chip ??= { x: (a.x + T.x) / 2, y };
  });
  if (chip) ext = union(ext, chipRect(chip, cs));
  return { legs, trunk, T, chip, cs, ext };
}

/** Everything drawn: seats, regions, You and Cora, the routes with their loops and chips (and seats a proposal removes). */
export function contentBounds(t: Team, look: TeamLayout, extraSeats: string[] = []): Box {
  const gb = groupBoxes(t, look);
  let b: Box | null = null;
  const add = (x: Box | null) => {
    if (x) b = b ? union(b, x) : { ...x };
  };
  for (const s of t.seats) add(seatBox(look, s.id));
  for (const id of extraSeats) add(seatBox(look, id));
  Object.values(gb).forEach(add);
  add(epBox(t, look, 'user', gb));
  add(epBox(t, look, 'cora', gb));
  const P = ports(t.routes);
  for (const r of t.routes) {
    add(routeGeom(t, look, r, gb, P)?.ext ?? null);
  }
  return b ?? { x: 0, y: 0, w: 400, h: 200 };
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** The view that frames `b` (never above 100%, never below 45%). */
export function fitView(size: { width: number; height: number }, b: Box): View {
  const px = size.width < 900 ? 28 : 56;
  const py = 56;
  const k = clamp(Math.min((size.width - px * 2) / b.w, (size.height - py * 2 - 24) / b.h), 0.45, 1);
  return { k, x: Math.round(size.width / 2 - (b.x + b.w / 2) * k), y: Math.round(size.height / 2 - (b.y + b.h / 2) * k + 4) };
}
/** Ctrl-wheel: zoom about the cursor (35% to 200%). */
export function zoomAt(v: View, mx: number, my: number, deltaY: number): View {
  const k = clamp(v.k * Math.exp(-deltaY * 0.0015), 0.35, 2);
  return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) };
}
export const toWorld = (v: View, px: number, py: number): Pos => ({ x: (px - v.x) / v.k, y: (py - v.y) / v.k });

/** A dragged seat's drop: into the deepest other region under it, out of its own, or nothing. */
export function dropTarget(t: Team, gb: Record<string, Box | null>, id: string, pt: Pos): { into: string } | { out: true } | null {
  let best: string | null = null;
  let bd = -1;
  for (const g of t.groups) {
    const b = gb[g.id];
    if (b && inside(pt, b)) {
      const d = depthOf(t, g.id);
      if (d > bd) (best = g.id), (bd = d);
    }
  }
  const parents = parentsOf(t, id).map((g) => g.id);
  if (best && parents.includes(best)) return null;
  if (best) return { into: best };
  return parents.length ? { out: true } : null;
}

/** A seat's mono line: its model, then its pool or effort. */
/** `leads`: it is the team's lead seat */
export const seatSub = (s: Seat, leads = false) => [leads ? 'leads' : '', s.agent.model || 'default', s.count.max > 1 || s.count.min === 0 ? `pool ${s.count.min}–${s.count.max}` : s.agent.effort].filter(Boolean).join(' · ');

export type Marks = { seat: Set<string>; group: Set<string>; route: Set<string> };
const noMarks = (): Marks => ({ seat: new Set(), group: new Set(), route: new Set() });
/** What a line In words is about, to light on the canvas. */
export function marksOf(targets: LintTarget[]): Marks {
  const m = noMarks();
  for (const x of targets) if (x.kind !== 'team') m[x.kind].add(x.id);
  return m;
}

export type ProposalMarks = { seat: Record<string, 'add' | 'chg' | ''>; group: Record<string, 'add' | 'chg' | ''>; route: Record<string, 'add' | 'chg' | ''>; goneSeats: Seat[]; goneRoutes: Route[] };
/** A lead's proposal against the team: what it adds, changes and removes. */
export function proposalMarks(base: Team | undefined, draft: Team): ProposalMarks {
  const b: Team = base ?? { ...draft, seats: [], groups: [], routes: [] };
  const cmp = <T extends { id: string }>(xs: T[], ys: T[]) => Object.fromEntries(xs.map((x) => {
    const o = ys.find((y) => y.id === x.id);
    return [x.id, !o ? 'add' : sameValue(o, x) ? '' : 'chg'];
  })) as Record<string, 'add' | 'chg' | ''>;
  return {
    seat: cmp(draft.seats, b.seats),
    group: cmp(draft.groups, b.groups),
    route: cmp(draft.routes, b.routes),
    goneSeats: b.seats.filter((s) => !seatById(draft, s.id)),
    goneRoutes: b.routes.filter((r) => !draft.routes.some((x) => x.id === r.id)),
  };
}

export type Flash = { t0: number; prev: Team; add: Marks; chg: Marks; goneSeats: Seat[]; goneRoutes: Route[] };
/** Cora's change, to flash for a few seconds: what she added (a --work edge), changed (a --run dot), removed (fading). */
export function flashOf(prev: Team, next: Team, t0: number): Flash {
  const f: Flash = { t0, prev, add: noMarks(), chg: noMarks(), goneSeats: prev.seats.filter((s) => !seatById(next, s.id)), goneRoutes: prev.routes.filter((r) => !next.routes.some((x) => x.id === r.id)) };
  const scan = <T extends { id: string }>(kind: keyof Marks, xs: T[], ys: T[]) => {
    for (const x of xs) {
      const o = ys.find((y) => y.id === x.id);
      if (!o) f.add[kind].add(x.id);
      else if (!sameValue(o, x)) f.chg[kind].add(x.id);
    }
  };
  scan('seat', next.seats, prev.seats);
  scan('group', next.groups, prev.groups);
  scan('route', next.routes, prev.routes);
  return f;
}

export const PALETTE = ['#60a5fa', '#38bdf8', '#a78bfa', '#3ddc97', '#fbbf24', '#fb923c', '#2dd4bf', '#c084fc', '#f87171', '#94a3b8'];
/** A colour for every seat that lacks one (the first not taken). */
export function withColors(look: TeamLayout, t: Team): TeamLayout {
  const color = { ...(look.color ?? {}) };
  const used = new Set(Object.values(color));
  for (const s of t.seats) {
    if (color[s.id]) continue;
    const c = PALETTE.find((x) => !used.has(x)) ?? PALETTE[t.seats.indexOf(s) % PALETTE.length];
    color[s.id] = c;
    used.add(c);
  }
  return { ...look, color };
}
/** A team with no positions yet (imported, proposed, from a shape) gets the automatic layout; positions you have stay. */
export function withPositions(look: TeamLayout, t: Team): TeamLayout {
  const missing = t.seats.some((s) => !look.pos[s.id]) || !look.pos['@user'];
  if (!missing) return look;
  const auto = autoLayout(t, measure);
  if (!Object.keys(look.pos).length) return { ...look, pos: auto };
  return placeNew({ ...t, seats: t.seats.filter((s) => look.pos[s.id]) }, t, look);
}
/** Cora's new seats: where the layout would put them, moved down until they're on nobody's; yours stay where they are. */
export function placeNew(prev: Team, next: Team, look: TeamLayout): TeamLayout {
  const auto = autoLayout(next, measure);
  const pos = { ...look.pos };
  if (!prev.seats.length) Object.assign(pos, auto);
  else {
    const fresh = next.seats.filter((s) => !seatById(prev, s.id) || !pos[s.id]);
    for (const s of fresh) {
      const p = { ...(auto[s.id] ?? { x: 0, y: 0 }) };
      const clash = () => next.seats.some((o) => o.id !== s.id && pos[o.id] && Math.abs(pos[o.id].x - p.x) < NODE_W && Math.abs(pos[o.id].y - p.y) < NODE_H + 8);
      for (let guard = 0; clash() && guard < 40; guard++) p.y += NODE_H + 12;
      pos[s.id] = p;
    }
    pos['@user'] ??= auto['@user'];
    pos['@cora'] ??= auto['@cora'];
  }
  return withColors({ ...look, pos }, next);
}

/** Every seat under a group (for dragging a region: its seats move with it). */
export const seatsUnder = (t: Team, gid: string) => seatsOf(t, gid);
