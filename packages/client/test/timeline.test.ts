import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { axisDur, blocksFrom, cluster, cursorAt, cursorLabel, fracOf, SNAP_PX, ticks, tsAt, type View } from '../src/lib/timeline';

const NOW = 10_000_000;
const base = { seq: 1, sessionId: 's', agentId: 'main', icon: { name: 'x', family: 'look' as const }, source: 'transcript' as const };
const tool = (id: string, ts: number, phase: 'start' | 'end', extra: Partial<BrainEvent> = {}): BrainEvent => ({ ...base, id: `${id}:${phase}`, ts, kind: 'tool', phase, toolUseId: id, tool: { name: 'Read', input: {}, summary: '' }, ...extra });

describe('time ↔ x', () => {
  const v: View = { end: NOW, span: 30_000 };
  it('places moments across the view, left edge 0 and right edge (now) 1', () => {
    expect(fracOf(NOW, v)).toBe(1);
    expect(fracOf(NOW - 30_000, v)).toBe(0);
    expect(fracOf(NOW - 15_000, v)).toBe(0.5);
    expect(fracOf(NOW - 60_000, v)).toBeLessThan(0);
  });
  it('maps a point back to its moment', () => {
    expect(tsAt(300, 600, v)).toBe(NOW - 15_000);
    expect(tsAt(0, 600, v)).toBe(NOW - 30_000);
    expect(fracOf(tsAt(123, 600, v), v) * 600).toBeCloseTo(123);
  });
  it('honours a view panned into the past', () => {
    const back: View = { end: NOW - 60_000, span: 120_000 };
    expect(tsAt(600, 600, back)).toBe(NOW - 60_000);
    expect(fracOf(NOW - 120_000, back)).toBe(0.5);
  });
});

describe('cursorAt', () => {
  const v: View = { end: NOW, span: 30_000 };
  it('is the moment under the point', () => {
    expect(cursorAt(300, 600, v, NOW)).toBe(NOW - 15_000);
  });
  it('snaps to live at the right edge when the view reaches now', () => {
    expect(cursorAt(600 - SNAP_PX + 1, 600, v, NOW)).toBeNull();
    expect(cursorAt(900, 600, v, NOW)).toBeNull();
  });
  it('does not snap when panned back, and clamps to the view', () => {
    const back: View = { end: NOW - 60_000, span: 30_000 };
    expect(cursorAt(600, 600, back, NOW)).toBe(NOW - 60_000);
    expect(cursorAt(-50, 600, back, NOW)).toBe(NOW - 90_000);
  });
  it('never lands in the future', () => {
    expect(cursorAt(595, 600, { end: NOW + 5000, span: 30_000 }, NOW)).toBeNull();
    expect(cursorAt(580, 600, { end: NOW + 5000, span: 30_000 }, NOW - 10_000)).toBe(NOW - 10_000);
  });
});

describe('ticks', () => {
  it('counts back from now, at least minPx apart, with readable labels', () => {
    const t = ticks({ end: NOW, span: 30_000 }, NOW, 600, 64);
    // 30s across 600px: 5s is 100px, the first step at least 64px
    expect(t.map((x) => x.label)).toEqual(['−25s', '−20s', '−15s', '−10s', '−5s']);
    expect(t[t.length - 1].frac).toBeCloseTo(25 / 30);
    for (let i = 1; i < t.length; i++) expect((t[i].frac - t[i - 1].frac) * 600).toBeGreaterThanOrEqual(64);
  });
  it('stays relative to now when panned', () => {
    const t = ticks({ end: NOW - 90_000, span: 600_000 }, NOW, 600, 64);
    expect(t.every((x) => x.frac >= 0 && x.frac <= 1)).toBe(true);
    expect(t[t.length - 1].label).toBe('−2m');
  });
  it('formats durations compactly', () => {
    expect(axisDur(45_000)).toBe('45s');
    expect(axisDur(120_000)).toBe('2m');
    expect(axisDur(90_000)).toBe('1m30s');
    expect(axisDur(3_900_000)).toBe('1h5m');
    expect(cursorLabel(NOW - 80_000, NOW, () => '14:00:00')).toBe('14:00:00 · 1m20s ago');
    expect(cursorLabel(NOW, NOW, () => '14:00:00')).toBe('14:00:00 · now');
  });
});

describe('cluster', () => {
  it('merges items closer than minPx and centres the group', () => {
    const c = cluster([{ x: 100 }, { x: 10 }, { x: 108 }, { x: 115 }, { x: 200 }], 16);
    expect(c.map((g) => g.items.length)).toEqual([1, 3, 1]);
    expect(c[1].x).toBe(107.5);
  });
  it('keeps everything when spread out', () => {
    expect(cluster([{ x: 0 }, { x: 20 }, { x: 40 }], 16)).toHaveLength(3);
    expect(cluster([], 16)).toEqual([]);
  });
});

describe('blocksFrom', () => {
  it('pairs tool starts and ends, keeps thinking, flags failures and running calls', () => {
    const b = blocksFrom(
      [
        tool('a', NOW - 5000, 'start'),
        tool('a', NOW - 4000, 'end'),
        tool('b', NOW - 3000, 'start'),
        tool('c', NOW - 2000, 'end', { durationMs: 500, tool: { name: 'Bash', input: {}, summary: '', failed: true } }),
        { ...base, id: 'th', ts: NOW - 1000, kind: 'think', durationMs: 800 },
      ],
      NOW,
    );
    expect(b.map((x) => [x.key, x.from, x.to, x.kind, !!x.failed])).toEqual([
      ['a', NOW - 5000, NOW - 4000, 'tool', false],
      ['b', NOW - 3000, null, 'tool', false],
      ['c', NOW - 2500, NOW - 2000, 'tool', true],
      ['th', NOW - 1800, NOW - 1000, 'think', false],
    ]);
  });
  it('closes calls that never ended after half an hour', () => {
    const [b] = blocksFrom([tool('a', NOW - 31 * 60_000, 'start')], NOW);
    expect(b.to).toBe(b.from);
  });
});

describe('stackRows', () => {
  it('splits only overlapping runs into rows, reusing a row once it frees up', async () => {
    const { stackRows } = await import('../src/lib/timeline');
    const r = stackRows(
      [
        { key: 'a', from: 0, to: 10 },
        { key: 'b', from: 2, to: 4 },
        { key: 'c', from: 5, to: 8 },
        { key: 'd', from: 20, to: 30 },
        { key: 'e', from: 25, to: null },
      ],
      40,
    );
    expect(r.get('a')).toEqual({ row: 0, rows: 2 });
    expect(r.get('b')).toEqual({ row: 1, rows: 2 });
    expect(r.get('c')).toEqual({ row: 1, rows: 2 });
    expect(r.get('d')).toEqual({ row: 0, rows: 2 });
    expect(r.get('e')).toEqual({ row: 1, rows: 2 });
    expect(stackRows([{ key: 'x', from: 0, to: 5 }, { key: 'y', from: 5, to: 9 }], 9).get('y')).toEqual({ row: 0, rows: 1 });
  });
});
