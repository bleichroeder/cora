import { describe, expect, it } from 'vitest';
import { autoLayout, clone, LABEL_H, NODE_H, NODE_W, PAD, newSeat, seatsOf, type Endpoint, type Route, type Team, type TeamLayout } from '@cora/shared';
import { contentBounds, dropTarget, laneY, epBox, fitView, flashOf, groupBoxes, placeNew, ports, proposalMarks, routeGeom, seatBox, seatSub, withColors, withPositions, zoomAt, type Box, type RouteGeom } from '../src/components/builder/geometry';
import { drill, drillDraft, drillProposal } from '@cora/shared/test/fixtures';

const lookOf = (t = drill()): TeamLayout => ({ pos: autoLayout(t) });

const mkRoute = (id: string, from: string[], to: string, o: Partial<Route> = {}): Route => ({ id, from: from as Endpoint[], to: to as Endpoint, kinds: 'any', wake: 'auto', ...o });
const teamOf = (seats: string[], groups: Team['groups'], routes: Route[]): Team => ({ version: 1, seats: seats.map((s) => newSeat(s, s, 'C:/w')), groups, labels: [], routes, fallback: 'user', escalation: [] });
/** The user's "YouTube Factory" draft: the channel manager talks with four seats, each answering it. `two`: chips on two lines. */
function youtube(two = false): Team {
  const o = (x: Partial<Route> = {}): Partial<Route> => (two ? { kinds: ['handoff', 'question'], labels: { topic: ['video', 'short'] }, ...x } : x);
  return teamOf(['channel-manager', 'idea-writer', 'producer', 'publisher', 'analyst'], [{ id: 'producers', name: 'Producers', members: ['producer'], dispatch: 'claim' }], [
    mkRoute('r-idea-cm', ['seat:idea-writer'], 'seat:channel-manager', o()),
    mkRoute('r-cm-idea', ['seat:channel-manager'], 'seat:idea-writer', o()),
    mkRoute('r-cm-prod', ['seat:channel-manager'], 'group:producers', o()),
    mkRoute('r-prod-cm', ['group:producers'], 'seat:channel-manager', o()),
    mkRoute('r-cm-pub', ['seat:channel-manager'], 'seat:publisher', o({ wake: 'ask' })),
    mkRoute('r-pub-cm', ['seat:publisher'], 'seat:channel-manager', o()),
    mkRoute('r-an-cm', ['seat:analyst'], 'seat:channel-manager', o()),
    mkRoute('r-cm-an', ['seat:channel-manager'], 'seat:analyst', o()),
  ]);
}
const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const chipBox = (G: RouteGeom): Box => ({ x: G.chip!.x - G.cs.w / 2, y: G.chip!.y - G.cs.h / 2, w: G.cs.w, h: G.cs.h });
/** Everything the canvas lays out: every route's drawing, and the boxes (seats, regions with their labels, You and Cora). */
function drawn(t: Team, look: TeamLayout) {
  const gb = groupBoxes(t, look);
  const P = ports(t.routes);
  const geoms = t.routes.map((r) => [r.id, routeGeom(t, look, r, gb, P)!] as const);
  const boxes: Array<[string, Box]> = [...t.seats.map((s) => [s.id, seatBox(look, s.id)!] as [string, Box]), ...t.groups.map((g) => [`group:${g.id}`, gb[g.id]!] as [string, Box]), ['You', epBox(t, look, 'user', gb)!], ['Cora', epBox(t, look, 'cora', gb)!]];
  return { geoms, boxes, chips: geoms.filter(([, G]) => G.chip).map(([id, G]) => [id, chipBox(G)] as const) };
}
/** Whatever overlaps what it shouldn't: boxes, chips, loops' runs under the boxes. */
function clashes(t: Team, look: TeamLayout): string[] {
  const { geoms, boxes, chips } = drawn(t, look);
  const out: string[] = [];
  // a seat sits inside its own group's region
  const own = (a: string, b: string) => b.startsWith('group:') && seatsOf(t, b.slice(6)).includes(a);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (hit(boxes[i][1], boxes[j][1]) && !own(boxes[i][0], boxes[j][0])) out.push(`${boxes[i][0]} on ${boxes[j][0]}`);
  for (let i = 0; i < chips.length; i++) for (let j = i + 1; j < chips.length; j++) if (hit(chips[i][1], chips[j][1])) out.push(`chip ${chips[i][0]} on chip ${chips[j][0]}`);
  for (const [id, c] of chips) for (const [bid, b] of boxes) if (hit(c, b)) out.push(`chip ${id} on ${bid}`);
  for (const [id, G] of geoms)
    for (const l of G.legs)
      if (l.run) for (const [bid, b] of boxes) if (l.run.x0 < b.x + b.w && b.x < l.run.x1 && l.run.y >= b.y && l.run.y <= b.y + b.h) out.push(`${id}'s loop through ${bid}`);
  return out;
}

describe('the canvas geometry', () => {
  it('a group is a region around its members: padding, and room for its label above', () => {
    const t = drill();
    const look = lookOf(t);
    const gb = groupBoxes(t, look);
    const s = seatBox(look, 'analyst-enc')!;
    expect(gb['encoder-analysts']).toMatchObject({ x: s.x - PAD, y: s.y - LABEL_H, h: NODE_H + LABEL_H + PAD });
    expect(gb.analysts!.y).toBe(gb['encoder-analysts']!.y - LABEL_H);
    expect(epBox(t, look, 'group:analysts', gb)).toBe(gb.analysts);
    expect(epBox(t, look, 'user', gb)).toMatchObject({ w: 150, h: NODE_H });
  });

  it('arrows sharing a side are spread 10px apart', () => {
    const t = drill();
    const P = ports(t.routes);
    expect(P.tip(t.routes[0]) - P.tip(t.routes[2])).toBe(-10);
  });

  it('routes: several senders merge into a trunk; one sender is one curve; an answer loops back below', () => {
    const t = drill();
    const look = lookOf(t);
    const gb = groupBoxes(t, look);
    const P = ports(t.routes);
    const merged = routeGeom(t, look, t.routes[0], gb, P)!;
    expect(merged.legs).toHaveLength(2);
    expect(merged.trunk).toMatch(/^M/);
    const one = routeGeom(t, look, t.routes[1], gb, P)!;
    expect(one.legs).toHaveLength(1);
    expect(one.trunk).toBeNull();
    const back = routeGeom(t, look, t.routes[2], gb, P)!;
    expect(back.chip!.y).toBeGreaterThan(seatBox(look, 'triage')!.y + NODE_H);
  });

  it('fit frames everything, at most 100%, at least 45%; zoom keeps the point under the cursor', () => {
    const t = drill();
    const b = contentBounds(t, lookOf(t));
    const v = fitView({ width: 1600, height: 900 }, b);
    expect(v.k).toBeLessThanOrEqual(1);
    expect(v.k).toBeGreaterThanOrEqual(0.45);
    const z = zoomAt({ x: 0, y: 0, k: 1 }, 100, 100, -200);
    expect(z.k).toBeGreaterThan(1);
    expect((100 - z.x) / z.k).toBeCloseTo(100);
  });

  it("dropping a seat: into another group's region, out of its own, or nothing", () => {
    const t = drill();
    const look = lookOf(t);
    const gb = groupBoxes(t, look);
    const net = gb['network-analysts']!;
    expect(dropTarget(t, gb, 'analyst-enc', { x: net.x + 20, y: net.y + 30 })).toEqual({ into: 'network-analysts' });
    expect(dropTarget(t, gb, 'analyst-enc', { x: -2000, y: -2000 })).toEqual({ out: true });
    const own = seatBox(look, 'analyst-enc')!;
    expect(dropTarget(t, gb, 'analyst-enc', { x: own.x + 10, y: own.y + 10 })).toBeNull();
    expect(dropTarget(t, gb, 'triage', { x: -2000, y: -2000 })).toBeNull();
  });

  it("a proposal's marks: added, changed, removed", () => {
    const m = proposalMarks(drill(), drillProposal());
    expect(m.seat['analyst-ing']).toBe('add');
    expect(m.seat['analyst-enc']).toBe('chg');
    expect(m.seat.triage).toBe('');
    expect(m.group['ingest-analysts']).toBe('add');
    expect(m.route['r-monitors']).toBe('chg');
    expect(m.goneSeats.map((s) => s.id)).toEqual(['monitor-b']);
  });

  it("Cora's change flashes: what she added, changed and removed", () => {
    const f = flashOf(drill(), drillDraft(), 5);
    expect([...f.chg.seat]).toEqual(['triage', 'analyst-enc']);
    expect([...f.chg.route]).toEqual(['r-back']);
    expect(f.add.seat.size).toBe(0);
  });

  it("her new seats go where the layout puts them, never on top of yours; every seat gets a colour", () => {
    const prev = drill();
    const look = withColors(withPositions({ pos: {} }, prev), prev);
    expect(Object.keys(look.color!)).toHaveLength(5);
    const next = clone(prev);
    next.seats.push(newSeat('monitor-c', 'Monitor C', 'C:/w'));
    next.routes[0].from.push('seat:monitor-c');
    const after = placeNew(prev, next, look);
    const c = after.pos['monitor-c'];
    for (const s of prev.seats) {
      const o = after.pos[s.id];
      expect(Math.abs(o.x - c.x) < NODE_W && Math.abs(o.y - c.y) < NODE_H + 8).toBe(false);
      expect(o).toEqual(look.pos[s.id]);
    }
    expect(after.color!['monitor-c']).toBeDefined();
  });

  it.each([['one-line chips', false], ['two-line chips', true]] as const)('Tidy on the YouTube Factory (%s): nothing lands on anything, every loop runs under the boxes it passes', (_k, two) => {
    const t = youtube(two);
    const look = lookOf(t);
    expect(clashes(t, look)).toEqual([]);
    // the four answers to the channel manager each get a lane of their own
    const { geoms } = drawn(t, look);
    const ys = geoms.flatMap(([, G]) => G.legs.flatMap((l) => (l.run ? [l.run.y] : [])));
    expect(ys).toHaveLength(4);
    expect(new Set(ys).size).toBe(4);
  });

  it('fit frames the loops and their chips too', () => {
    for (const t of [youtube(), youtube(true), drill()]) {
      const look = lookOf(t);
      const b = contentBounds(t, look);
      const within = (x: Box) => x.x >= b.x && x.y >= b.y && x.x + x.w <= b.x + b.w && x.y + x.h <= b.y + b.h;
      for (const [, G] of drawn(t, look).geoms) {
        if (G.chip) expect(within(chipBox(G))).toBe(true);
        expect(within(G.ext)).toBe(true);
        for (const l of G.legs) if (l.run) expect(l.run.y + G.cs.h / 2).toBeLessThanOrEqual(b.y + b.h);
      }
    }
  });

  it('two answers on one route: each its own lane, one chip, nothing crossed', () => {
    const t = teamOf(['lead', 'a', 'b'], [], [mkRoute('r-out-a', ['seat:lead'], 'seat:a'), mkRoute('r-out-b', ['seat:lead'], 'seat:b'), mkRoute('r-back', ['seat:a', 'seat:b'], 'seat:lead', { kinds: ['note', 'question'], labels: { issue: ['encoder', 'network'] } })]);
    const look = lookOf(t);
    const gb = groupBoxes(t, look);
    const G = routeGeom(t, look, t.routes[2], gb, ports(t.routes))!;
    expect(G.legs).toHaveLength(2);
    const [y0, y1] = G.legs.map((l) => l.run!.y);
    expect(Math.abs(y0 - y1)).toBeGreaterThanOrEqual(12);
    expect(clashes(t, look)).toEqual([]);
  });

  it('a group routing to itself still loops above its region, its chip clear of everything', () => {
    const t = teamOf(['lead', 'a', 'b'], [{ id: 'pool', name: 'Pool', members: ['a', 'b'], dispatch: 'claim' }], [mkRoute('r-in', ['seat:lead'], 'group:pool'), mkRoute('r-self', ['group:pool'], 'group:pool', { kinds: ['note'] }), mkRoute('r-up', ['group:pool'], 'seat:lead')]);
    const look = lookOf(t);
    const gb = groupBoxes(t, look);
    const G = routeGeom(t, look, t.routes[1], gb, ports(t.routes))!;
    expect(G.legs).toHaveLength(1);
    expect(G.legs[0].run!.y).toBeLessThan(gb.pool!.y);
    expect(G.chip!.y + G.cs.h / 2).toBeLessThan(gb.pool!.y);
    expect(clashes(t, look)).toEqual([]);
  });

  it('a seat in two groups still gets both regions (drawn from where it is), and a group cycle does not crash', () => {
    const t = clone(drill());
    const look = lookOf(t);
    t.groups.find((g) => g.id === 'network-analysts')!.members.push('analyst-enc');
    const gb = groupBoxes(t, look);
    expect(gb['network-analysts']).not.toBeNull();
    expect(gb['encoder-analysts']).not.toBeNull();
    const a = t.groups[0];
    const b = t.groups[1];
    a.members.push(b.id);
    b.members.push(a.id);
    expect(() => groupBoxes(t, look)).not.toThrow();
  });
});

describe('laneY', () => {
  // the numbers from the live freeze (Tidy on a team where Studio Tech and Producers route to each other)
  it('a lane one gap past another that measures a rounding short of it ends there, instead of being pushed there for ever', () => {
    const others = [{ y: 217.6655132871463, sep: 24 }, { y: 241.6655132871463, sep: 24 }];
    expect(Math.abs(241.6655132871463 - (241.6655132871463 + 24)) < 24).toBe(true); // the rounding that trapped it
    expect(laneY(217.6655132871463, others, false)).toBeCloseTo(265.6655132871463, 6);
  });
  it('pushed past every lane it is too near, down or up', () => {
    expect(laneY(100, [{ y: 100, sep: 12 }, { y: 112, sep: 12 }, { y: 124, sep: 24 }], false)).toBe(148);
    expect(laneY(100, [{ y: 100, sep: 12 }, { y: 88, sep: 12 }], true)).toBe(76);
    expect(laneY(100, [{ y: 200, sep: 12 }], false)).toBe(100);
  });
});

describe("a seat's line under its name", () => {
  it('its model and pool, and that it leads when it is the lead seat', () => {
    const s = drill().seats[2];
    expect(seatSub(s)).not.toMatch(/leads/);
    expect(seatSub(s, true)).toBe(`leads · ${seatSub(s)}`);
  });
});
