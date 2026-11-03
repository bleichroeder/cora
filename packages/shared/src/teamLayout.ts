/**
 * The canvas's sizes and the automatic layout:
 * seats nobody routes to on the left, each next hop further right, a group's seats together; You and Cora above.
 */
import { seatsOf, type Endpoint, type Route, type Team } from './teams';
import { idOf, kindsChip, labelsChip, parentsOf, seatById } from './teamHelpers';

export const NODE_W = 188;
export const NODE_H = 46;
export const FIX_W = 150;
export const PAD = 12;
export const LABEL_H = 26;
/** How far a loop (a route back to a seat on its left) swings out past its ends, and how much further each lane outside another. */
export const LOOP_OUT = 44;
export const LOOP_STEP = 16;
/** How far out a loop's curve reaches, the nth (from 0) of a stack of loops. */
export const loopReach = (n: number) => 0.75 * (LOOP_OUT + LOOP_STEP * n);
export type Pos = { x: number; y: number };
export type FontKind = 'chip' | 'name' | 'sub' | 'label' | 'labelDim';
/** How wide a text is in one of the canvas's fonts (the client measures with a canvas; this one guesses). */
export type Measure = (text: string, font: FontKind) => number;
const PER_CHAR: Record<FontKind, number> = { chip: 5.75, name: 7.1, sub: 6.35, label: 7.08, labelDim: 5.75 };
export const approxMeasure: Measure = (s, f) => s.length * PER_CHAR[f];
export const snap = (v: number) => Math.round(v / 4) * 4;

/** A route's chip: its kinds, its labels on a second line, room for the hand on an ask route. */
export function chipSize(r: Route, measure: Measure = approxMeasure): { w: number; h: number; lines: string[] } {
  const lines = [kindsChip(r), labelsChip(r)].filter(Boolean);
  const w = Math.max(0, ...lines.map((l) => measure(l, 'chip'))) + 12 + (r.wake === 'ask' ? 16 : 0);
  return { w: Math.ceil(w), h: lines.length > 1 ? 28 : 16, lines };
}

/** Each seat's layer: seats no seat routes to first, each next hop one further; a group's seats share the smallest. */
export function layersOf(t: Team): { ids: string[]; layer: Record<string, number>; targets(e: Endpoint): string[] } {
  const ids = t.seats.map((s) => s.id);
  const targets = (e: Endpoint) => (e.startsWith('seat:') ? [idOf(e)] : e.startsWith('group:') ? seatsOf(t, idOf(e)) : []);
  const out: Record<string, Set<string>> = Object.fromEntries(ids.map((i) => [i, new Set<string>()]));
  const indeg: Record<string, number> = Object.fromEntries(ids.map((i) => [i, 0]));
  for (const r of t.routes)
    for (const f of r.from)
      for (const a of targets(f))
        for (const b of targets(r.to))
          if (a !== b && out[a] && out[b] && !out[a].has(b)) {
            out[a].add(b);
            indeg[b]++;
          }
  const layer: Record<string, number> = {};
  const bfs = (starts: string[]) => {
    const q = [...starts];
    for (const i of starts) layer[i] ??= 0;
    while (q.length) {
      const a = q.shift()!;
      for (const b of out[a]) if (layer[b] === undefined) (layer[b] = layer[a] + 1), q.push(b);
    }
  };
  bfs(ids.filter((i) => indeg[i] === 0));
  for (const i of ids) if (layer[i] === undefined) bfs([i]);
  for (const g of t.groups) {
    const ss = g.members.filter((m) => seatById(t, m));
    if (ss.length > 1) {
      const l = Math.min(...ss.map((s) => layer[s]));
      for (const s of ss) layer[s] = l;
    }
  }
  return { ids, layer, targets };
}

/** Where each seat goes (top-left corners, on the 4px grid), and You and Cora ('@user', '@cora') above the first column. */
export function autoLayout(t: Team, measure: Measure = approxMeasure): Record<string, Pos> {
  const { ids, targets, layer } = layersOf(t);
  const chain = (id: string) => {
    const c: string[] = [];
    let p = parentsOf(t, id)[0];
    const seen = new Set<string>();
    while (p && !seen.has(p.id)) {
      seen.add(p.id);
      c.unshift(p.id);
      p = parentsOf(t, p.id)[0];
    }
    return c;
  };
  type Cell = { id: string; i: number; chain: string[] };
  const cols: Cell[][] = [];
  ids.forEach((id, i) => (cols[layer[id]] ??= []).push({ id, i, chain: chain(id) }));
  const pos: Record<string, Pos> = {};
  let x = 0;
  for (let L = 0; L < cols.length; L++) {
    const col = cols[L] ?? [];
    // a group's seats together, in the order the first of them came
    const firstAt: Record<string, number> = {};
    for (const c of col) firstAt[c.chain.join('/')] ??= c.i;
    col.sort((a, b) => firstAt[a.chain.join('/')] - firstAt[b.chain.join('/')] || a.i - b.i);
    let y = 0;
    const ys: number[] = [];
    col.forEach((c, j) => {
      if (j) {
        const p = col[j - 1].chain;
        let common = 0;
        while (common < p.length && common < c.chain.length && p[common] === c.chain[common]) common++;
        y += NODE_H + (p.length === common && c.chain.length === common ? 12 : PAD * (p.length - common) + LABEL_H * (c.chain.length - common) + 12);
      }
      ys.push(y);
    });
    const mid = ys.length ? (ys[ys.length - 1] + NODE_H) / 2 : 0;
    col.forEach((c, j) => (pos[c.id] = { x: snap(x), y: snap(ys[j] - mid) }));
    // room for the chips between this column and the next (routes on to it, and routes back from it), with the loops
    // swinging out either side of them, and for the regions either side
    const next = cols[L + 1] ?? [];
    let chipW = 0;
    let outHere = 0;
    let inNext = 0;
    for (const r of t.routes) {
      const fromHere = r.from.filter((f) => targets(f).some((a) => layer[a] === L));
      const fromNext = r.from.some((f) => targets(f).some((a) => layer[a] === L + 1));
      const to = targets(r.to).map((b) => layer[b]);
      if (fromHere.length && to.includes(L + 1)) chipW = Math.max(chipW, chipSize(r, measure).w + (fromHere.length > 1 || r.from.length > 1 ? 34 : 0));
      if (fromNext && to.includes(L)) chipW = Math.max(chipW, chipSize(r, measure).w);
      if (!to.length) continue;
      const toCol = Math.min(...to);
      for (const f of r.from) {
        const from = targets(f).map((a) => layer[a]);
        if (f === r.to || !from.length || Math.max(...from) < toCol) continue;
        if (Math.max(...from) === L) outHere++;
        if (toCol === L + 1) inNext++;
      }
    }
    const side = Math.max(28, ...[outHere, inNext].filter(Boolean).map((n) => loopReach(n - 1) + 8));
    let need = Math.max(120, chipW + 2 * side);
    need += PAD * Math.max(0, ...col.map((c) => c.chain.length)) + PAD * Math.max(0, ...next.map((c) => c.chain.length));
    x += NODE_W + need;
  }
  const c0 = (cols[0] ?? []).map((c) => pos[c.id].y - LABEL_H * c.chain.length);
  // a route from a group to itself loops over its region
  const loopsAbove = t.routes.some((r) => r.from.includes(r.to)) ? 44 : 0;
  const top = (c0.length ? Math.min(...c0) : 0) - loopsAbove;
  pos['@user'] = { x: 0, y: snap(top - 2 * NODE_H - 12 - 28) };
  pos['@cora'] = { x: 0, y: snap(top - NODE_H - 28) };
  return pos;
}
