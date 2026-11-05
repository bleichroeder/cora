import { describe, expect, it } from 'vitest';
import { applyOverview, changeCount, teamChangeDetails, clone, diffTeam, newSeat, rebaseTeam, sameTeam, sessionEffects, teamChangeLines, type Team } from '../src/index';
import { drill, drillDraft, drillProposal, drillTheirs } from './fixtures';

describe('rebaseTeam: your draft on top of their newer version', () => {
  it("theirs where you didn't touch it; yours, listed, where you both did", () => {
    const r = rebaseTeam(drill(), drillTheirs(), drillDraft());
    expect(r.team.version).toBe(5);
    expect(r.team.seats.find((s) => s.id === 'analyst-net')!.limits).toEqual({ turnsPerHour: 20 });
    expect(r.team.routes.find((x) => x.id === 'r-back')!.wake).toBe('ask');
    expect(r.conflicts).toEqual(['Route Analysts → Triage, wake: they set never, your draft has ask. Yours is kept.']);
  });

  it('clean when you changed different things', () => {
    const mine = clone(drill());
    mine.seats[0].instructions = 'Mine.';
    const r = rebaseTeam(drill(), drillTheirs(), mine);
    expect(r.conflicts).toEqual([]);
    expect(r.team.seats[0].instructions).toBe('Mine.');
    expect(r.team.routes.find((x) => x.id === 'r-back')!.wake).toBe('never');
  });

  it("undoing a turn: its change taken back off the draft as it is now (your later edits stay)", () => {
    const before = drill();
    const after = clone(before);
    after.seats.push(newSeat('monitor-c', 'Monitor C', 'C:/w'));
    const now = clone(after);
    now.seats[2].instructions = 'Edited by you after.';
    const r = rebaseTeam(after, before, now);
    expect(r.team.seats.map((s) => s.id)).not.toContain('monitor-c');
    expect(r.team.seats[2].instructions).toBe('Edited by you after.');
    expect(r.conflicts).toEqual([]);
  });

  it('they removed something you changed: yours is kept, and said', () => {
    const theirs = clone(drill());
    theirs.version = 5;
    theirs.seats = theirs.seats.filter((s) => s.id !== 'triage');
    theirs.routes = [];
    const r = rebaseTeam(drill(), theirs, drillDraft());
    expect(r.conflicts).toContain('Seat Triage: they removed it, your draft changes it. Kept.');
  });
});

describe('what Apply does to running sessions', () => {
  it('the drill draft: Triage is told, the encoder analyst restarts and its pool grows, routes and groups at once', () => {
    expect(sessionEffects(drill(), drillDraft())).toEqual({
      rows: [
        { seat: 'triage', name: 'Triage', kind: 'tell', text: 'is told its new instructions now; its full prompt updates at its next restart' },
        { seat: 'analyst-enc', name: 'Encoder analyst', kind: 'restart', text: 'waits for your Restart (Team panel) to take its new permissions (Claude Code reads them at start)' },
        { seat: 'analyst-enc', name: 'Encoder analyst', kind: 'now', text: 'pool 1 → 1 to 2, at once' },
      ],
      atOnce: ['routes', 'groups'],
    });
  });

  it("seats standing down: said plainly before Apply (what they run ends with them); one only renamed keeps its sessions, said in its row", () => {
    const seat = (id: string, name: string, instructions = `Be ${id}.`) => ({ ...drill().seats[0], id, name, instructions });
    const v1 = { ...drill(), seats: [seat('senior-system-analyst', 'Senior System Analyst'), seat('triage', 'Triage')] };
    // the test PC's v2: the analyst's id changed (its name kept), a monitor added, Triage kept
    const v2 = { ...v1, seats: [seat('analyst-01', 'Senior System Analyst'), seat('triage', 'Triage'), seat('infra-monitor', 'Infrastructure Monitor')] };
    // renamed (its name kept): nothing stands down; its row says its sessions are kept
    const e2 = sessionEffects(v1, v2);
    expect(e2.ending).toBeUndefined();
    expect(e2.rows).toContainEqual({ seat: 'analyst-01', name: 'Senior System Analyst', kind: 'keep', text: 'renamed from senior-system-analyst: its sessions keep running as Senior System Analyst (and what they run and know), each told its new seat' });
    expect(e2.rows.filter((r) => r.kind === 'stop')).toEqual([]);
    // (its instructions name its id, so they changed too: it's told them, as any seat is)
    expect(e2.rows.map((r) => [r.seat, r.kind])).toEqual([['analyst-01', 'keep'], ['infra-monitor', 'start'], ['analyst-01', 'tell']]);
    // the same instructions under another name and id: renamed too (and its new name isn't a change to tell)
    const v3 = { ...v1, seats: [seat('analyst-01', 'Analyst 01', 'Be senior-system-analyst.'), seat('triage', 'Triage')] };
    expect(sessionEffects(v1, v3).rows).toEqual([expect.objectContaining({ seat: 'analyst-01', kind: 'keep', text: expect.stringMatching(/^renamed from senior-system-analyst: its sessions keep running as Analyst 01/) })]);
    expect(sessionEffects(v1, v3).ending).toBeUndefined();
    // a seat simply removed: said, nothing about a rename
    const v4 = { ...v1, seats: [seat('triage', 'Triage')] };
    expect(sessionEffects(v1, v4).ending).toBe('Senior System Analyst stands down: its sessions end, and with them anything they run (a /loop, a cron, a Monitor) and what they know.');
    // nothing stands down: nothing said
    expect(sessionEffects(v1, v1).ending).toBeUndefined();
  });

  it("a proposal: a seat that starts when work arrives, one that stands down", () => {
    const e = sessionEffects(drill(), drillProposal());
    expect(e.rows).toContainEqual({ seat: 'analyst-ing', name: 'Ingest analyst', kind: 'start', text: 'starts when work first arrives (its minimum is 0)' });
    expect(e.rows).toContainEqual({ seat: 'monitor-b', name: 'Monitor B', kind: 'stop', text: 'stands down: its sessions end (now, or once idle)' });
  });

  it('restarts match the runtime: startup prompt and monitor restart; watches and team skills do not', () => {
    const t = clone(drill());
    t.seats[0].startup = { ...(t.seats[0].startup ?? {}), prompt: 'Start by reading the board.' };
    const e = sessionEffects(drill(), t);
    expect(e.rows).toContainEqual({ seat: t.seats[0].id, name: t.seats[0].name, kind: 'restart', text: 'waits for your Restart (Team panel) to take its new startup prompt (Claude Code reads them at start)' });
    const u = clone(drill());
    u.skills = [{ name: 'x', description: 'd', body: 'b' }];
    const f = sessionEffects(drill(), u);
    expect(f.rows).toEqual([]);
    expect(f.atOnce).toEqual(['team skills']);
  });

  it('changes are counted by thing, not by line', () => {
    expect(changeCount(drill(), drillDraft())).toBe(4);
    expect(changeCount(undefined, drill())).toBe(5 + 3 + 3 + 3);
  });

  it('a skills-only edit counts as a change', () => {
    const u = clone(drill());
    u.skills = [{ name: 'x', description: 'd', body: 'b' }];
    expect(changeCount(drill(), u)).toBe(1);
  });

  it('a new team does not list its fallback as changed at once', () => {
    expect(sessionEffects(undefined, drill()).atOnce).not.toContain('fallback');
  });

  it('both adding the same id differently is a conflict', () => {
    const base = drill();
    const theirs = clone(base);
    theirs.seats.push(newSeat('new-x', 'New X', 'C:/a'));
    const mine = clone(base);
    mine.seats.push(newSeat('new-x', 'New X', 'C:/b'));
    expect(rebaseTeam(base, theirs, mine).conflicts).toEqual(['Seat New X: you both added it, differently. Yours is kept.']);
  });

  it('a restart row appears exactly when diffTeam says the seat needs a restart', () => {
    const edits: Array<[string, (s: Team['seats'][number]) => void]> = [
      ['tools', (s) => { s.agent.tools = ['Zed']; }],
      ['disallowedTools', (s) => { s.agent.disallowedTools = ['Zed']; }],
      ['model', (s) => { s.agent.model = 'zed'; }],
      ['effort', (s) => { s.agent.effort = 'max'; }],
      ['permissionMode', (s) => { s.agent.permissionMode = 'plan'; }],
      ['permissions', (s) => { s.agent.permissions = { allow: ['Zed'] }; }],
      ['skills', (s) => { s.skills = ['zed']; }],
      ['folder', (s) => { s.folder = { path: 'C:/zed' }; }],
      ['startup.prompt', (s) => { s.startup = { ...s.startup, prompt: 'zed' }; }],
      ['startup.monitor', (s) => { s.startup = { ...s.startup, monitor: 'zed' }; }],
      ['startup.watches', (s) => { s.startup = { ...s.startup, watches: [{ kind: 'slack', channel: '#zed', about: 'a', then: 'b' }] }; }],
      ['count', (s) => { s.count = { min: 0, max: 9 }; }],
      ['limits', (s) => { s.limits = { turnsPerHour: 99 }; }],
    ];
    for (const [name, edit] of edits) {
      const t = clone(drill());
      edit(t.seats[0]);
      const needs = diffTeam(drill(), t).some((c) => c.kind === 'seat-restart-needed' && c.seat === t.seats[0].id);
      const has = sessionEffects(drill(), t).rows.some((r) => r.kind === 'restart' && r.seat === t.seats[0].id);
      expect([name, has]).toEqual([name, needs]);
    }
  });
});

describe('applyOverview', () => {
  it('a first apply: the team in numbers, one folder said once, one row per seat with its lines, the routes kept apart', () => {
    const t = drill();
    const o = applyOverview(undefined, t);
    expect(o.first).toBe(true);
    expect(o.counts).toMatchObject({ seats: t.seats.length, routes: t.routes.length, groups: t.groups.length });
    expect(o.delta).toMatchObject({ added: t.seats.length, changed: 0, removed: 0 });
    expect(o.seats.map((s) => s.status)).toEqual(t.seats.map(() => 'new'));
    // every line is in exactly one place: a seat's, or the rest
    const all = [...o.seats.flatMap((s) => s.lines), ...o.rest].length;
    expect(all).toBe(teamChangeDetails(undefined, t).filter((d) => !d.line.startsWith('New seat: ')).length);
    expect(o.rest.every((l) => /^(Route|Group|Labels|Fallback|Escalation|Team skill)/.test(l.line))).toBe(true);
    // nothing in check keeps its warning sign
    expect(o.check.every((c) => !c.line.startsWith('⚠'))).toBe(true);
  });
  it("seats sharing one folder are said once; a seat's facts read as one line", () => {
    const t = drill();
    const same = { ...t, seats: t.seats.map((s) => ({ ...s, folder: { path: 'C:/work/x' } })) };
    const o = applyOverview(undefined, same);
    expect(o.check.filter((c) => c.line.includes('C:/work/x'))).toEqual([{ line: 'Every seat works in C:/work/x' }]);
    expect(o.seats[0].facts.length).toBeGreaterThan(0);
  });
  it('an edit: only what changed is new or changed; a removed seat shows; a seat named like the start of another keeps its own lines', () => {
    const before = drill();
    const after = clone(before);
    after.seats[0] = { ...after.seats[0], instructions: 'Something new.' };
    after.seats.push(newSeat('tri2', `${before.seats[0].name} two`, 'C:/work'));
    const gone = after.seats.splice(1, 1)[0];
    const o = applyOverview(before, after);
    expect(o.first).toBe(false);
    expect(o.seats.find((s) => s.id === before.seats[0].id)).toMatchObject({ status: 'changed' });
    expect(o.seats.find((s) => s.id === before.seats[0].id)!.lines.every((l) => !l.line.includes(' two'))).toBe(true);
    expect(o.seats.find((s) => s.id === 'tri2')).toMatchObject({ status: 'new' });
    expect(o.seats.find((s) => s.id === gone.id)).toMatchObject({ status: 'removed' });
    expect(o.delta).toMatchObject({ added: 1, changed: 1, removed: 1 });
    expect(o.seats.filter((s) => s.status === 'same').every((s) => !s.lines.length)).toBe(true);
  });
  it('lines go to their seat by its id: two seats of one name keep their own, and a seat named Route or Team takes nobody else\'s', () => {
    const before = drill();
    const after = clone(before);
    after.seats.push(newSeat('analyst', 'Analyst', 'C:/work', { instructions: 'Be A.' }), newSeat('analyst-x', 'Analyst', 'C:/work', { instructions: 'Be X.' }), newSeat('route', 'Route', 'C:/work'));
    after.routes.push({ id: 'r-new', from: ['seat:analyst'], to: 'user', kinds: 'any', wake: 'auto' });
    const o = applyOverview(before, after);
    const lines = (id: string) => o.seats.find((s) => s.id === id)!.lines.map((l) => l.line);
    expect(lines('analyst')).toContain('Analyst instructions: "Be A."');
    expect(lines('analyst')).not.toContain('Analyst instructions: "Be X."');
    expect(lines('analyst-x')).toContain('Analyst instructions: "Be X."');
    expect(o.seats.find((s) => s.id === 'route')!.lines.every((l) => !l.line.startsWith('Route added'))).toBe(true);
    expect(o.rest.some((l) => l.line.startsWith('Route added'))).toBe(true);
  });
});

describe('a lead chosen in the team, applied', () => {
  it('takes effect at once, restarting nobody; counted as one change; theirs taken when you left it alone', () => {
    const t = { ...drill(), lead: 'triage' };
    expect(sessionEffects(drill(), t)).toEqual({ rows: [], atOnce: ['lead'] });
    expect(changeCount(drill(), t)).toBe(1);
    // in Apply's sheet with the routes and rules, not as a seat's line
    expect(applyOverview(drill(), t).rest).toEqual([{ line: 'Lead: none → Triage' }]);
    const theirs = { ...drillTheirs(), lead: 'triage' };
    expect(rebaseTeam(drill(), theirs, drillDraft()).team.lead).toBe('triage');
  });
});

describe('one meaning of "the same" everywhere (the count, the change lines, what restarts)', () => {
  it("a mode written as 'default', a model or effort left empty, a null: the same as unset, to every part", () => {
    const t = drill();
    for (const edit of [
      (x: Team) => (x.seats[0].agent.permissionMode = 'default'),
      (x: Team) => (x.seats[0].agent.model = ''),
      (x: Team) => ((x.seats[0].agent as Record<string, unknown>).effort = null),
      (x: Team) => (x.seats[0].startup.monitor = ''),
    ]) {
      const u = clone(t);
      delete u.seats[0].agent.permissionMode;
      delete u.seats[0].agent.model;
      delete u.seats[0].agent.effort;
      delete u.seats[0].startup.monitor;
      const v = clone(u);
      edit(v);
      expect(changeCount(u, v)).toBe(0);
      expect(diffTeam(u, v)).toEqual([]);
      expect(teamChangeLines(u, v)).toEqual([]);
      expect(sameTeam(u, v)).toBe(true);
    }
  });
});

describe('seats only renamed', () => {
  it('pairs a seat gone with a new one of the same name or instructions, each once; the routes, groups and lead that named it follow', async () => {
    const { seatRenames, renamedBefore, diffTeam } = await import('../src/index');
    const t = drill();
    const next = clone(t);
    const s = next.seats.find((x) => x.id === 'triage')!;
    s.id = 'hub';
    for (const r of next.routes) (r.from = r.from.map((f) => (f === 'seat:triage' ? 'seat:hub' : f))), r.to === 'seat:triage' && (r.to = 'seat:hub');
    for (const g of next.groups) g.members = g.members.map((m) => (m === 'triage' ? 'hub' : m));
    if (next.fallback === 'seat:triage') next.fallback = 'seat:hub';
    if (next.lead === 'triage') next.lead = 'hub';
    const renames = seatRenames(t, next);
    expect(renames.map((r) => [r.from.id, r.to.id])).toEqual([['triage', 'hub']]);
    // diffed against the team before under its new id: nothing changed but the rename
    expect(diffTeam(renamedBefore(t, renames), next)).toEqual([]);
    // two new seats of the same name: paired once
    const two = clone(next);
    two.seats.push({ ...s, id: 'hub-2' });
    expect(seatRenames(t, two).map((r) => r.to.id)).toEqual(['hub']);
    // another name and other instructions: not a rename
    const other = clone(t);
    other.seats = other.seats.map((x) => (x.id === 'triage' ? { ...x, id: 'pager', name: 'Pager', instructions: 'Page people.' } : x));
    expect(seatRenames(t, other)).toEqual([]);
    expect(seatRenames(undefined, next)).toEqual([]);
  });
});
