import { describe, expect, it } from 'vitest';
import { buildShape, DEFAULT_ESCALATION_AFTER, describeTeam, editPhrase, emptyTeam, escalationSentence, newSeat, SHAPE_DEFAULTS, summarizeChange, type Team } from '../src/index';
import { drill, drillDraft } from './fixtures';

const lines = (t: Team, ctx = {}) => describeTeam(t, ctx).map((l) => l.text);

describe('describeTeam: the team in plain words', () => {
  it('the drill team, sources first, an answer right after the route it answers', () => {
    expect(lines(drill())).toEqual([
      'Monitor A and Monitor B report to Triage; Triage is woken for them.',
      'Triage hands encoder and network issues to the Analysts: encoder ones to Encoder analyst, network ones to Network analyst, but ingest issues go to everyone in the Analysts, since nothing handles them on its own. Whoever is free first claims it. Each must include station, symptom and since.',
      'The Analysts answer Triage with notes and questions; Triage is woken for them.',
      'Work nobody claims is offered again after 10 minutes, and the lead is told after 20 minutes; anything critical reaches you at once.',
      "Anything a seat isn't allowed to send can go to Triage instead.",
      'You and Cora may message anyone, and anyone may message you.',
    ]);
  });

  it("each line's targets: its route, then the seats and groups it names", () => {
    const [first, second] = describeTeam(drill());
    expect(first.section).toBe('flow');
    expect(first.targets).toEqual([{ kind: 'route', id: 'r-monitors' }, { kind: 'seat', id: 'monitor-a' }, { kind: 'seat', id: 'monitor-b' }, { kind: 'seat', id: 'triage' }]);
    expect(second.targets).toEqual(expect.arrayContaining([{ kind: 'group', id: 'encoder-analysts' }, { kind: 'group', id: 'network-analysts' }]));
  });

  it('a warned gap reads in its sentence (marked as a gap), names bold', () => {
    const second = describeTeam(drill())[1];
    const gapText = second.segs.filter((s) => s.gap).map((s) => s.t).join('');
    expect(gapText).toBe(", but ingest issues go to everyone in the Analysts, since nothing handles them on its own");
    expect(second.segs.find((s) => s.t === 'Analysts')?.b).toBe(true);
  });

  it('pools, ask routes, and a seat that is usually idle', () => {
    const out = lines(drillDraft(), { usuallyIdle: (id: string) => id === 'triage' });
    expect(out[1]).toContain('encoder ones to Encoder analysts (a pool of 1, growing to 2 when busy)');
    expect(out[2]).toBe("The Analysts answer Triage with notes and questions. If Triage is idle, it's woken only with your OK, and it usually is, so most of these will wait for you.");
  });

  it('the shapes read too', () => {
    expect(lines(buildShape('squad', SHAPE_DEFAULTS.squad, { folder: 'C:/w' }))[0]).toBe('Everyone in the Squad may message each other; an idle one is woken for it.');
    expect(lines(buildShape('pipeline', SHAPE_DEFAULTS.pipeline, { folder: 'C:/w' }))[0]).toBe('Draft hands work to Review; Review is woken for it.');
  });

  it("nobody yet; a seat that isn't connected; no escalation", () => {
    expect(lines(emptyTeam())[0]).toBe('Nobody is on the team yet. Double-click the canvas for a seat, start from a shape, or build it with Cora.');
    const t = { ...drill(), escalation: [], seats: [...drill().seats, newSeat('x', 'X', 'C:/w')] };
    const out = lines(t);
    expect(out).toContain("X isn't connected yet: nobody messages it, and it messages nobody.");
    expect(out).toContain('Nothing happens on its own when work sits: there are no escalation rules yet.');
  });
});

describe('an escalation rule as a sentence (the Team panel says it as In words does, as the runtime fires it)', () => {
  it('each step at its own time (the default when the rule names none), its group and severities', () => {
    const t = drill();
    t.groups.push({ id: 'enc', name: 'Encoders', members: [], dispatch: 'claim' });
    expect(escalationSentence(t, { when: 'unclaimed', after: 15, then: ['reoffer', 'tell-user'] })).toBe("Work nobody claims is offered again after 15 minutes, and you're told after 30 minutes.");
    expect(escalationSentence(t, { when: 'unclaimed', then: ['reoffer', 'tell-user'] })).toBe(`Work nobody claims is offered again after ${DEFAULT_ESCALATION_AFTER} minutes, and you're told after ${2 * DEFAULT_ESCALATION_AFTER} minutes.`);
    expect(escalationSentence(t, { when: 'unclaimed', after: 5, scope: { group: 'enc', severity: ['high', 'critical'] }, then: ['tell-user'] })).toMatch(/^Work nobody claims in the Encoders \(high or critical only\): /);
  });
});

describe('describeTeam: what the runtime really does', () => {
  const sits = (t: Team) => describeTeam(t).find((l) => l.section === 'sits')!.text;

  it('each escalation step has its own time, in the order of the rule', () => {
    const t = drill();
    t.escalation = [
      { when: 'unclaimed', after: 5, then: ['tell-lead', 'reoffer', 'dm-user'] },
      { when: 'stale', after: 10, then: ['nudge-owner', 'tell-lead'] },
    ];
    expect(sits(t)).toBe("Work nobody claims: the lead is told after 5 minutes, it's offered again after 10 minutes, and you get a DM after 15 minutes; if an owner goes quiet, its owner is nudged after 10 minutes, and the lead is told after 20 minutes.");
  });

  it('an unset time is the default, never zero minutes', () => {
    const t = drill();
    t.escalation = [{ when: 'unclaimed', then: ['reoffer'] }];
    expect(sits(t)).toBe(`Work nobody claims is offered again after ${DEFAULT_ESCALATION_AFTER} minutes.`);
  });

  it('critical steps that are not for you or the lead are still said', () => {
    const t = drill();
    t.escalation = [{ when: 'critical', then: ['tell-user', 'nudge-owner'] }];
    expect(sits(t)).toBe("Anything critical is handled at once: you're told and its owner is nudged.");
  });

  it('a rule with no steps says it does nothing yet (never "reaches  at once")', () => {
    const t = drill();
    t.escalation = [
      { when: 'critical', then: [] },
      { when: 'unclaimed', after: 5, then: [] },
    ];
    expect(sits(t)).toBe('Anything critical: nothing happens yet (the rule has no steps); work nobody claims: nothing happens yet (the rule has no steps).');
  });

  it("work held up, and a rule kept to one group, say so; no rules, that nothing happens", () => {
    const t = drill();
    t.escalation = [
      { when: 'blocked', after: 3, then: ['tell-user'] },
      { when: 'critical', scope: { group: 'analysts' }, then: ['tell-lead'] },
    ];
    expect(sits(t)).toBe("If a limit or a checkpoint holds work up, you're told after 3 minutes; anything critical in the Analysts reaches the lead at once.");
    t.escalation = [];
    expect(sits(t)).toBe('Nothing happens on its own when work sits: there are no escalation rules yet.');
  });

  it('a pool does not grow when its route never wakes anyone', () => {
    const t = drillDraft();
    t.routes.find((r) => r.to === 'group:analysts')!.wake = 'never';
    const out = lines(t);
    expect(out[1]).not.toContain('growing');
    expect(out[1]).toContain('encoder ones to Encoder analysts (a pool of 1)');
  });

  it('a split that names a seat hands the work to everyone in the group', () => {
    const t = drill();
    const g = t.groups.find((x) => x.split)!;
    g.split!.to.encoder = 'analyst-enc';
    const second = describeTeam(t)[1];
    expect(second.text).toContain('encoder ones go to everyone in the Analysts, since the split names a seat rather than a group');
    expect(second.segs.some((x) => x.gap && x.t.includes('encoder ones'))).toBe(true);
  });
});

describe("Cora's one-line summaries", () => {
  it('what changed, in order: seats, routes, groups', () => {
    expect(summarizeChange(drill(), drillDraft())).toBe('changed Triage · Encoder analyst: pool 1 → 1 to 2 · route Analysts → Triage wakes ask · changed Encoder analysts');
    expect(summarizeChange(drill(), drill())).toBe('no change');
  });

  it('as she would say it back, cut after two', () => {
    expect(editPhrase(drill(), drillDraft())).toBe('changed Triage, Encoder analyst: pool 1 → 1 to 2 and 2 more');
    const t = drill();
    t.seats.push(newSeat('monitor-c', 'Monitor C', 'C:/w'));
    t.routes[0].from.push('seat:monitor-c');
    expect(editPhrase(drill(), t)).toBe('added Monitor C and changed route Monitor A, Monitor B, Monitor C → Triage');
  });
});

describe('describeTeam: the lead', () => {
  it('one sentence says which seat leads, and what that means', () => {
    const out = describeTeam({ ...drill(), lead: 'triage' });
    const lead = out.find((l) => /leads/.test(l.text))!;
    expect(lead.text).toBe('Triage leads the team: it proposes changes to the team, and opens and assigns its incidents.');
    expect(lead.section).toBe('also');
    expect(lead.targets).toEqual([{ kind: 'seat', id: 'triage' }]);
    expect(lines(drill()).some((l) => /leads/.test(l))).toBe(false);
    expect(summarizeChange(drill(), { ...drill(), lead: 'triage' })).toBe('lead Triage');
    // the team's skills too (never "no change" for a skills-only edit)
    expect(summarizeChange(drill(), { ...drill(), skills: [{ name: 'runbook', description: 'd', body: 'b' }] })).toBe('added the team skill runbook');
    const withSkill = { ...drill(), skills: [{ name: 'runbook', description: 'd', body: 'b' }] };
    expect(summarizeChange(withSkill, { ...drill(), skills: [{ name: 'runbook', description: 'd', body: 'new' }] })).toBe('changed the team skill runbook');
    expect(summarizeChange(withSkill, drill())).toBe('removed the team skill runbook');
  });
});
