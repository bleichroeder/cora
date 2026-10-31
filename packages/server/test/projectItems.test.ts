import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Projects } from '../src/projects';
import { annotateItem, changeItem, claimItem, closeItem, mergeItem, openItem, queryItems } from '../src/projectItems';
import { projectCard, projectNews } from '../src/projectCard';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-items-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const setup = () => {
  const t = 1_000_000;
  const ps = new Projects(join(dir, 'projects.json'), () => t);
  const p = ps.create('Ops');
  for (const s of ['triage', 'monitor', 'orch']) ps.add(p.id, s);
  ps.update(p.id, { coordination: true });
  return { ps, p: ps.get(p.id)!, t };
};
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error((r as unknown as { error: string }).error);
  return r as Extract<T, { ok: true }>;
};

describe('project items', () => {
  it('with no lead, an incident is its opener’s to run; claiming is atomic; the owner updates; anyone annotates; closing logs it', () => {
    const { p, t } = setup();
    const i = ok(openItem(p, 'monitor', { title: 'Station A: no video', severity: 'high' }, t)).item;
    expect(i).toMatchObject({ kind: 'incident', state: 'open', severity: 'high', openedBy: 'monitor' });
    // only the opener (or you) sets severity and owner
    expect(changeItem(p, 'triage', i.id, { severity: 'critical' }, t)).toMatchObject({ ok: false });
    // the first claim wins; the second is told who has it
    expect(ok(claimItem(p, 'triage', i.id, t)).item).toMatchObject({ owner: 'triage', state: 'working' });
    expect(claimItem(p, 'orch', i.id, t + 1)).toMatchObject({ ok: false, error: expect.stringMatching(/Already claimed: triage/) });
    // its owner sets state and next; another member can't, but can annotate (and the owner is told)
    ok(changeItem(p, 'triage', i.id, { state: 'waiting', next: 'vendor ticket' }, t + 2));
    expect(changeItem(p, 'orch', i.id, { next: 'mine now' }, t + 3)).toMatchObject({ ok: false });
    expect(ok(annotateItem(p, 'orch', i.id, 'recovered at 14:20', t + 4)).tell).toEqual({ to: 'triage', text: expect.stringMatching(/Noted on "Station A: no video": recovered/) });
    // closed by its owner with a cause and fix: out of the open list, into the log
    expect(closeItem(p, 'orch', i.id, 'x', 'y', t + 5)).toMatchObject({ ok: false });
    ok(closeItem(p, 'triage', i.id, 'encoder hung', 'restarted it', t + 5));
    expect(queryItems(p, { kind: 'incident' })).toEqual([]);
    expect(queryItems(p, { kind: 'incident', open: false })[0]).toMatchObject({ state: 'resolved', cause: 'encoder hung', fix: 'restarted it' });
  });

  it('with a lead, only the lead opens, assigns (the owner is told) and merges; you and Cora may too', () => {
    const { ps, p, t } = setup();
    ps.update(p.id, { lead: 'orch' });
    expect(openItem(p, 'monitor', { title: 'Station B down' }, t)).toMatchObject({ ok: false, error: expect.stringMatching(/Only the lead/) });
    const a = ok(openItem(p, 'orch', { title: 'Station B down', owner: 'triage', severity: 'critical' }, t));
    expect(a.item.state).toBe('working');
    expect(a.tell).toEqual({ to: 'triage', text: expect.stringMatching(/^Assigned you "Station B down" \(critical\)/) });
    const b = ok(openItem(p, 'you', { title: 'Station B: no audio' }, t + 1)).item;
    ok(annotateItem(p, 'monitor', b.id, 'same site as B', t + 2));
    expect(changeItem(p, 'monitor', a.item.id, { owner: 'monitor' }, t + 3)).toMatchObject({ ok: false });
    expect(ok(changeItem(p, 'orch', a.item.id, { owner: 'monitor' }, t + 3)).tell?.text).toMatch(/^Reassigned you/);
    expect(mergeItem(p, 'monitor', b.id, a.item.id, t + 4)).toMatchObject({ ok: false });
    const m = ok(mergeItem(p, 'cora', b.id, a.item.id, t + 4)).item;
    expect(m.notes.map((n) => n.text)).toEqual(['same site as B', expect.stringMatching(/Merged in "Station B: no audio"/)]);
    expect(p.items!.find((x) => x.id === b.id)).toMatchObject({ mergedInto: a.item.id, state: 'resolved' });
    // most urgent first; filters by owner and words
    ok(openItem(p, 'orch', { title: 'Station C flapping', severity: 'low' }, t + 5));
    expect(queryItems(p, { kind: 'incident' }).map((i) => i.title)).toEqual(['Station B down', 'Station C flapping']);
    expect(queryItems(p, { owner: 'none' }).map((i) => i.title)).toEqual(['Station C flapping']);
    expect(queryItems(p, { words: 'flap' }).length).toBe(1);
  });

  it('known issues: a session proposes, only you approve or retire; approved ones join the card', () => {
    const { p, t } = setup();
    const k = ok(openItem(p, 'monitor', { kind: 'known', title: 'Station D is dark overnight', rule: 'drop its alerts 01:00-05:00' }, t)).item;
    expect(k.state).toBe('proposed');
    const who = (x: string) => x;
    const info = (x: string) => ({ name: x, state: 'idle' });
    expect(projectCard(p, 'triage', info, who, true)).not.toMatch(/Known issues/);
    expect(changeItem(p, 'orch', k.id, { state: 'approved' }, t)).toMatchObject({ ok: false });
    ok(changeItem(p, 'you', k.id, { state: 'approved' }, t));
    expect(projectCard(p, 'triage', info, who, true)).toMatch(/Known issues \(approved\):\n- Station D is dark overnight · rule: drop its alerts 01:00-05:00/);
    ok(changeItem(p, 'you', k.id, { state: 'retired' }, t + 1));
    expect(projectCard(p, 'triage', info, who, true)).not.toMatch(/Station D/);
  });

  it('a post: only its writer edits or withdraws it; members hear the change; reports reach only their seat', () => {
    const { ps, p } = setup();
    const post = ps.post(p.id, 'orch', 'handoff', 'triage takes station A', ['triage'])!;
    expect(ps.editPost(p.id, 'triage', post.id, 'no')).toMatchObject({ ok: false });
    expect(ps.editPost(p.id, 'orch', post.id, 'monitor takes station A')).toMatchObject({ ok: true });
    expect(p.thread[0]).toMatchObject({ text: 'monitor takes station A', editedAt: expect.any(Number) });
    ps.editPost(p.id, 'orch', post.id, null);
    expect(p.thread[0].withdrawn).toBe(true);
    const who = (x: string) => x;
    expect(projectNews(p, 'triage', 0, who)).toMatch(/\[handoff\] \[withdrawn\] orch/);
    ps.post(p.id, 'monitor', 'report', 'Station A: CRITICAL', ['triage']);
    expect(projectNews(p, 'triage', 0, who)).toMatch(/\[report\] monitor .*Station A: CRITICAL/);
    expect(projectNews(p, 'orch', 0, who) ?? '').not.toMatch(/CRITICAL/);
  });

  it('seats and the lead: a role and the lead show on the card; leaving clears the lead', () => {
    const { ps, p } = setup();
    ps.setMember(p.id, 'triage', { role: 'triage' });
    ps.update(p.id, { lead: 'orch' });
    const card = projectCard(p, 'triage', (x) => ({ name: x, state: 'idle' }), (x) => x, true);
    expect(card).toMatch(/Your seat: triage\./);
    expect(card).toMatch(/- "orch" \[lead\] \(orch\)/);
    expect(card).toMatch(/The lead \(orch\) opens incidents/);
    ps.leave(p.id, 'orch');
    expect(ps.get(p.id)!.lead).toBeUndefined();
  });
});
