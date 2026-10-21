import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { assignSlots, resourceColumn, resourceLabel, SLOT_Y, topResources } from '../src/scene/layout';

describe('assignSlots', () => {
  it('keeps existing assignments and fills the lowest free slot', () => {
    const a = assignSlots(new Map(), ['x', 'y']);
    expect([...a]).toEqual([['x', 0], ['y', 1]]);
    const b = assignSlots(a, ['y', 'z']); // x finished
    expect(b.get('y')).toBe(1);
    expect(b.get('z')).toBe(0);
    expect(b.has('x')).toBe(false);
  });
  it('overflow agents get -1', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const m = assignSlots(new Map(), ids);
    expect(SLOT_Y).toHaveLength(6);
    expect(m.get('g')).toBe(-1);
    expect(m.get('h')).toBe(-1);
  });
});

describe('resources', () => {
  const ev = (resource: string, ts = 1): BrainEvent => ({ id: Math.random() + '', seq: 1, sessionId: 's', agentId: 'main', ts, kind: 'tool', phase: 'start', icon: { name: 'x', family: 'look' }, source: 'hook', tool: { name: 'Read', input: {}, summary: '', resource } });
  it('ranks by touch count, max N, then sorts by kind for a stable column', () => {
    // files:src touched most; among single touches, shell and web are the most recent
    const evs = [ev('files:src'), ev('files:src'), ev('files:docs', 2), ev('mcp:github', 3), ev('shell', 5), ev('web:code.claude.com', 6)];
    expect(topResources(evs, 3)).toEqual(['web:code.claude.com', 'files:src', 'shell']);
  });
  it('column is centred and evenly spaced', () => {
    const c = resourceColumn(['a', 'b', 'c']);
    expect(c.get('a')).toEqual({ x: 11, y: 1.6 });
    expect(c.get('b')).toEqual({ x: 11, y: 0 });
    expect(c.get('c')).toEqual({ x: 11, y: -1.6 });
  });
  it('labels', () => {
    expect(resourceLabel('files:src')).toBe('src/');
    expect(resourceLabel('files')).toBe('files');
    expect(resourceLabel('web:code.claude.com')).toBe('code.claude.com');
    expect(resourceLabel('web:search')).toBe('web search');
    expect(resourceLabel('mcp:ops')).toBe('ops · mcp');
    expect(resourceLabel('browser')).toBe('browser');
  });
});

describe('nestedPos', () => {
  const near = (a: { x: number; y: number }, b: { x: number; y: number }, span: { x: number; y: number }) => Math.abs(a.x - b.x) < span.x && Math.abs(a.y - b.y) < span.y - 1e-6;

  it('puts a subagent started by a subagent to the right of its parent, short of the resources', async () => {
    const { nestedPos, NEST_DX, RES_X } = await import('../src/scene/layout');
    const parent = { x: 1.2, y: 3.4 };
    const c = nestedPos(parent, [parent]);
    expect(c.x).toBeCloseTo(1.2 + NEST_DX);
    expect(Math.abs(c.y - parent.y)).toBeLessThan(1); // beside it, not off in a corner
    const deep = nestedPos({ x: 5.6, y: 0 }, [{ x: 5.6, y: 0 }]);
    expect(deep.x).toBeLessThanOrEqual(RES_X - 2.8);
  });

  it("keeps siblings and a helper's own helpers clear of each other and of their parents", async () => {
    const { nestedPos, LABEL_SPAN_X, AGENT_SPAN_Y } = await import('../src/scene/layout');
    const span = { x: LABEL_SPAN_X, y: AGENT_SPAN_Y };
    // main's helper in slot 2, its helper ("Trace the sink"), and that one's helper ("Dig into the parser")
    const placed = [{ x: -8.5, y: 0 }, { x: 1.2, y: 0 }];
    const trace = nestedPos(placed[1], placed);
    placed.push(trace);
    const dig = nestedPos(trace, placed);
    placed.push(dig);
    expect(dig.x - trace.x).toBeLessThan(LABEL_SPAN_X); // it shares its parent's column (the resources are close)…
    expect(Math.abs(dig.y - trace.y)).toBeGreaterThanOrEqual(AGENT_SPAN_Y - 1e-6); // …so it sits above or below it
    // another helper of each: nobody lands on anybody
    for (const parent of [placed[1], trace]) placed.push(nestedPos(parent, placed));
    for (let i = 1; i < placed.length; i++) for (let j = 0; j < i; j++) expect(near(placed[i], placed[j], span), `${i} vs ${j}`).toBe(false);
    for (const p of placed) expect(Math.abs(p.y)).toBeLessThanOrEqual(6.2);
  });

  it('packs a crowd into the column, and where none is clear takes the spot that overlaps least', async () => {
    const { nestedPos, LABEL_SPAN_X, AGENT_SPAN_Y } = await import('../src/scene/layout');
    const span = { x: LABEL_SPAN_X, y: AGENT_SPAN_Y };
    // three of main's helpers, each with a helper, two of which start helpers of their own (the simulator's busy scene)
    const placed = [{ x: -8.5, y: 0 }, { x: 1.2, y: 3.4 }, { x: 1.2, y: -3.4 }, { x: 1.2, y: 0 }];
    const kids = [placed[1], placed[3], placed[2]].map((p) => {
      const c = nestedPos(p, placed);
      placed.push(c);
      return c;
    });
    placed.push(nestedPos(kids[1], placed));
    for (let i = 1; i < placed.length; i++) for (let j = 0; j < i; j++) expect(near(placed[i], placed[j], span), `${i} vs ${j}`).toBe(false);
    // one more: the column is full, so nowhere is clear, but it doesn't land on anyone
    const extra = nestedPos(kids[2], placed);
    for (const p of placed) expect(Math.hypot(p.x - extra.x, p.y - extra.y)).toBeGreaterThan(1);
  });
});

describe('beaconArc', () => {
  it("opens a waiting agent's beacon at the bottom, so even its widest ring stays above the agent's name", async () => {
    const { beaconArc, BEACON, ORB_R, tagDrop } = await import('../src/scene/layout');
    for (const [b, top] of [[BEACON.main, tagDrop(ORB_R.main, true)], [BEACON.sub, tagDrop(ORB_R.sub, false)]] as const) {
      const { start, length } = beaconArc(b.r1, top);
      expect(length).toBeGreaterThan(Math.PI); // most of a ring
      for (let i = 0; i <= 64; i++) {
        const th = start + (length * i) / 64;
        for (const r of [b.r0, (b.r0 + b.r1) / 2, b.r1]) expect(r * Math.sin(th)).toBeGreaterThan(-top); // above the name
      }
      expect(start + length / 2).toBeCloseTo(Math.PI / 2); // centred on the top, open at the bottom
    }
    expect(beaconArc(1, 5).length).toBeCloseTo(Math.PI * 2); // a name far below: the whole ring
  });
});
