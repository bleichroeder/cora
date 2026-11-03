import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clone, exampleTeam, newSeat, validateTeam } from '@cora/shared';
import { Projects } from '../src/projects';
import { drillDraft, drillTheirs } from '@cora/shared/test/fixtures';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-builder-store-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const make = () => {
  let now = 1000;
  const pr = new Projects(join(dir, 'projects.json'), () => now);
  const p = pr.create('Drill');
  expect(pr.setTeam(p.id, exampleTeam(), 'you').ok).toBe(true);
  const drafted: string[] = [];
  pr.onDraft = (pid) => drafted.push(pid);
  return { pr, pid: p.id, drafted, tick: () => (now += 1000) };
};
const withC = () => {
  const t = clone(exampleTeam());
  t.seats.push(newSeat('monitor-c', 'Monitor C', 'C:/w'));
  t.routes[0].from.push('seat:monitor-c');
  return t;
};

describe("a project's builder draft and layout", () => {
  it('a layout is kept beside the team: no version bump, no history', () => {
    const { pr, pid } = make();
    expect(pr.setTeamLayout(pid, { pos: { triage: { x: 10.4, y: 20 }, '@user': { x: 0, y: -100 }, bad: { x: 'a' } }, color: { triage: '#60A5FA', worse: 'red' } })).toBe(true);
    const p = pr.get(pid)!;
    expect(p.teamLayout).toEqual({ pos: { triage: { x: 10, y: 20 }, '@user': { x: 0, y: -100 } }, color: { triage: '#60a5fa' } });
    expect(p.team!.version).toBe(1);
    expect(p.teamHistory ?? []).toEqual([]);
    expect(pr.setTeamLayout(pid, { pos: 'x' })).toBe(false);
  });

  it("your edit: a revision on the team's version, the project's team untouched; a stale one refused", () => {
    const { pr, pid, drafted } = make();
    const t = clone(exampleTeam());
    t.seats[0].name = 'Monitor 1';
    const a = pr.setDraft(pid, t, 'you', { expect: 0 });
    expect(a).toMatchObject({ ok: true, draft: { rev: 1, base: 1, by: 'you', turns: [] } });
    expect(pr.get(pid)!.team!.seats[0].name).toBe('Monitor A');
    expect(pr.setDraft(pid, t, 'you', { expect: 0 })).toEqual({ ok: false, error: 'The draft changed since (revision 1).', rev: 1 });
    expect(drafted).toEqual([pid]);
  });

  it("Cora's change is a turn: what it did, and the team before and after", () => {
    const { pr, pid } = make();
    const r = pr.setDraft(pid, withC(), 'cora', { expect: 0 });
    if (!r.ok) throw new Error(r.error);
    expect(r.draft.turns).toHaveLength(1);
    expect(r.draft.turns[0].summary).toBe('added Monitor C · changed route Monitor A, Monitor B, Monitor C → Triage');
    expect(r.draft.turns[0].before.seats).toHaveLength(5);
    expect(r.draft.turns[0].after.seats).toHaveLength(6);
  });

  it('Undo of a turn restores the revision before it; your later edits stay', () => {
    const { pr, pid } = make();
    const c = pr.setDraft(pid, withC(), 'cora', { expect: 0 });
    if (!c.ok) throw new Error(c.error);
    const mine = clone(c.draft.team);
    mine.seats[2].instructions = 'Yours.';
    expect(pr.setDraft(pid, mine, 'you', { expect: 1 }).ok).toBe(true);
    const u = pr.undoTurns(pid, [c.draft.turns[0].id]);
    if (!u.ok) throw new Error(u.error);
    expect(u.draft.rev).toBe(3);
    expect(u.draft.team.seats.map((s) => s.id)).not.toContain('monitor-c');
    expect(u.draft.team.routes[0].from).toEqual(['seat:monitor-a', 'seat:monitor-b']);
    expect(u.draft.team.seats[2].instructions).toBe('Yours.');
    expect(u.draft.turns[0].undone).toBe(true);
    expect(pr.undoTurns(pid, [c.draft.turns[0].id])).toEqual({ ok: false, error: 'Nothing to undo there.' });
  });

  it("Undo of two of Cora's turns takes them back one by one: your edit made between them stays", () => {
    const { pr, pid } = make();
    const c = pr.setDraft(pid, withC(), 'cora', { expect: 0 });
    if (!c.ok) throw new Error(c.error);
    const mine = clone(c.draft.team);
    mine.seats[2].instructions = 'Yours.';
    expect(pr.setDraft(pid, mine, 'you', { expect: 1 }).ok).toBe(true);
    const hers = clone(mine);
    hers.seats[0].name = 'Monitor 1';
    const c2 = pr.setDraft(pid, hers, 'cora', { expect: 2 });
    if (!c2.ok) throw new Error(c2.error);
    const u = pr.undoTurns(pid, c2.draft.turns.map((t) => t.id));
    if (!u.ok) throw new Error(u.error);
    expect(u.draft.team.seats.map((s) => s.id)).not.toContain('monitor-c');
    expect(u.draft.team.seats[0].name).toBe('Monitor A');
    expect(u.draft.team.seats[2].instructions).toBe('Yours.');
  });

  it("a draft whose version is no longer kept can't be rebased: it says Discard draft starts again", () => {
    const { pr, pid } = make();
    expect(pr.setDraft(pid, withC(), 'you').ok).toBe(true);
    const theirs = clone(exampleTeam());
    theirs.seats[0].name = 'Monitor 1';
    expect(pr.setTeam(pid, theirs, 'cora').ok).toBe(true);
    pr.get(pid)!.teamHistory = [];
    expect(pr.rebaseDraft(pid, false)).toEqual({ ok: false, error: "Version 1 is no longer kept, so the draft can't be rebased: Discard draft (under Start over) starts again from version 2." });
  });

  it('the session: a draft made from the team when there is none, found by the session, cleared', () => {
    const { pr, pid } = make();
    expect(pr.setDraftSession(pid, 'sess-0001')).toBe(true);
    expect(pr.draft(pid)).toMatchObject({ rev: 0, base: 1, session: 'sess-0001', team: { seats: expect.any(Array) } });
    expect(pr.builderOf('sess-0001')).toBe(pid);
    pr.setDraftSession(pid, null);
    expect(pr.draft(pid)!.session).toBeUndefined();
    expect(pr.builderOf('sess-0001')).toBeNull();
  });

  it('discarded: gone, and said', () => {
    const { pr, pid, drafted } = make();
    pr.setDraft(pid, withC(), 'you');
    expect(pr.discardDraft(pid)!.rev).toBe(1);
    expect(pr.draft(pid)).toBeUndefined();
    expect(drafted).toEqual([pid, pid]);
  });

  it('rebased after a refused apply: their changes and the conflicts, then on their version', () => {
    const { pr, pid } = make();
    expect(pr.setDraft(pid, drillDraft(), 'you').ok).toBe(true);
    expect(pr.setTeam(pid, drillTheirs(), 'cora').ok).toBe(true);
    const dry = pr.rebaseDraft(pid, true);
    if (!dry.ok) throw new Error(dry.error);
    expect(dry.theirs).toHaveLength(2);
    expect(dry.conflicts).toEqual(['Route Analysts → Triage, wake: they set never, your draft has ask. Yours is kept.']);
    expect(pr.draft(pid)!.base).toBe(1);
    const real = pr.rebaseDraft(pid, false);
    if (!real.ok) throw new Error(real.error);
    expect(real.draft).toMatchObject({ base: 2, rev: 2, team: { version: 2 } });
    expect(pr.rebaseDraft(pid, false)).toEqual({ ok: false, error: 'The draft is already on version 2.' });
  });

  it('revisions only go up, across a discard; a stale client is refused with or without a draft', () => {
    const { pr, pid } = make();
    expect(pr.setDraft(pid, withC(), 'you').ok).toBe(true);
    expect(pr.setDraft(pid, withC(), 'you', { expect: 1 }).ok).toBe(true);
    pr.discardDraft(pid);
    expect(pr.setDraft(pid, withC(), 'you', { expect: 2 })).toMatchObject({ ok: false, rev: 2 });
    expect(pr.draft(pid)).toBeUndefined();
    const again = pr.setDraft(pid, withC(), 'you', { expect: 0 });
    expect(again).toMatchObject({ ok: true, draft: { rev: 3 } });
    pr.discardDraft(pid);
    pr.setDraftSession(pid, 'sess-0002');
    expect(pr.draft(pid)!.rev).toBe(3);
  });

  it("a base that isn't the team's version is stale", () => {
    const { pr, pid } = make();
    expect(pr.setDraft(pid, withC(), 'you', { base: 7 })).toEqual({ ok: false, error: 'The team is on version 1 now, not 7.' });
    expect(pr.draft(pid)).toBeUndefined();
    expect(pr.setDraft(pid, withC(), 'you', { base: 1 }).ok).toBe(true);
  });

  it('keeps only the last 40 turns of Cora', () => {
    const { pr, pid } = make();
    for (let i = 0; i < 45; i++) {
      const t = clone(exampleTeam());
      t.seats[0].name = `Monitor ${i}`;
      expect(pr.setDraft(pid, t, 'cora').ok).toBe(true);
    }
    expect(pr.draft(pid)!.turns).toHaveLength(40);
    expect(pr.draft(pid)!.rev).toBe(45);
  });

  it('an undo that would break the draft is refused, and nothing is written', () => {
    const { pr, pid, drafted } = make();
    const c = pr.setDraft(pid, withC(), 'cora');
    if (!c.ok) throw new Error(c.error);
    const mine = clone(c.draft.team);
    mine.routes[1].from.push('seat:monitor-c');
    expect(pr.setDraft(pid, mine, 'you', { expect: 1 }).ok).toBe(true);
    const n = drafted.length;
    const before = JSON.stringify(pr.draft(pid));
    expect(pr.undoTurns(pid, [c.draft.turns[0].id])).toMatchObject({ ok: false, error: expect.stringContaining('monitor-c') });
    expect(JSON.stringify(pr.draft(pid))).toBe(before);
    expect(drafted).toHaveLength(n);
  });

  it('an unfinished draft can still be undone and rebased; only new problems refuse', () => {
    const { pr, pid } = make();
    const c = pr.setDraft(pid, withC(), 'cora');
    if (!c.ok) throw new Error(c.error);
    const half = clone(c.draft.team);
    half.seats.push(newSeat('half', 'Half built', 'C:/w'));
    half.seats[half.seats.length - 1].name = '';
    expect(pr.setDraft(pid, half, 'you', { expect: 1 }).ok).toBe(true);
    expect(validateTeam(pr.draft(pid)!.team).ok).toBe(false);
    const u = pr.undoTurns(pid, [c.draft.turns[0].id]);
    expect(u.ok).toBe(true);
    const theirs = clone(exampleTeam());
    theirs.seats[0].name = 'Monitor 1';
    expect(pr.setTeam(pid, theirs, 'cora').ok).toBe(true);
    const r = pr.rebaseDraft(pid, false);
    expect(r).toMatchObject({ ok: true, draft: { base: 2 } });
  });

  it('a rebase that adds a problem says what, with their changes and the conflicts', () => {
    const { pr, pid } = make();
    expect(pr.setDraft(pid, withC(), 'you').ok).toBe(true);
    const theirs = clone(exampleTeam());
    theirs.seats = theirs.seats.filter((s) => s.id !== 'monitor-b');
    theirs.routes[0].from = theirs.routes[0].from.filter((f) => f !== 'seat:monitor-b');
    expect(pr.setTeam(pid, theirs, 'cora').ok).toBe(true);
    const dry = pr.rebaseDraft(pid, true);
    expect(dry).toMatchObject({ ok: true, problems: [expect.stringContaining('seat:monitor-b')] });
    if (dry.ok) expect(dry.theirs.length).toBeGreaterThan(0);
    const real = pr.rebaseDraft(pid, false);
    expect(real).toMatchObject({ ok: false, problems: [expect.stringContaining('seat:monitor-b')], conflicts: expect.any(Array) });
    if (!real.ok) expect(real.theirs!.length).toBeGreaterThan(0);
    expect(pr.draft(pid)!.base).toBe(1);
  });

  it('a layout with nothing usable leaves the saved one alone', () => {
    const { pr, pid } = make();
    pr.setTeamLayout(pid, { pos: { triage: { x: 1, y: 2 } } });
    expect(pr.setTeamLayout(pid, { pos: { bad: { x: 'a' } } })).toBe(true);
    expect(pr.get(pid)!.teamLayout).toEqual({ pos: { triage: { x: 1, y: 2 } } });
  });

  it('kept in the file: a new store reads the draft and the layout back', () => {
    const { pr, pid } = make();
    pr.setDraft(pid, withC(), 'cora');
    pr.setTeamLayout(pid, { pos: { triage: { x: 1, y: 2 } } });
    const again = new Projects(join(dir, 'projects.json'));
    expect(again.draft(pid)!.team.seats).toHaveLength(6);
    expect(again.get(pid)!.teamLayout).toEqual({ pos: { triage: { x: 1, y: 2 } } });
  });
});
