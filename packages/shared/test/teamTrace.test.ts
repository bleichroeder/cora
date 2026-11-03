import { describe, expect, it } from 'vitest';
import { TRACE_CAVEAT, traceMessage, type Team } from '../src/index';
import { drill, drillDraft } from './fixtures';

const words = (t: Team, m: Parameters<typeof traceMessage>[1]) => traceMessage(t, m).steps.map((s) => s.text);

describe('traceMessage: a pretend message through the team', () => {
  it("a monitor to another monitor is blocked, in routeAllows's own words", () => {
    const tr = traceMessage(drill(), { from: 'seat:monitor-a', to: 'seat:monitor-b', kind: 'direct' });
    expect(tr.reached).toBeNull();
    expect(tr.steps[0]).toMatchObject({ kind: 'blocked', text: 'Monitor A may not message Monitor B. It may message Triage. Send it to Triage instead.', blocked: { from: 'seat:monitor-a', to: 'seat:monitor-b' } });
    expect(tr.steps.at(-1)).toMatchObject({ kind: 'caveat', text: TRACE_CAVEAT });
  });

  it('a labelled handoff goes down the split to the right pool, and says who claims it and what escalates', () => {
    const tr = traceMessage(drill(), { from: 'seat:triage', to: 'group:analysts', kind: 'handoff', labels: { issue: 'encoder' } });
    expect(tr.reached).toBe('analyst-enc');
    expect(tr.steps.map((s) => s.text)).toEqual([
      'Matches Triage → Analysts · handoff · issue=encoder|network · wake auto',
      'It must include station, symptom and since, or it bounces back to Triage.',
      'Analysts splits by issue: encoder → Encoder analysts.',
      'Claim: an incident is opened for it and offered to the free members of Encoder analysts (Encoder analyst). The first to claim it owns it.',
      'Idle free members are woken at once to see the offer (wake auto).',
      "If none is free, it waits for one (Encoder analysts doesn't grow).",
      "+10 min nobody has claimed it: it's offered again.",
      '+20 min still nobody has: the lead is told.',
      'Reaches Encoder analyst.',
      TRACE_CAVEAT,
    ]);
    expect(tr.steps[0]).toMatchObject({ kind: 'route', route: 'r-handoff', from: 0 });
    expect(tr.steps[2].mark).toEqual({ kind: 'group', id: 'encoder-analysts' });
    expect(tr.steps.filter((s) => s.kind === 'escalate').map((s) => s.after)).toEqual([10, 20]);
  });

  it('a network handoff reaches the network analyst', () => {
    expect(traceMessage(drill(), { from: 'seat:triage', to: 'group:analysts', kind: 'handoff', labels: { issue: 'network' } }).reached).toBe('analyst-net');
  });

  it('an ingest handoff is blocked: the route carries only encoder and network', () => {
    expect(words(drill(), { from: 'seat:triage', to: 'group:analysts', kind: 'handoff', labels: { issue: 'ingest' } })[0]).toBe('Triage may not message Analysts this way (kind or labels do not match a route). It may message Analysts.');
  });

  it("a pool grows only as far as its seat's count.max, whatever grow.max says", () => {
    const t = drillDraft();
    t.groups.find((g) => g.id === 'encoder-analysts')!.grow = { seat: 'analyst-enc', max: 5 };
    expect(words(t, { from: 'seat:triage', to: 'group:analysts', kind: 'handoff', labels: { issue: 'encoder' } })).toContain('If none is free, Cora starts another Encoder analyst with the work in its first prompt: the pool grows to 2 of 2.');
  });

  it('a pool grows when none is free (to how many)', () => {
    expect(words(drillDraft(), { from: 'seat:triage', to: 'group:analysts', kind: 'handoff', labels: { issue: 'encoder' } })).toContain('If none is free, Cora starts another Encoder analyst with the work in its first prompt: the pool grows to 2 of 2.');
  });

  it('an ask route makes a card for you', () => {
    const tr = traceMessage(drillDraft(), { from: 'seat:analyst-enc', to: 'seat:triage', kind: 'question' });
    expect(tr.steps.map((s) => s.text)).toEqual(['Matches Analysts → Triage · note · question · direct · wake ask', 'If Triage is idle, a card in Needs you asks you to wake it (wake ask); without your OK it reads this at its next prompt.', 'Reaches Triage.', TRACE_CAVEAT]);
    expect(tr.reached).toBe('triage');
  });

  it('something critical reaches you at once', () => {
    expect(words(drill(), { from: 'seat:triage', to: 'group:analysts', kind: 'handoff', labels: { issue: 'encoder' }, critical: true })).toContain("It's critical: you're told, at once.");
  });

  it('you and Cora need no route; anyone may message you', () => {
    expect(words(drill(), { from: 'user', to: 'seat:triage', kind: 'direct' }).slice(0, 2)).toEqual(['You may message anyone: no route needed.', "If Triage is idle, it's woken at once (wake auto)."]);
    const back = traceMessage(drill(), { from: 'seat:monitor-a', to: 'user', kind: 'question' });
    expect(back.steps.map((s) => s.text).slice(0, 3)).toEqual(['Anyone may message you: no route needed.', 'It lands in your Needs you.', 'Reaches you.']);
    expect(back.reached).toBe('user');
  });

  it('a direct group needs its sender to name a member', () => {
    const t: Team = { ...drill(), groups: drill().groups.map((g) => (g.id === 'encoder-analysts' ? { ...g, dispatch: 'direct' as const } : g)) };
    const tr = traceMessage(t, { from: 'seat:triage', to: 'group:analysts', kind: 'handoff', labels: { issue: 'encoder' } });
    expect(tr.steps.map((s) => s.text)).toContain('Direct: a message to Encoder analysts must name one of its members (Encoder analyst).');
    expect(tr.reached).toBeNull();
  });

  it('an escalation scoped to a group that holds the landing group shows; one scoped to a group that does not hold it does not', () => {
    const base = drill();
    const t: Team = {
      ...base,
      groups: [...base.groups, { id: 'all-analysts', name: 'All analysts', members: ['encoder-analysts', 'network-analysts'], dispatch: 'claim' }],
      escalation: [
        { when: 'unclaimed', after: 5, scope: { group: 'all-analysts', severity: ['high', 'critical'] }, then: ['tell-user'] },
        { when: 'unclaimed', after: 7, scope: { group: 'network-analysts' }, then: ['tell-lead'] },
        { when: 'unclaimed', after: 9, scope: { group: 'analysts' }, then: ['dm-user'] },
      ],
    };
    const esc = traceMessage(t, { from: 'seat:triage', to: 'group:analysts', kind: 'handoff', labels: { issue: 'encoder' } }).steps.filter((s) => s.kind === 'escalate');
    expect(esc.map((s) => s.text)).toEqual(["+5 min nobody has claimed it (if its severity is high or critical): you're told.", '+9 min nobody has claimed it: you get a DM.']);
  });
});
