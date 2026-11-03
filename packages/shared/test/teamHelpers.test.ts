import { describe, expect, it } from 'vitest';
import { bold, cap, depthOf, emptyTeam, endpointName, endpointOptions, endpointsOf, exampleTeam, gap, listSegs, listWords, newSeat, plural, rich, routeName, sameValue, teamShaped, uniqId, validateTeam } from '../src/index';
import { drillDraft, drillProposal, drillTheirs } from './fixtures';

describe('team helpers', () => {
  it('a sentence is plain text and runs: bold names, gaps the checks warn about', () => {
    const r = rich('Triage hands work to ', bold('Analysts'), gap(', but nothing handles ', bold('ingest'), ' issues'), '.');
    expect(r.text).toBe('Triage hands work to Analysts, but nothing handles ingest issues.');
    expect(r.segs[1]).toEqual({ t: 'Analysts', b: true });
    expect(r.segs[3]).toEqual({ t: 'ingest', b: true, gap: true });
    expect(listSegs([[bold('A')], [bold('B')], [bold('C')]]).map((s) => s.t).join('')).toBe('A, B and C');
  });

  it('words: lists, plurals, capitals', () => {
    expect(listWords([])).toBe('');
    expect(listWords(['a'])).toBe('a');
    expect(listWords(['a', 'b', 'c'])).toBe('a, b and c');
    expect([plural('analyst'), plural('box'), plural('copy'), plural('day')]).toEqual(['analysts', 'boxes', 'copies', 'days']);
    expect(cap('triage')).toBe('Triage');
  });

  it('names: endpoints, routes, the picker list', () => {
    const t = exampleTeam();
    expect(endpointName(t, 'seat:triage')).toBe('Triage');
    expect(endpointName(t, 'user')).toBe('You');
    expect(endpointsOf(t, 'seat:analyst-enc')).toEqual(['seat:analyst-enc', 'group:encoder-analysts', 'group:analysts']);
    expect(routeName(t, t.routes[0])).toBe('Monitor A, Monitor B → Triage');
    expect(endpointOptions(t).slice(0, 3)).toEqual([['user', 'You'], ['cora', 'Cora'], ['seat:monitor-a', 'Monitor A']]);
    expect(endpointOptions(t, { groups: false }).some(([e]) => e.startsWith('group:'))).toBe(false);
  });

  it('ids: a free one, the name made safe', () => {
    const t = exampleTeam();
    expect(uniqId(t, 'triage')).toBe('triage-b');
    expect(uniqId(t, 'triage', 'triage')).toBe('triage');
    expect(uniqId(t, '')).toBe('seat');
    expect(uniqId(t, 'peer-2')).toBe('peer-2');
    expect(uniqId({ ...t, seats: [...t.seats, { ...t.seats[0], id: 'peer-2' }] }, 'peer-2')).toBe('peer-b');
  });

  it('a free id is never one validateTeam would refuse beside a seat', () => {
    const t = exampleTeam();
    expect(uniqId(t, 'triage-2')).toBe('triage-b');
    expect(validateTeam({ ...t, seats: [...t.seats, newSeat(uniqId(t, 'triage-2'), 'X', 'C:/w')] })).toMatchObject({ ok: true });
  });

  it("a group's depth is its longest path, whatever the groups' order", () => {
    const g = (id: string, members: string[]) => ({ id, name: id, members, dispatch: 'claim' as const });
    const base = exampleTeam();
    // G is in P1 and P2; P1 in A; P2 in B; B in A; A in Z: the longest way up from G is 4
    const groups = [g('Z', ['A']), g('A', ['P1', 'B']), g('B', ['P2']), g('P1', ['G']), g('P2', ['G']), g('G', ['analyst-net'])];
    for (const gs of [groups, [...groups].reverse()]) expect(depthOf({ ...base, groups: gs }, 'G')).toBe(4);
  });

  it('two definitions that say the same are the same (empty values, key order)', () => {
    expect(sameValue({ a: 1, b: [] }, { a: 1 })).toBe(true);
    expect(sameValue({ a: '', b: 2 }, { b: 2 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("a draft's shape: lists and a fallback, whatever is in them", () => {
    expect(teamShaped(emptyTeam(3))).toBe(true);
    expect(teamShaped({ seats: [] })).toBe(false);
    expect(teamShaped(null)).toBe(false);
    expect(emptyTeam(3)).toEqual({ version: 3, seats: [], groups: [], labels: [], routes: [], fallback: 'user', escalation: [{ when: 'critical', then: ['tell-user'] }] });
    expect(newSeat('x', 'X', 'C:/w')).toEqual({ id: 'x', name: 'X', instructions: '', agent: {}, skills: [], folder: { path: 'C:/w' }, count: { min: 1, max: 1 }, startup: {} });
  });

  it('the drill team and its variants are valid teams', () => {
    for (const t of [exampleTeam(), drillDraft(), drillProposal(), drillTheirs()]) expect(validateTeam(t)).toMatchObject({ ok: true });
    expect(exampleTeam().version).toBe(4);
  });
});
