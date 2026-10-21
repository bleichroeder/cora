import type { BrainEvent } from '@cora/shared';

/** A bar on an agent's lane: a tool call (start to end) or a stretch of thinking. `to` null: still running. */
export type Block = { key: string; agentId: string; from: number; to: number | null; kind: 'tool' | 'think'; e: BrainEvent; failed?: boolean };

/** Tool calls without an end for this long are stale (Claude Code never said how they ended). */
const STALE_MS = 30 * 60_000;

/** The session's tool calls and thinking as lane blocks, in event order. */
export function blocksFrom(events: BrainEvent[], now = Date.now()): Block[] {
  const tools = new Map<string, Block>();
  const out: Block[] = [];
  for (const e of events) {
    if (e.kind === 'tool' && e.toolUseId) {
      const b = tools.get(e.toolUseId);
      if (e.phase === 'start') {
        if (b) b.from = Math.min(b.from, e.ts);
        else {
          const nb: Block = { key: e.toolUseId, agentId: e.agentId, from: e.ts, to: null, kind: 'tool', e };
          tools.set(e.toolUseId, nb);
          out.push(nb);
        }
      } else if (b) {
        b.to = Math.max(e.ts, b.from + (e.durationMs ?? 0));
        b.failed = e.tool?.failed;
      } else {
        const nb: Block = { key: e.toolUseId, agentId: e.agentId, from: e.ts - (e.durationMs ?? 0), to: e.ts, kind: 'tool', e, failed: e.tool?.failed };
        tools.set(e.toolUseId, nb);
        out.push(nb);
      }
    } else if (e.kind === 'think' && e.durationMs) {
      out.push({ key: e.id, agentId: e.agentId, from: e.ts - e.durationMs, to: e.ts, kind: 'think', e });
    }
  }
  for (const b of out) if (b.to == null && now - b.from > STALE_MS) b.to = b.from;
  return out;
}

/** The visible stretch of time: `end` is the right edge (now, unless panned back), `span` its length in ms. */
export type View = { end: number; span: number };

/** Where a moment sits across the view, 0 (left edge) to 1 (right edge); outside the view it's outside 0..1. */
export const fracOf = (ts: number, v: View) => (ts - (v.end - v.span)) / v.span;
/** The moment under a point `x` px into a track `width` px wide. */
export const tsAt = (x: number, width: number, v: View) => v.end - v.span + (x / Math.max(1, width)) * v.span;

/** How close (px) to the right edge a dragged playhead snaps back to live. */
export const SNAP_PX = 8;

/**
 * Where the playhead goes for a point on the track: a moment (never in the future), or null (live) when it's dropped
 * at the right edge while the view reaches now.
 */
export function cursorAt(x: number, width: number, v: View, now: number): number | null {
  if (v.end >= now && x >= width - SNAP_PX) return null;
  const ts = tsAt(Math.max(0, Math.min(width, x)), width, v);
  return Math.min(ts, now);
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000);

/** A duration the way the axis reads it: 45s, 2m, 1m30s, 1h, 1h5m. */
export function axisDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${Math.floor(m / 60)}h`;
}

/**
 * The axis ticks: counted back from now (so they stay put while time flows under them and their labels don't churn),
 * spaced at least `minPx` apart. Each is a position (0..1) and how long ago it is.
 */
export function ticks(v: View, now: number, width: number, minPx = 64): Array<{ frac: number; label: string }> {
  const step = STEPS.find((s) => (s / v.span) * width >= minPx) ?? STEPS[STEPS.length - 1];
  const out: Array<{ frac: number; label: string }> = [];
  const start = v.end - v.span;
  // the first tick at or before the right edge, a whole number of steps before now
  let k = Math.max(1, Math.ceil((now - v.end) / step));
  for (; now - k * step >= start; k++) {
    const frac = fracOf(now - k * step, v);
    // too close to the left edge: its label would be cut in half
    if (frac * width >= 14) out.push({ frac, label: `−${axisDur(k * step)}` });
  }
  return out.reverse();
}

/** Things close together on screen (`x` px) merged into one, so a busy stretch doesn't pile up. */
export function cluster<T extends { x: number }>(items: T[], minPx: number): Array<{ x: number; items: T[] }> {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const out: Array<{ x: number; items: T[] }> = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && it.x - last.items[last.items.length - 1].x < minPx) last.items.push(it);
    else out.push({ x: it.x, items: [it] });
  }
  // a merged group sits in the middle of what it holds
  for (const c of out) c.x = (c.items[0].x + c.items[c.items.length - 1].x) / 2;
  return out;
}

/** Clock time with seconds, and how long before now: "14:03:41 · 1m20s ago". */
export function cursorLabel(ts: number, now: number, clock: (ts: number) => string): string {
  const ago = now - ts;
  return `${clock(ts)} · ${ago < 1000 ? 'now' : `${axisDur(ago)} ago`}`;
}

/**
 * Rows for blocks that overlap on one lane (parallel tool calls): each run of overlapping blocks is split into as
 * many rows as it needs at once (`row` of `rows`), and a block that overlaps nothing keeps the whole lane (0 of 1).
 * `end` is where a running block ends for now.
 */
export function stackRows(blocks: Array<{ key: string; from: number; to: number | null }>, end: number): Map<string, { row: number; rows: number }> {
  const out = new Map<string, { row: number; rows: number }>();
  const sorted = [...blocks].sort((a, b) => a.from - b.from);
  let run: Array<{ key: string; row: number }> = [];
  let rowEnds: number[] = [];
  let runEnd = -Infinity;
  const flush = () => {
    for (const r of run) out.set(r.key, { row: r.row, rows: rowEnds.length });
    run = [];
    rowEnds = [];
  };
  for (const b of sorted) {
    const to = Math.max(b.from, b.to ?? end);
    if (b.from >= runEnd) flush();
    let row = rowEnds.findIndex((e) => e <= b.from);
    if (row < 0) row = rowEnds.push(to) - 1;
    else rowEnds[row] = to;
    run.push({ key: b.key, row });
    runEnd = Math.max(runEnd, to);
  }
  flush();
  return out;
}
