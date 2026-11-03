import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateTeam, type Team } from '@cora/shared';
import { Projects } from '../src/projects';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-teams-store-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const team = (name = 'Triage') => ({
  version: 0,
  seats: [{ id: 'triage', name, instructions: 'Triage alerts.', agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 1, max: 1 }, startup: {} }],
  groups: [],
  labels: [],
  routes: [],
  fallback: 'user',
  escalation: [],
});

describe('teams on projects', () => {
  it('the fixture is a valid team', () => {
    expect(validateTeam(team()).ok).toBe(true);
  });

  it('validates: problems come back and nothing is stored', () => {
    const p = new Projects(null, () => 1);
    const a = p.create('A');
    const r = p.setTeam(a.id, { seats: 'no' }, 'you');
    expect(r).toMatchObject({ ok: false, error: 'The team has problems.' });
    expect((r as { problems?: string[] }).problems!.length).toBeGreaterThan(0);
    expect(p.get(a.id)!.team).toBeUndefined();
  });

  it('stores with version previous + 1, bumps briefAt, refuses a stale expectVersion', () => {
    let t = 1000;
    const p = new Projects(null, () => t);
    const a = p.create('A');
    t = 2000;
    const r1 = p.setTeam(a.id, { ...team(), version: 99 }, 'you', 0);
    expect(r1).toMatchObject({ ok: true, team: { version: 1 } });
    expect(p.get(a.id)!.briefAt).toBe(2000);
    t = 3000;
    const r2 = p.setTeam(a.id, team('Triage 2'), 'you', 1);
    expect(r2).toMatchObject({ ok: true, team: { version: 2 }, previous: { version: 1 } });
    expect(p.setTeam(a.id, team(), 'you', 1)).toEqual({ ok: false, error: 'Changed since you opened it: version 2' });
    expect(p.get(a.id)!.team!.version).toBe(2);
    expect(p.get(a.id)!.teamHistory).toEqual([{ version: 1, at: 3000, by: 'you', team: expect.objectContaining({ version: 1 }) }]);
  });

  it('a history entry is its own copy: changing the team it was (as returned) leaves the history as it was', () => {
    const p = new Projects(null, () => 1);
    const a = p.create('A');
    p.setTeam(a.id, team('First'), 'you');
    const r = p.setTeam(a.id, team('Second'), 'you') as { ok: true; previous: { seats: Array<{ name: string }> } };
    r.previous.seats[0].name = 'Changed';
    expect(p.get(a.id)!.teamHistory![0].team.seats[0].name).toBe('First');
  });

  it('keeps the newest 50 versions; rollback re-applies an old one as a new version', () => {
    const p = new Projects(null, () => 1);
    const a = p.create('A');
    for (let i = 0; i < 55; i++) p.setTeam(a.id, team(`Name ${i}`), 'you');
    const pr = p.get(a.id)!;
    expect(pr.team!.version).toBe(55);
    expect(pr.teamHistory).toHaveLength(50);
    expect(pr.teamHistory![0].version).toBe(5);
    const r = p.rollbackTeam(a.id, 10, 'you');
    expect(r).toMatchObject({ ok: true, team: { version: 56 } });
    expect(p.get(a.id)!.team!.seats[0].name).toBe('Name 9');
    expect(p.rollbackTeam(a.id, 1, 'you')).toEqual({ ok: false, error: 'No version 1.' });
    expect(p.rollbackTeam(a.id, 56, 'you')).toMatchObject({ ok: true, team: { version: 57 } });
  });

  it('setSeat sets and clears a member seat; only members', () => {
    const p = new Projects(null, () => 1);
    const a = p.create('A');
    p.add(a.id, 's1');
    expect(p.setSeat(a.id, 's1', 'triage', 2)).toBe(true);
    expect(p.get(a.id)!.members.s1).toMatchObject({ seat: 'triage', instance: 2 });
    expect(p.setSeat(a.id, 's1', null)).toBe(true);
    expect(p.get(a.id)!.members.s1.seat).toBeUndefined();
    expect(p.get(a.id)!.members.s1.instance).toBeUndefined();
    expect(p.setSeat(a.id, 'nope', 'triage')).toBe(false);
    expect(p.setSeat('nope', 's1', 'triage')).toBe(false);
  });

  it('round-trips through the file', () => {
    const file = join(dir, 'projects.json');
    const p = new Projects(file, () => 5);
    const a = p.create('A');
    p.add(a.id, 's1');
    p.setTeam(a.id, team(), 'you');
    p.setTeam(a.id, team('Two'), 'you');
    p.setSeat(a.id, 's1', 'triage', 1);
    const q = new Projects(file, () => 6).get(a.id)!;
    expect(q.team).toMatchObject({ version: 2 });
    expect(q.teamHistory).toHaveLength(1);
    expect(q.members.s1).toMatchObject({ seat: 'triage', instance: 1 });
  });
});

describe('a proposal kept from before the team changed', () => {
  it('one made on an older version than the team now is set aside when the projects are read (it could only read as a revert)', () => {
    const file = join(dir, 'projects.json');
    const a = new Projects(file);
    const p = a.create('Ops');
    a.setTeam(p.id, team(), 'you');
    a.setTeam(p.id, team('Triage desk'), 'you');
    const q = a.create('Other');
    a.setTeam(q.id, team(), 'you');
    // as an older Cora left them: one proposal on version 1 of a team now at 2, one on the version there
    a.setTeamProposal(p.id, { team: { ...team('Hub'), version: 1 } as Team, why: 'x', by: 's1', at: 5, base: 1 });
    a.setTeamProposal(q.id, { team: { ...team('Hub'), version: 1 } as Team, why: 'y', by: 's2', at: 6, base: 1 });
    const b = new Projects(file);
    expect(b.get(p.id)!.teamProposal).toBeUndefined();
    expect(b.get(q.id)!.teamProposal).toMatchObject({ why: 'y' });
  });
});
