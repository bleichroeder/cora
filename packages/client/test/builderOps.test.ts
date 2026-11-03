import { describe, expect, it } from 'vitest';
import { addSeat, createRoute, deleteSel, editField, getPath, groupThem, moveMembership, renameEntity, renameInLook, toggleIn, toggleKind } from '../src/components/builder/draftOps';
import { clone, validateTeam, type Team } from '@cora/shared';
import { drill, drillDraft } from '@cora/shared/test/fixtures';

describe('editing the draft', () => {
  it('a new seat: named New seat (then New seat 2), one session, in the folder', () => {
    const a = addSeat(drill(), 'C:/w');
    expect(a.id).toBe('new-seat');
    expect(a.team.seats.at(-1)).toMatchObject({ name: 'New seat', folder: { path: 'C:/w' }, count: { min: 1, max: 1 } });
    const b = addSeat(a.team, 'C:/w');
    expect(b.team.seats.at(-1)!.name).toBe('New seat 2');
    expect(b.id).toBe('new-seat-b');
  });

  it('a new route asks before waking (the safe default) and carries anything', () => {
    const r = createRoute(drill(), 'seat:monitor-a', 'seat:analyst-net');
    expect(r.team.routes.at(-1)).toEqual({ id: r.id, from: ['seat:monitor-a'], to: 'seat:analyst-net', kinds: 'any', wake: 'ask' });
  });

  it("deleting a seat removes the routes to it (or only from it), and fixes the groups' splits and growth", () => {
    const d = deleteSel(drillDraft(), { kind: 'seat', ids: ['triage'] });
    expect(d.team.routes.map((r) => r.id)).toEqual([]);
    expect(d.team.fallback).toBe('user');
    expect(d.notice).toBe('Removed Triage, and 3 routes that went to or only from it.');
    const e = deleteSel(drillDraft(), { kind: 'seat', ids: ['analyst-enc'] });
    expect(e.team.groups.find((g) => g.id === 'encoder-analysts')).toMatchObject({ members: [] });
    expect(e.team.groups.find((g) => g.id === 'encoder-analysts')!.grow).toBeUndefined();
  });

  it('deleting a group keeps its members (in its parent) and drops its routes', () => {
    const d = deleteSel(drill(), { kind: 'group', ids: ['analysts'] });
    expect(d.team.groups.map((g) => g.id)).toEqual(['encoder-analysts', 'network-analysts']);
    expect(d.team.routes.map((r) => r.id)).toEqual(['r-monitors']);
    expect(d.notice).toBe('Removed the group Analysts (its members stay), and 2 routes to or from it.');
  });

  it("grouping seats takes them out of the group they shared, into the new one", () => {
    const g = groupThem(drill(), ['monitor-a', 'monitor-b']);
    expect(g.team.groups.at(-1)).toEqual({ id: 'new-group', name: 'New group', members: ['monitor-a', 'monitor-b'], dispatch: 'claim' });
  });

  it('dragging a seat into a region joins that group; out of its own, leaves it', () => {
    const a = moveMembership(drill(), 'analyst-enc', { into: 'network-analysts' });
    expect(a.team.groups.find((g) => g.id === 'network-analysts')!.members).toEqual(['analyst-net', 'analyst-enc']);
    expect(a.notice).toBe('Encoder analyst moved into Network analysts.');
    const b = moveMembership(drill(), 'analyst-enc', { out: true });
    expect(b.notice).toBe('Encoder analyst left Encoder analysts.');
  });

  it('a name: its id follows it until applied (every reference too), then stays', () => {
    const r = renameEntity(drill(), 'seat', 'triage', 'Hub desk', false);
    expect(r.id).toBe('hub-desk');
    expect(r.team.routes[0].to).toBe('seat:hub-desk');
    expect(r.team.fallback).toBe('seat:hub-desk');
    const k = renameEntity(drill(), 'seat', 'triage', 'Hub desk', true);
    expect(k.id).toBe('triage');
    expect(k.team.seats[2].name).toBe('Hub desk');
    const g = renameEntity(drill(), 'group', 'encoder-analysts', 'Encoders', false);
    expect(g.team.groups[0].split!.to.encoder).toBe('encoders');
    expect(renameInLook({ pos: { triage: { x: 1, y: 2 } }, color: { triage: '#60a5fa' } }, 'triage', 'hub-desk')).toEqual({ pos: { 'hub-desk': { x: 1, y: 2 } }, color: { 'hub-desk': '#60a5fa' } });
  });

  it("the inspector's edits: nested fields, a split by label, growth, quiet hours, escalation", () => {
    const t = drill();
    expect(editField(t, { kind: 'seat', ids: ['triage'] }, 'agent.model', 'opus').seats[2].agent.model).toBe('opus');
    expect(editField(t, { kind: 'seat', ids: ['triage'] }, 'agent.model', '').seats[2].agent.model).toBeUndefined();
    const g = editField(t, { kind: 'group', ids: ['analysts'] }, 'split.label', '');
    expect(g.groups[0].split).toBeUndefined();
    const grow = editField(t, { kind: 'group', ids: ['encoder-analysts'] }, 'grow.seat', 'analyst-enc');
    expect(grow.groups[1].grow).toEqual({ seat: 'analyst-enc', max: 2 });
    const q = editField(editField(t, { kind: 'seat', ids: ['triage'] }, 'limits.quiet.from', '22:00'), { kind: 'seat', ids: ['triage'] }, 'limits.quiet.from', '');
    expect(q.seats[2].limits).toBeUndefined();
    const e = editField(t, null, 'escalation.0.when', 'critical');
    expect(e.escalation[0]).toEqual({ when: 'critical', then: ['reoffer', 'tell-lead'] });
    expect(editField(t, null, 'escalation.0.scope.group', 'analysts').escalation[0].scope).toEqual({ group: 'analysts' });
    // a group picked keeps the rest of its scope (its severities); none picked leaves the rest
    const scoped = clone(t);
    scoped.escalation[0].scope = { group: 'monitors', severity: ['high'] };
    expect(editField(scoped, null, 'escalation.0.scope.group', 'analysts').escalation[0].scope).toEqual({ group: 'analysts', severity: ['high'] });
    expect(editField(scoped, null, 'escalation.0.scope.group', '').escalation[0].scope).toEqual({ severity: ['high'] });
    expect(editField(t, { kind: 'route', ids: ['r-handoff'] }, 'labels.issue', []).routes[1].labels).toBeUndefined();
    expect(t.seats[2].agent.model).toBe('sonnet');
    // required fields stay, emptied: instructions, skills, members
    expect(editField(t, { kind: 'seat', ids: ['triage'] }, 'instructions', '').seats[2].instructions).toBe('');
    expect(editField(t, { kind: 'seat', ids: ['triage'] }, 'skills', []).seats[2].skills).toEqual([]);
    expect(editField(t, { kind: 'group', ids: ['analysts'] }, 'members', []).groups[0].members).toEqual([]);
    expect(editField(t, { kind: 'seat', ids: ['triage'] }, 'agent.permissions.allow', []).seats[2].agent.permissions).toBeUndefined();
  });

  it('kinds: any, or a list in the usual order', () => {
    expect(toggleKind('any', 'note')).toEqual(['note']);
    expect(toggleKind(['note'], 'report')).toEqual(['report', 'note']);
    expect(toggleKind(['note'], 'note')).toBe('any');
    expect(toggleKind(['note'], 'any')).toBe('any');
    expect(toggleIn(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleIn(['a', 'b'], 'a')).toEqual(['b']);
  });
});

const deepFreeze = <T,>(o: T): T => {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};
const problems = (t: Team): string[] => {
  const r = validateTeam(t);
  return r.ok ? [] : r.problems;
};
/** The team the operation made has no problem the one it was given didn't. */
const noNewProblems = (before: Team, after: Team) => {
  const had = problems(before);
  expect(problems(after).filter((p) => !had.includes(p))).toEqual([]);
};
/** A team where the analysts group sits in a parent that splits to it and falls back to it, with rules scoped to it and to a route. */
function nested(): Team {
  const t = clone(drill());
  t.groups.push({ id: 'desk', name: 'Desk', members: ['analysts', 'monitor-a'], dispatch: 'claim', split: { label: 'issue', to: { net: 'analysts', enc: 'encoder-analysts' }, else: 'analysts' } });
  t.fallback = 'group:analysts';
  t.escalation.push({ when: 'unclaimed', after: 5, then: ['reoffer'], scope: { group: 'analysts' } });
  t.escalation.push({ when: 'unclaimed', after: 7, then: ['reoffer'], scope: { route: 'r-handoff', severity: ['high'] } });
  t.escalation.push({ when: 'unclaimed', after: 9, then: ['reoffer'], scope: { route: 'r-handoff' } });
  return t;
}

describe('deleting or moving leaves nothing pointing at what is gone', () => {
  it('a group delete clears the parent split (to and else), the fallback, the rule scoped to it; members move up without duplicates', () => {
    const t = nested();
    const d = deleteSel(deepFreeze(clone(t)), { kind: 'group', ids: ['analysts'] }).team;
    const desk = d.groups.find((g) => g.id === 'desk')!;
    expect(desk.split!.to).toEqual({ enc: 'encoder-analysts' });
    expect(desk.split!.else).toBeUndefined();
    expect(new Set(desk.members).size).toBe(desk.members.length);
    expect(desk.members).not.toContain('analysts');
    expect(d.fallback).toBe('user');
    expect(d.escalation.some((e) => e.scope?.group === 'analysts')).toBe(false);
    noNewProblems(t, d);
  });

  it('deleting several groups handles each, and a member already in the parent is not doubled', () => {
    const t = clone(drill());
    t.groups.push({ id: 'outer', name: 'Outer', members: ['analysts', 'analyst-net'], dispatch: 'claim' });
    const d = deleteSel(t, { kind: 'group', ids: ['analysts', 'outer'] });
    expect(d.team.groups.map((g) => g.id)).toEqual(['encoder-analysts', 'network-analysts']);
    expect(d.notice).toMatch(/^Removed the groups Analysts and Outer/);
    const o = deleteSel(t, { kind: 'group', ids: ['analysts'] }).team.groups.find((g) => g.id === 'outer')!;
    expect(new Set(o.members).size).toBe(o.members.length);
    noNewProblems(t, d.team);
  });

  it('routes that go take their escalation scope with them (the rule keeps what else it was scoped to)', () => {
    const t = nested();
    const viaRoute = deleteSel(t, { kind: 'route', ids: ['r-handoff'] }).team;
    expect(viaRoute.escalation.some((e) => e.scope?.route)).toBe(false);
    expect(viaRoute.escalation.find((e) => e.after === 7)!.scope).toEqual({ severity: ['high'] });
    expect(viaRoute.escalation.find((e) => e.after === 9)!.scope).toBeUndefined();
    const viaSeat = deleteSel(t, { kind: 'seat', ids: ['triage'] }).team;
    expect(viaSeat.routes.find((r) => r.id === 'r-handoff')).toBeUndefined();
    expect(viaSeat.escalation.some((e) => e.scope?.route === 'r-handoff')).toBe(false);
    const viaGroup = deleteSel(t, { kind: 'group', ids: ['analysts'] }).team;
    expect(viaGroup.escalation.some((e) => e.scope?.route === 'r-handoff')).toBe(viaGroup.routes.some((r) => r.id === 'r-handoff'));
  });

  it('deleting several seats at once removes each, their routes, splits and fallback', () => {
    const t = drillDraft();
    const d = deleteSel(deepFreeze(clone(t)), { kind: 'seat', ids: ['triage', 'monitor-a', 'monitor-b'] });
    expect(d.team.seats.map((s) => s.id)).toEqual(['analyst-enc', 'analyst-net']);
    expect(d.team.fallback).toBe('user');
    expect(d.notice).toMatch(/^Removed .* that went to or only from them\.$/);
    noNewProblems(t, d.team);
  });

  it('a rename carries growth, split else, and escalation scope with it', () => {
    const t = nested();
    t.groups.find((g) => g.id === 'encoder-analysts')!.grow = { seat: 'analyst-enc', max: 2 };
    const s = renameEntity(deepFreeze(clone(t)), 'seat', 'analyst-enc', 'Enc desk', false);
    expect(s.team.groups.find((g) => g.id === 'encoder-analysts')!.grow!.seat).toBe(s.id);
    noNewProblems(t, s.team);
    const g = renameEntity(deepFreeze(clone(t)), 'group', 'analysts', 'Duty', false);
    const desk = g.team.groups.find((x) => x.id === 'desk')!;
    expect(desk.split!.else).toBe(g.id);
    expect(Object.values(desk.split!.to)).toContain(g.id);
    expect(desk.members).toContain(g.id);
    expect(g.team.fallback).toBe(`group:${g.id}`);
    expect(g.team.escalation.some((e) => e.scope?.group === g.id)).toBe(true);
    noNewProblems(t, g.team);
  });

  it('no operation changes the team it was given, and none leaves a new problem', () => {
    const t = deepFreeze(drillDraft());
    const sel = { kind: 'seat' as const, ids: ['triage'] };
    const outs = [
      addSeat(t, 'C:/w').team,
      createRoute(t, 'seat:monitor-a', 'seat:triage').team,
      deleteSel(t, { kind: 'route', ids: ['r-handoff'] }).team,
      deleteSel(t, sel).team,
      deleteSel(t, { kind: 'group', ids: ['analysts'] }).team,
      groupThem(t, ['monitor-a', 'monitor-b']).team,
      moveMembership(t, 'analyst-enc', { into: 'network-analysts' }).team,
      moveMembership(t, 'analyst-enc', { out: true }).team,
      renameEntity(t, 'seat', 'triage', 'Hub desk', false).team,
      renameEntity(t, 'group', 'analysts', 'Duty', false).team,
      editField(t, sel, 'agent.model', 'opus'),
      editField(t, null, 'escalation.0.when', 'critical'),
    ];
    for (const o of outs) noNewProblems(t, o);
    expect(t).toEqual(drillDraft());
  });

  it("a seat leaving a group is no longer where that group's split sends work", () => {
    const t = nested();
    const desk = t.groups.find((g) => g.id === 'desk')!;
    desk.split = { label: 'issue', to: { net: 'analysts', mon: 'monitor-a' }, else: 'monitor-a' };
    const out = moveMembership(deepFreeze(clone(t)), 'monitor-a', { out: true }).team;
    expect(out.groups.find((g) => g.id === 'desk')!.split).toEqual({ label: 'issue', to: { net: 'analysts' } });
    noNewProblems(t, out);
    const into = moveMembership(deepFreeze(clone(t)), 'monitor-a', { into: 'network-analysts' }).team;
    expect(into.groups.find((g) => g.id === 'desk')!.split!.else).toBeUndefined();
    noNewProblems(t, into);
    const grouped = groupThem(deepFreeze(clone(t)), ['monitor-a', 'analysts']).team;
    expect(grouped.groups.find((g) => g.id === 'desk')!.split).toEqual({ label: 'issue', to: {} });
    noNewProblems(t, grouped);
  });

  it('moving into a missing group or the same group refuses (nothing changes, nothing claimed)', () => {
    const t = drill();
    expect(moveMembership(t, 'analyst-enc', { into: 'nope' })).toEqual({ team: t, notice: '' });
    expect(moveMembership(t, 'analyst-enc', { into: 'encoder-analysts' })).toEqual({ team: t, notice: '' });
    expect(moveMembership(t, 'ghost', { out: true })).toEqual({ team: t, notice: '' });
    expect(moveMembership(t, 'triage', { out: true })).toEqual({ team: t, notice: '' });
  });

  it('edits that point at nothing refuse instead of throwing or writing on the team', () => {
    const t = drill();
    expect(editField(t, null, 'escalation.9.when', 'critical')).toEqual(t);
    expect(editField(t, null, 'escalation.9.scope.group', 'analysts')).toEqual(t);
    expect(editField(t, { kind: 'seat', ids: ['ghost'] }, 'agent.model', 'opus')).toEqual(t);
    expect(editField(t, { kind: 'seat', ids: ['triage'] }, 'escalation.0.when', 'critical')).toEqual(t);
    expect(groupThem(t, []).team).toEqual(t);
  });

  it('paths through __proto__, constructor or prototype are refused', () => {
    const t = drill();
    expect(editField(t, null, '__proto__.polluted', 1)).toEqual(t);
    expect(editField(t, { kind: 'seat', ids: ['triage'] }, 'constructor.prototype.x', 1)).toEqual(t);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(getPath(t, '__proto__.constructor')).toBeUndefined();
  });
});

describe("the team's lead in the draft", () => {
  it('picked in the team form (none: no lead); follows its seat renamed; gone with its seat', () => {
    const t = editField(drill(), null, 'lead', 'triage');
    expect(t.lead).toBe('triage');
    expect('lead' in editField(t, null, 'lead', '')).toBe(false);
    expect(renameEntity(t, 'seat', 'triage', 'Hub desk', false).team.lead).toBe('hub-desk');
    const d = deleteSel(t, { kind: 'seat', ids: ['triage'] }).team;
    expect('lead' in d).toBe(false);
    expect(validateTeam(d).ok).toBe(true);
  });
});
