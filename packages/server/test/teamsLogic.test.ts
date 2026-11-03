import { describe, it, expect } from 'vitest';
import { validateTeam, routeAllows, resolveGroup, seatAgentName, seatHandle, teamPluginName, seatsOf, seatCard, diffTeam, sameTeam, teamChangeLines, teamChangeDetails, proposalSkipsPrompts, clone, type Team, type Seat, type Group } from '@cora/shared';

const seat = (id: string, name: string, count = { min: 1, max: 1 }): Seat => ({
  id, name, instructions: '', agent: {}, skills: [], folder: { path: 'C:/work' }, count, startup: {},
});
const group = (g: Partial<Group> & { id: string; members: string[] }): Group => ({ name: g.id, dispatch: 'direct', ...g });

function ops(): Team {
  return {
    version: 1,
    seats: [seat('mail', 'Mail'), seat('slack', 'Slack'), seat('infra', 'Infra'), seat('triage', 'Triage'),
      seat('analyst', 'Analyst', { min: 1, max: 3 }), seat('encoder-analyst', 'Encoder analyst')],
    groups: [
      group({ id: 'monitors', members: ['mail', 'slack', 'infra'] }),
      group({ id: 'analysts', members: ['enc', 'gen'], split: { label: 'issue', to: { encoder: 'enc' }, else: 'gen' } }),
      group({ id: 'enc', members: ['encoder-analyst'], dispatch: 'claim', grow: { seat: 'encoder-analyst', max: 2 } }),
      group({ id: 'gen', members: ['analyst'], dispatch: 'claim', grow: { seat: 'analyst', max: 3 } }),
    ],
    labels: [{ id: 'issue', name: 'Issue', values: ['encoder', 'network', 'other'] }],
    routes: [
      { id: 'r1', from: ['group:monitors'], to: 'seat:triage', kinds: ['report'], wake: 'auto' },
      { id: 'r2', from: ['seat:triage'], to: 'group:analysts', kinds: ['handoff'], wake: 'auto', template: { fields: ['summary', 'cause'] } },
      { id: 'r3', from: ['group:analysts'], to: 'seat:triage', kinds: 'any', wake: 'auto' },
    ],
    fallback: 'user',
    escalation: [],
  };
}

describe('routeAllows', () => {
  it('allows a seat inside a group via the group route', () => {
    const r = routeAllows(ops(), 'seat:mail', 'seat:triage', 'report');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.route.id).toBe('r1');
  });
  it('refuses a route that does not exist, naming who may be messaged', () => {
    const r = routeAllows(ops(), 'seat:mail', 'seat:slack', 'direct');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).toContain('Mail may not message Slack');
      expect(r.why).toContain('Triage');
      expect(r.may).toEqual(['seat:triage']);
    }
  });
  it('refuses the wrong kind', () => {
    expect(routeAllows(ops(), 'seat:mail', 'seat:triage', 'direct').ok).toBe(false);
  });
  it('a route to a group allows any seat under it (nested) and the group itself', () => {
    expect(routeAllows(ops(), 'seat:triage', 'seat:analyst', 'handoff').ok).toBe(true);
    expect(routeAllows(ops(), 'seat:triage', 'seat:encoder-analyst', 'handoff').ok).toBe(true);
    expect(routeAllows(ops(), 'seat:triage', 'group:enc', 'handoff').ok).toBe(true);
    expect(routeAllows(ops(), 'seat:triage', 'group:analysts', 'handoff').ok).toBe(true);
    expect(routeAllows(ops(), 'seat:triage', 'seat:mail', 'handoff').ok).toBe(false);
  });
  it('a nested seat matches a route from an outer group', () => {
    expect(routeAllows(ops(), 'seat:encoder-analyst', 'seat:triage', 'question').ok).toBe(true);
  });
  it('filters by labels', () => {
    const t = ops();
    t.routes.push({ id: 'r4', from: ['seat:triage'], to: 'group:enc', kinds: ['question'], labels: { issue: ['encoder'] }, wake: 'ask' });
    expect(routeAllows(t, 'seat:triage', 'seat:encoder-analyst', 'question', { issue: 'encoder' }).ok).toBe(true);
    expect(routeAllows(t, 'seat:triage', 'seat:encoder-analyst', 'question', { issue: 'network' }).ok).toBe(false);
    expect(routeAllows(t, 'seat:triage', 'seat:encoder-analyst', 'question').ok).toBe(false);
  });
  it('user and cora may message anyone; anyone may message user', () => {
    const t = ops();
    expect(routeAllows(t, 'user', 'seat:mail', 'direct').ok).toBe(true);
    expect(routeAllows(t, 'cora', 'group:monitors', 'note').ok).toBe(true);
    expect(routeAllows(t, 'seat:mail', 'user', 'question').ok).toBe(true);
    expect(routeAllows(t, 'group:gen', 'user', 'note').ok).toBe(true);
  });
});

describe('resolveGroup / seatsOf', () => {
  it('follows the split by label, else the else', () => {
    const e = resolveGroup(ops(), 'analysts', { issue: 'encoder' });
    expect(e.group.id).toBe('enc');
    expect(e.seats).toEqual(['encoder-analyst']);
    const g = resolveGroup(ops(), 'analysts');
    expect(g.group.id).toBe('gen');
    expect(g.seats).toEqual(['analyst']);
    expect(resolveGroup(ops(), 'analysts', { issue: 'network' }).group.id).toBe('gen');
  });
  it('a group with no split resolves to itself', () => {
    expect(resolveGroup(ops(), 'monitors').group.id).toBe('monitors');
  });
  it('a group the team does not have: said by its id (never a crash on undefined)', () => {
    expect(() => resolveGroup(ops(), 'nope')).toThrow('This team has no group "nope".');
  });
  it('seatsOf nests', () => {
    expect(seatsOf(ops(), 'analysts').sort()).toEqual(['analyst', 'encoder-analyst']);
    expect(seatsOf(ops(), 'monitors')).toEqual(['mail', 'slack', 'infra']);
  });
});

describe('seatAgentName and seatHandle', () => {
  it("an agent in its team's own plugin: cora-team-<project>:<seat>, lowercase dashes", () => {
    expect(seatAgentName('p1x', 'Triage Lead')).toBe('cora-team-p1x:triage-lead');
    expect(seatAgentName('P_1', '--A  b!--')).toBe('cora-team-p-1:a-b');
    expect(teamPluginName('P_1')).toBe('cora-team-p-1');
  });
  it('a seat session is named by its seat, its number in a pool, and its project (two teams never share a name)', () => {
    expect(seatHandle('f5b6a1c2d3e4', 'triage')).toBe('triage-f5b6');
    expect(seatHandle('f5b6a1c2d3e4', 'analyst', 2)).toBe('analyst-2-f5b6');
    expect(seatHandle('0a1b2c3d4e5f', 'triage')).not.toBe(seatHandle('f5b6a1c2d3e4', 'triage'));
  });
});

describe('validateTeam', () => {
  it('accepts a good team', () => {
    expect(validateTeam(ops()).ok).toBe(true);
  });
  it('never throws on garbage', () => {
    for (const g of [null, undefined, 5, 'x', [], {}, { seats: 'no' }, { seats: [null], groups: [1], routes: [{}] }]) {
      expect(validateTeam(g).ok).toBe(false);
    }
  });
  it('reports every problem', () => {
    const t = ops();
    t.seats.push(seat('mail', 'Mail again'));
    t.seats.push(seat('bad id:x', 'Bad'));
    t.seats.push(seat('wide', 'Wide', { min: 3, max: 1 }));
    t.routes.push({ id: 'r9', from: ['seat:mail'], to: 'seat:ghost', kinds: 'any', wake: 'auto' });
    t.routes.push({ id: 'r10', from: ['seat:mail'], to: 'group:enc', kinds: 'any', labels: { issue: ['bogus'] }, wake: 'auto' });
    t.groups[1].split = { label: 'issue', to: { encoder: 'monitors' } };
    t.groups.push(group({ id: 'ca', members: ['cb'] }), group({ id: 'cb', members: ['ca'] }));
    const r = validateTeam(t);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const all = r.problems.join('\n');
      expect(all).toMatch(/duplicate.*mail/i);
      expect(all).toMatch(/bad id:x/);
      expect(all).toMatch(/wide.*min/i);
      expect(all).toMatch(/ghost/);
      expect(all).toMatch(/bogus/);
      expect(all).toMatch(/not a member/i);
      expect(all).toMatch(/cycle/i);
      expect(r.problems.length).toBeGreaterThanOrEqual(7);
    }
  });
  it('rejects ids with spaces', () => {
    const t = ops();
    t.groups.push(group({ id: 'has space', members: [] }));
    expect(validateTeam(t).ok).toBe(false);
  });
});

describe('seatCard', () => {
  it('a monitor: routes to Triage only, reports', () => {
    expect(seatCard(ops(), 'mail').split('\n')).toEqual([
      'Your seat: Mail.',
      'You may message: Triage (reports), and the user (anything).',
      'Messages outside these are refused, saying who you may message instead.',
    ]);
  });
  it('triage: handoff route with a label filter and a template; reaches-you from monitors', () => {
    const t = ops();
    t.routes[1] = { ...t.routes[1], labels: { issue: ['encoder', 'network'] } };
    expect(seatCard(t, 'triage').split('\n')).toEqual([
      'Your seat: Triage.',
      'You may message: analysts (handoffs; only when Issue is encoder or network; must include summary, cause), and the user (anything).',
      'A group takes work by its name (to: ["analysts"]): its free members are offered it, and the first to claim it owns it.',
      'Reaches you: monitors (reports); analysts (anything).',
      'Label with a first line like [labels: issue=encoder]: issue is one of encoder, network, other.',
      'Messages outside these are refused, saying who you may message instead.',
    ]);
  });
  it('a sender on two routes alike (one with labels) reaches you once in the card', () => {
    const t = ops();
    t.routes.push({ id: 'r4', from: ['group:monitors'], to: 'seat:triage', kinds: ['report'], wake: 'ask', labels: { issue: ['network'] } });
    expect(seatCard(t, 'triage').split('\n')[3]).toBe('Reaches you: monitors (reports); analysts (anything).');
  });
  it('no routes: just the user', () => {
    const t = ops();
    t.routes = [];
    expect(seatCard(t, 'mail').split('\n')[1]).toBe('You may message: the user (anything).');
  });
});

describe('diffTeam', () => {
  const clone = (t: Team): Team => JSON.parse(JSON.stringify(t));
  it('no change: nothing (the version alone is no change; key order and empty lists neither)', () => {
    const t = ops();
    expect(diffTeam(t, clone(t))).toEqual([]);
    const u = clone(t);
    u.version = 9;
    u.seats[0].agent = { tools: [] };
    u.seats[0].startup = { watches: [] };
    expect(diffTeam(t, u)).toEqual([]);
  });
  it('an empty (or blank) startup prompt is no prompt: no restart for it', () => {
    const t = ops();
    const u = clone(t);
    u.seats[0].startup = { prompt: '' };
    u.seats[1].startup = { prompt: '  ' };
    expect(diffTeam(t, u)).toEqual([]);
    u.seats[0].startup = { prompt: 'Check the alerts.' };
    expect(diffTeam(t, u)).toEqual([{ kind: 'seat-restart-needed', seat: t.seats[0].id, detail: 'startup prompt changed' }]);
  });
  it('seats added and removed, by id', () => {
    const t = ops();
    const u = clone(t);
    u.seats = u.seats.filter((s) => s.id !== 'slack');
    u.groups[0].members = ['mail', 'infra'];
    u.seats.push(seat('pager', 'Pager'));
    expect(diffTeam(t, u)).toEqual([
      { kind: 'seat-removed', seat: 'slack' },
      { kind: 'seat-added', seat: 'pager' },
      { kind: 'routes-changed', detail: 'groups changed' },
    ]);
  });
  it('a first team: every seat added, and its routes', () => {
    const t = ops();
    const d = diffTeam(undefined, t);
    expect(d.filter((c) => c.kind === 'seat-added').map((c) => c.seat)).toEqual(t.seats.map((s) => s.id));
    expect(d.at(-1)).toMatchObject({ kind: 'routes-changed' });
  });
  it('retasked, restart needed, pool resized, watches changed: per seat in team order', () => {
    const t = ops();
    const u = clone(t);
    u.seats[4].count = { min: 2, max: 4 };
    u.seats[4].instructions = 'Analyse harder.';
    u.seats[0].agent = { model: 'opus' };
    u.seats[0].skills = ['triage-kit'];
    u.seats[0].startup = { watches: [{ kind: 'gmail', from: 'a@b.c', about: 'alerts', then: 'look' }] };
    u.seats[3].folder = { path: 'C:/elsewhere' };
    expect(diffTeam(t, u)).toEqual([
      { kind: 'seat-restart-needed', seat: 'mail', detail: 'model, skills changed' },
      { kind: 'watches-changed', seat: 'mail' },
      { kind: 'seat-restart-needed', seat: 'triage', detail: 'folder changed' },
      { kind: 'seat-retasked', seat: 'analyst', detail: 'instructions changed' },
      { kind: 'pool-resized', seat: 'analyst', detail: 'min 1→2, max 3→4' },
    ]);
  });
  it('a pool resized names only what changed; permissions and tools need a restart', () => {
    const t = ops();
    const u = clone(t);
    u.seats[4].count = { min: 1, max: 5 };
    u.seats[5].agent = { permissions: { allow: ['Bash(git:*)'] }, disallowedTools: ['Write'], permissionMode: 'plan', effort: 'high', tools: ['Read'] };
    expect(diffTeam(t, u)).toEqual([
      { kind: 'pool-resized', seat: 'analyst', detail: 'max 3→5' },
      { kind: 'seat-restart-needed', seat: 'encoder-analyst', detail: 'tools, disallowedTools, effort, permissionMode, permissions changed' },
    ]);
  });
  it('a startup prompt or monitor changed: a restart (taken only when a member starts)', () => {
    const t = ops();
    const u = clone(t);
    u.seats[0].startup = { prompt: 'Check the inbox first.' };
    u.seats[1].startup = { monitor: 'tail -f alerts.log' };
    expect(diffTeam(t, u)).toEqual([
      { kind: 'seat-restart-needed', seat: 'mail', detail: 'startup prompt changed' },
      { kind: 'seat-restart-needed', seat: 'slack', detail: 'startup monitor changed' },
    ]);
  });
  it('sameTeam: any real change counts (a name, limits), the version and empty lists do not', () => {
    const t = ops();
    const u = clone(t);
    u.version = 7;
    u.seats[0].agent = { tools: [] };
    expect(sameTeam(t, u)).toBe(true);
    u.seats[0].name = 'Email';
    expect(diffTeam(t, u)).toEqual([]);
    expect(sameTeam(t, u)).toBe(false);
    const v = clone(t);
    v.seats[0].limits = { turnsPerHour: 5 };
    expect(sameTeam(t, v)).toBe(false);
    expect(sameTeam(undefined, t)).toBe(false);
  });
  it('routes, labels, fallback, escalation and team skills: routes-changed, last, with no seat', () => {
    const t = ops();
    const u = clone(t);
    u.routes[0].wake = 'ask';
    u.labels[0].values.push('power');
    u.fallback = 'seat:triage';
    u.escalation = [{ when: 'unclaimed', then: ['tell-user'] }];
    u.skills = [{ name: 'runbook', description: 'x', body: 'y' }];
    u.seats[1].instructions = 'Watch Slack.';
    expect(diffTeam(t, u)).toEqual([
      { kind: 'seat-retasked', seat: 'slack', detail: 'instructions changed' },
      { kind: 'routes-changed', detail: 'routes, labels, fallback, escalation, team skills changed' },
    ]);
  });
});

describe('validateTeam: the whole shape', () => {
  const bad = (f: (t: any) => void) => {
    const t: any = ops();
    f(t);
    const r = validateTeam(t);
    return r.ok ? [] : r.problems;
  };
  it("a seat's name, instructions, agent, skills, folder, startup and limits", () => {
    expect(bad((t) => delete t.seats[0].name)).toEqual(['Seat "mail" needs a name.']);
    expect(bad((t) => (t.seats[0].instructions = 3))).toEqual(['Seat "mail" needs instructions (text).']);
    expect(bad((t) => delete t.seats[0].agent)).toEqual(['Seat "mail" needs an "agent" object (it may be empty).']);
    expect(bad((t) => (t.seats[0].agent = { tools: 'Read', permissions: { allow: [1] } }))).toEqual(['Seat "mail": agent.tools must be a list of tool names.', 'Seat "mail": agent.permissions.allow must be a list of rules.']);
    expect(bad((t) => (t.seats[0].agent = { permissionMode: 'yolo' }))).toEqual(['Seat "mail": agent.permissionMode must be one of default, acceptEdits, auto, dontAsk, plan, manual, bypassPermissions.']);
    expect(bad((t) => (t.seats[0].agent = { permissionMode: 'acceptEdits' }))).toEqual([]);
    expect(bad((t) => (t.seats[0].skills = ['a', 2]))).toEqual(['Seat "mail": "skills" must be a list of skill names.']);
    expect(bad((t) => (t.seats[0].folder = { path: '  ' }))).toEqual(['Seat "mail" needs folder.path (the folder it works in).']);
    expect(bad((t) => (t.escalation = [{ when: 'unclaimed', then: ['reoffer'], scope: { route: 'nope' } }]))).toEqual(['Escalation rule 1 is scoped to an unknown route "nope".']);
    // a full path only (the runtime never makes, nor runs in, one relative to Cora's own folder)
    for (const path of ['ops', '~/ops', './ops', 'ops\\x'])
      expect(bad((t) => (t.seats[0].folder = { path }))).toEqual([`Seat "mail": folder.path must be a full path (like C:\\work\\ops), not "${path}".`]);
    for (const path of ['C:\\work', 'c:/work', '/home/me/ops', '\\\\server\\share']) expect(bad((t) => (t.seats[0].folder = { path }))).toEqual([]);
    expect(bad((t) => (t.seats[0].count = { min: 0.5, max: 2 }))).toEqual(['Seat "mail" needs count.min and count.max whole numbers.']);
    expect(bad((t) => delete t.seats[0].startup)).toEqual(['Seat "mail" needs a "startup" object (it may be empty).']);
    expect(bad((t) => (t.seats[0].startup = { prompt: 1, watches: [{ kind: 'gmail', from: '' }, { kind: 'slack' }, { kind: 'fax' }] }))).toEqual([
      'Seat "mail": startup.prompt must be text.',
      'Seat "mail"\'s watch 1 needs "from" (the sender it waits for).',
      'Seat "mail"\'s watch 2 needs a "channel".',
      'Seat "mail"\'s watch 3: kind must be gmail or slack.',
    ]);
    expect(bad((t) => (t.seats[0].limits = { turnsPerHour: 'lots', quiet: { from: '22:00', to: '7am' } }))).toEqual(['Seat "mail": limits.turnsPerHour must be a number.', 'Seat "mail": limits.quiet needs from and to as HH:MM.']);
    expect(bad((t) => (t.seats[0].limits = { turnsPerHour: 10, costPerDay: 2.5, quiet: { from: '22:00', to: '06:30' } }))).toEqual([]);
  });
  it("a group's name, a route's from, the escalation rules and team skills", () => {
    expect(bad((t) => delete t.groups[0].name)).toEqual(['Group "monitors" needs a name.']);
    expect(bad((t) => (t.routes[0].from = []))).toEqual(['Route "r1" needs at least one "from".']);
    expect(bad((t) => (t.escalation = [{ when: 'later', then: ['shout'], after: -1 }, { when: 'stale', then: [] }, 'x']))).toEqual([
      'Escalation rule 1: "when" must be one of unclaimed, critical, stale, blocked.',
      'Escalation rule 1 has an unknown step "shout" (one of reoffer, nudge-owner, tell-lead, tell-user, dm-user).',
      'Escalation rule 1: "after" must be a number of minutes above 0.',
      'Escalation rule 2: "then" must be a list of steps.',
      'Escalation rule 3 is not an object.',
    ]);
    expect(bad((t) => (t.escalation = [{ when: 'unclaimed', after: 10, then: ['reoffer', 'tell-user'], scope: { group: 'enc' } }]))).toEqual([]);
    expect(bad((t) => (t.skills = [{ name: 'x' }]))).toEqual(['Team skill 1 needs a name, a description and a body.']);
  });
});

describe('teamChangeLines', () => {
  it('a new seat: where it works, its permissions (marked), tools, model, watches and skills', () => {
    const next = ops();
    next.seats.push({
      ...seat('pager', 'Pager'),
      folder: { path: 'C:/ops', worktree: true },
      agent: { permissionMode: 'acceptEdits', permissions: { allow: ['Bash(git:*)'], deny: ['Bash(rm:*)'] }, tools: ['Read', 'Bash'], model: 'sonnet' },
      skills: ['paging'],
      startup: { watches: [{ kind: 'gmail', from: 'alerts@x.com', about: 'alerts', then: 'Page the on-call engineer.' }] },
    });
    expect(teamChangeLines(ops(), next)).toEqual([
      'New seat: Pager (1)',
      'Pager instructions: none',
      '⚠ Pager works in C:/ops (in its own worktree)',
      '⚠ Pager permission mode: acceptEdits',
      '⚠ Pager permissions: allow Bash(git:*); deny Bash(rm:*)',
      'Pager tools: Read, Bash',
      'Pager model: sonnet',
      'Pager watches email from alerts@x.com, then: "Page the on-call engineer."',
      'Pager skills: paging',
    ]);
  });
  it('a changed seat: each field as before → after; removed seats; team skills; routes, groups, fallback, escalation', () => {
    const prev = ops();
    prev.skills = [{ name: 'triage', description: 'd', body: 'Old steps.' }];
    const next = ops();
    const mail = next.seats.find((s) => s.id === 'mail')!;
    mail.agent = { permissionMode: 'bypassPermissions', permissions: { allow: ['Bash'] } };
    mail.folder = { path: 'C:/elsewhere' };
    mail.instructions = 'Watch the inbox.';
    mail.count = { min: 1, max: 2 };
    next.seats = next.seats.filter((s) => s.id !== 'slack');
    next.groups[0].members = ['mail', 'infra'];
    next.skills = [{ name: 'triage', description: 'd', body: '\nNew steps.\nMore.' }, { name: 'paging', description: 'How to page', body: 'Call them.' }];
    next.routes[0] = { ...next.routes[0], wake: 'ask' };
    next.fallback = 'seat:triage';
    next.escalation = [{ when: 'unclaimed', after: 10, then: ['tell-user'] }];
    expect(teamChangeLines(prev, next)).toEqual([
      'Mail instructions: none → "Watch the inbox."',
      '⚠ Mail folder: C:/work → C:/elsewhere',
      '⚠ Mail permission mode: yours (the mode your sessions start in) → bypassPermissions',
      '⚠ Mail permissions: none → allow Bash',
      'Mail count: 1 → 1 to 2',
      'Seat removed: Slack',
      'Team skill changed: triage: New steps.',
      'Team skill added: paging: Call them.',
      'Route changed: monitors → Triage (reports; wake auto) → monitors → Triage (reports; wake ask)',
      'Group changed: monitors: Mail, Slack, Infra, sender picks → monitors: Mail, Infra, sender picks',
      'Fallback: the user → Triage',
      'Escalation: none → unclaimed after 10 min: tell-user',
    ]);
    expect(teamChangeLines(prev, { ...prev, version: 9 })).toEqual([]);
  });
});

describe('teamChangeDetails', () => {
  it('a cut line carries the whole of it: instructions, startup prompts, team skills (short ones need nothing more)', () => {
    const long = `Watch the encoders.\n${'Check each feed in turn and write down what you see. '.repeat(4)}\nNever restart one yourself.`;
    const prev = ops();
    const next = ops();
    next.seats.push({ ...seat('pager', 'Pager'), instructions: 'Page people.', startup: { prompt: long } });
    next.seats[0] = { ...next.seats[0], instructions: long };
    next.skills = [{ name: 'paging', description: 'How to page', body: 'Call them.\nThen text them.' }];
    const d = teamChangeDetails(prev, next);
    expect(d.map((x) => x.line)).toEqual(teamChangeLines(prev, next));
    const mail = d.find((x) => x.line.startsWith('Mail instructions'))!;
    expect(mail.line.length).toBeLessThan(120);
    expect(mail.full).toBe(`Mail instructions: none → "${long}"`);
    expect(d.find((x) => x.line.startsWith('Pager starts with'))!.full).toBe(`Pager starts with: "${long}"`);
    expect(d.find((x) => x.line.startsWith('Pager instructions'))).toEqual({ line: 'Pager instructions: "Page people."' });
    expect(d.find((x) => x.line.startsWith('Team skill added'))).toEqual({ line: 'Team skill added: paging: Call them.', full: 'Team skill added: paging: Call them.\nThen text them.' });
  });
});

describe('a long text changed: the part that differs (teamChangeLines)', () => {
  const BASE = 'Claim a piece of work the lead hands to Engineers and implement it in the repo. Follow the codebase conventions and write or update tests. When it is done, hand it to the Reviewer.';
  const LEAD = 'Anything for the lead (a problem, a blocker, a finding, a question) goes to it with project_post.';
  const edited = (before: string, after: string) => {
    const prev = ops();
    prev.seats[0] = { ...prev.seats[0], instructions: before };
    const next = clone(prev);
    next.seats[0] = { ...next.seats[0], instructions: after };
    return { lines: teamChangeLines(prev, next), details: teamChangeDetails(prev, next) };
  };

  it('an edit at the end: what was added, its common start trimmed', () => {
    const { lines, details } = edited(BASE, `${BASE} ${LEAD}`);
    expect(lines).toEqual([`Mail instructions: … added "${LEAD.slice(0, 79)}…"`]);
    // the full view still has both texts whole
    expect(details[0].full).toBe(`Mail instructions: "${BASE}" → "${BASE} ${LEAD}"`);
  });

  it('an edit in the middle: the words that changed, both ends trimmed', () => {
    const { lines } = edited(BASE, BASE.replace('write or update tests', 'always write tests first'));
    expect(lines).toEqual(['Mail instructions: … "write or update tests." → "always write tests first." …']);
    // a word taken out of the middle
    expect(edited(BASE, BASE.replace(' conventions', '')).lines).toEqual(['Mail instructions: … removed "conventions" …']);
    // changed inside a word: the whole word is said
    expect(edited(BASE, BASE.replace('implement', 'implemant')).lines).toEqual(['Mail instructions: … "implement" → "implemant" …']);
  });

  it('an edit at the start: no leading "…", the common end trimmed', () => {
    const { lines } = edited(BASE, `Take ${BASE.slice('Claim '.length)}`);
    expect(lines).toEqual(['Mail instructions: "Claim" → "Take" …']);
  });

  it('only its spacing or line breaks changed: said so (never "added none"), and the full line still has both texts', () => {
    const SPACING = ['Mail instructions: only its spacing or line breaks changed'];
    expect(edited(BASE, `${BASE}\n`).lines).toEqual(SPACING);
    expect(edited(BASE, BASE.replace('conventions', 'conventions ')).lines).toEqual(SPACING);
    expect(edited(BASE, BASE.replace('. ', '.\n\n')).lines).toEqual(SPACING);
    // short texts too ("X" → "X" said nothing)
    expect(edited('Be mail.', 'Be  mail.').lines).toEqual(SPACING);
    // (the full view trims each text's ends, as before; what's inside it keeps)
    const spaced = BASE.replace('conventions', 'conventions ');
    expect(edited(BASE, spaced).details[0].full).toBe(`Mail instructions: "${BASE}" → "${spaced}"`);
  });

  it('short texts, and a text added or cleared, read as before', () => {
    expect(edited('Be mail.', 'Be the mail seat.').lines).toEqual(['Mail instructions: "Be mail." → "Be the mail seat."']);
    expect(edited('', BASE).lines).toEqual([`Mail instructions: none → "${BASE.slice(0, 79)}…"`]);
    // startup prompts and monitors say their change the same way
    const prev = ops();
    prev.seats[0] = { ...prev.seats[0], startup: { prompt: BASE } };
    const next = clone(prev);
    next.seats[0] = { ...next.seats[0], startup: { prompt: `${BASE} ${LEAD}` } };
    expect(teamChangeLines(prev, next)).toEqual([`Mail startup prompt: … added "${LEAD.slice(0, 79)}…"`]);
  });
});

describe('validateTeam: names that would collide', () => {
  it("a seat called another's id and a number (its pool's copies are named so) is refused", () => {
    const t = ops();
    t.seats.push(seat('analyst-2', 'Second analyst'));
    const r = validateTeam(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toEqual(['The seat id "analyst-2" could be mistaken for a copy of seat "analyst": name it differently.']);
    // a number on its own is fine; so is the same base without the other seat
    expect(validateTeam({ ...ops(), seats: [...ops().seats, seat('pager-2', 'Pager two')] }).ok).toBe(true);
  });
});

describe('proposalSkipsPrompts', () => {
  it('a seat that would start skipping permission prompts (new, or moved to that mode); one already so is not new', () => {
    const t = ops();
    const bypass = (x: Team, id: string) => ({ ...x, seats: x.seats.map((s) => (s.id === id ? { ...s, agent: { ...s.agent, permissionMode: 'bypassPermissions' } } : s)) });
    expect(proposalSkipsPrompts(t, t)).toBe(false);
    expect(proposalSkipsPrompts(t, bypass(t, 'mail'))).toBe(true);
    expect(proposalSkipsPrompts(t, { ...t, seats: [...t.seats, { ...seat('x', 'X'), agent: { permissionMode: 'bypassPermissions' } }] })).toBe(true);
    expect(proposalSkipsPrompts(bypass(t, 'mail'), { ...bypass(t, 'mail'), fallback: 'seat:triage' })).toBe(false);
  });
});

describe('a lead chosen in the team', () => {
  const clone = (t: Team): Team => JSON.parse(JSON.stringify(t));
  it('names a seat in the team (else a clear problem)', () => {
    expect(validateTeam({ ...ops(), lead: 'triage' }).ok).toBe(true);
    const r = validateTeam({ ...ops(), lead: 'ghost' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toEqual(['The lead "ghost" is not a seat in the team.']);
    const n = validateTeam({ ...ops(), lead: 5 });
    expect(n.ok).toBe(false);
    if (!n.ok) expect(n.problems).toEqual(['"lead" must be a seat id.']);
  });
  it('a change line by the seats\' names (none when there is none)', () => {
    const t = ops();
    expect(teamChangeLines(t, { ...t, lead: 'triage' })).toEqual(['Lead: none → Triage']);
    expect(teamChangeLines({ ...t, lead: 'triage' }, { ...t, lead: 'mail' })).toEqual(['Lead: Triage → Mail']);
    expect(teamChangeLines({ ...t, lead: 'triage' }, t)).toEqual(['Lead: Triage → none']);
  });
  it('changing it restarts nobody: it is taken at once, with the routes', () => {
    const t = ops();
    const u = { ...clone(t), lead: 'triage' };
    expect(diffTeam(t, u)).toEqual([{ kind: 'routes-changed', detail: 'lead changed' }]);
  });
  it("a seat's card never says it leads (every copy of the lead seat would read it): the project card of the actual lead does", () => {
    const t = { ...ops(), lead: 'triage' };
    expect(seatCard(t, 'triage')).not.toMatch(/lead this team/);
  });
});
