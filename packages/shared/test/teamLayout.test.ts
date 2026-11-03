import { describe, expect, it } from 'vitest';
import { autoLayout, buildShape, chipSize, layersOf, LOOP_OUT, LOOP_STEP, newSeat, NODE_H, NODE_W, SHAPE_DEFAULTS, type Endpoint, type Pos, type Route, type Team } from '../src/index';
import { drill } from './fixtures';

const o = { folder: 'C:/w' };
const SHAPED: Array<[string, Team]> = [
  ['hub', buildShape('hub', SHAPE_DEFAULTS.hub, o)],
  ['pipeline', buildShape('pipeline', SHAPE_DEFAULTS.pipeline, o)],
  ['squad', buildShape('squad', SHAPE_DEFAULTS.squad, o)],
  ['blank', buildShape('blank', {}, o)],
];
const mk = (id: string, from: string[], to: string, o: Partial<Route> = {}): Route => ({ id, from: from as Endpoint[], to: to as Endpoint, kinds: 'any', wake: 'auto', ...o });
const teamOf = (seats: string[], routes: Route[]): Team => ({ version: 1, seats: seats.map((s) => newSeat(s, s, 'C:/w')), groups: [], labels: [], routes, fallback: 'user', escalation: [] });
const overlap = (a: Pos, b: Pos) => a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + NODE_H && b.y < a.y + NODE_H;

describe('autoLayout: left to right by route distance', () => {
  it.each(SHAPED)('%s: no two seats overlap; sources on the left; You and Cora above the first column', (_k, t) => {
    const pos = autoLayout(t);
    const ids = t.seats.map((s) => s.id);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(overlap(pos[ids[i]], pos[ids[j]])).toBe(false);
    const { layer } = layersOf(t);
    const minX = Math.min(...ids.map((id) => pos[id].x));
    for (const id of ids) if (layer[id] === 0) expect(pos[id].x).toBe(minX);
    expect(pos['@user']).toBeDefined();
    expect(pos['@cora'].y).toBeGreaterThan(pos['@user'].y);
    if (ids.length) expect(pos['@cora'].y + NODE_H).toBeLessThanOrEqual(Math.min(...ids.map((id) => pos[id].y)));
  });

  it('the hub: sources, then the hub, then the pools', () => {
    const t = SHAPED[0][1];
    const pos = autoLayout(t);
    expect(pos['monitor-a'].x).toBeLessThan(pos.triage.x);
    expect(pos.triage.x).toBeLessThan(pos['encoder-analyst'].x);
    expect(pos['encoder-analyst'].x).toBe(pos['network-analyst'].x);
  });

  it('layers: seats nobody routes to first, each next hop further on', () => {
    expect(layersOf(drill()).layer).toEqual({ 'monitor-a': 0, 'monitor-b': 0, triage: 1, 'analyst-enc': 2, 'analyst-net': 2 });
  });

  it("a route's chip: kinds, then labels on a second line; room for the hand on an ask route", () => {
    const r = drill().routes[1];
    expect(chipSize(r, (s) => s.length * 6)).toEqual({ w: Math.ceil('issue=encoder|network'.length * 6 + 12), h: 28, lines: ['handoff', 'issue=encoder|network'] });
    expect(chipSize({ ...r, labels: undefined, wake: 'ask' }, (s) => s.length * 6).w).toBe(Math.ceil(7 * 6 + 12 + 16));
  });
  it('a chip with no kinds and no labels still has a real width', () => {
    const r = { ...drill().routes[1], kinds: [] as never[], labels: undefined };
    expect(chipSize(r, (s) => s.length * 6)).toEqual({ w: 12, h: 16, lines: [] });
    expect(chipSize({ ...r, wake: 'ask' }, (s) => s.length * 6).w).toBe(28);
  });

  it('odd teams: a cycle, nested groups, a seat in two groups, a group in two parents', () => {
    const t = drill();
    const [a, b, c, d] = ['monitor-a', 'monitor-b', 'triage', 'analyst-enc'];
    t.groups = [
      { id: 'g1', name: 'G1', members: [a, b, 'g2'], dispatch: 'claim' },
      { id: 'g2', name: 'G2', members: [c, 'g3'], dispatch: 'claim' },
      { id: 'g3', name: 'G3', members: [d], dispatch: 'claim' },
      { id: 'g4', name: 'G4', members: [a, c, 'g3'], dispatch: 'claim' },
      { id: 'g5', name: 'G5', members: ['g3'], dispatch: 'claim' },
    ];
    const mk = (id: string, from: string, to: string) => ({ id, from: [from as never], to: to as never, kinds: 'any' as const, wake: 'auto' as const });
    t.routes = [mk('r1', `seat:${a}`, `seat:${b}`), mk('r2', `seat:${b}`, `seat:${c}`), mk('r3', `seat:${c}`, `seat:${a}`), mk('r4', 'group:g1', 'group:g1')];
    const pos = autoLayout(t);
    for (const p of Object.values(pos)) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    const ids = t.seats.map((s) => s.id);
    for (const id of ids) expect(pos[id]).toBeDefined();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(overlap(pos[ids[i]], pos[ids[j]])).toBe(false);
  });

  it("the gap between two columns holds the chip of a route back from the second to the first", () => {
    const back = mk('r-back', ['seat:b'], 'seat:a', { kinds: ['note', 'question', 'decision'], labels: { issue: ['encoder', 'network', 'ingest', 'storage'] } });
    const t = teamOf(['a', 'b'], [mk('r-out', ['seat:a'], 'seat:b'), back]);
    const pos = autoLayout(t);
    expect(pos.b.x - (pos.a.x + NODE_W)).toBeGreaterThanOrEqual(chipSize(back).w + 56);
  });

  it("loops swinging out of a column leave the next gap's chips room on either side", () => {
    // three seats in the middle column each answer the lead: their loops swing out right, into the gap before the last column
    const bs = ['b1', 'b2', 'b3'];
    const fwd = bs.map((b) => mk(`r-${b}-c`, [`seat:${b}`], 'seat:c', { wake: 'ask' }));
    const t = teamOf(['a', ...bs, 'c'], [...bs.map((b) => mk(`r-a-${b}`, ['seat:a'], `seat:${b}`)), ...fwd, ...bs.map((b) => mk(`r-${b}-a`, [`seat:${b}`], 'seat:a'))]);
    const pos = autoLayout(t);
    const swing = 0.75 * (LOOP_OUT + LOOP_STEP * (bs.length - 1));
    expect(pos.c.x - (pos.b1.x + NODE_W)).toBeGreaterThanOrEqual(chipSize(fwd[0]).w + 2 * (swing + 8));
  });
});
