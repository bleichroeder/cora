import { describe, expect, it } from 'vitest';
import { JiraStarts, type JiraStartDeps } from '../src/orchestrator/jiraStart';
import { Approvals } from '../src/orchestrator/approvals';

const EV = { id: 'e1', kind: 'assigned' as const, key: 'ACME-5301', summary: 'Dedupe', who: 'Dana', what: 'assigned you', at: 1, link: 'https://x/browse/ACME-5301' };
const ses = (id: string, cwd: string, key?: string, lastTs = 1, state = 'idle') => ({ id, cwd, lastTs, state, ...(key ? { ticket: { key } } : {}) }) as any;

function make(o: Partial<JiraStartDeps> & { dirs?: string[] } = {}) {
  const approvals = new Approvals({ onChange: () => {}, waitMs: 20 });
  const launched: string[] = [];
  const notes: string[] = [];
  const dirs = new Set(o.dirs ?? ['C:/g/ts', 'C:/g/ui', 'C:/c/cora']);
  let n = 0;
  const d: JiraStartDeps = {
    mode: () => 'offer',
    listening: () => true,
    sessions: () => [ses('a', 'C:/g/ts', 'ACME-1', 5), ses('b', 'C:/g/ts', 'ACME-2', 6), ses('c', 'C:/c/cora', undefined, 9)],
    repos: () => ['C:/g/ui'],
    isDir: (p) => dirs.has(p),
    assigned: (k) => (k === 'ACME-5301' ? EV : undefined),
    approvals,
    launch: async ({ cwd, prompt, plan }) => (launched.push(`${cwd} ${prompt}${plan ? ' [plan mode]' : ''}`), { terminal: { sessionId: `s${++n}` }, sent: true }),
    prompts: () => 1,
    focus: () => {},
    userTurn: () => false,
    note: (l) => void notes.push(l),
    changed: () => {},
    ...o,
  };
  return { s: new JiraStarts(d), approvals, launched, notes };
}

describe('starting work from Jira', () => {
  it('candidates: where that project ran, then the mandate, then recent; existing only', () => {
    const { s } = make();
    expect(s.candidates('ACME-5301')).toEqual([
      { cwd: 'C:/g/ts', why: '2 ACME tickets' },
      { cwd: 'C:/g/ui', why: 'autopilot repo' },
      { cwd: 'C:/c/cora', why: 'recent' },
    ]);
    expect(make({ dirs: ['C:/c/cora'] }).s.candidates('ACME-5301')).toEqual([{ cwd: 'C:/c/cora', why: 'recent' }]);
  });

  it('hands off assignments only when Cora can act and there is no session', () => {
    expect(make().s.handoff(EV)).toBe(true);
    expect(make({ mode: () => 'tell' }).s.handoff(EV)).toBe(false);
    expect(make({ listening: () => false }).s.handoff(EV)).toBe(false);
    expect(make().s.handoff({ kind: 'assigned', key: 'ACME-1' })).toBe(false);
    expect(make().s.handoff({ kind: 'mentioned', key: 'ACME-5301' })).toBe(false);
  });

  it("gives Cora a turn that names the ticket, the candidates and jira_start", () => {
    const t = make().s.turnText(EV);
    expect(t).toMatch(/^\[Jira\] .*ACME-5301/);
    expect(t).toMatch(/jira_start/);
    expect(t).toMatch(/C:\/g\/ts \(2 ACME tickets\)/);
  });

  it('refuses tell, unknown tickets and tickets with a session', async () => {
    expect((await make({ mode: () => 'tell' }).s.start({ key: 'ACME-5301', cwd: 'C:/g/ts' })).ok).toBe(false);
    expect((await make().s.start({ key: 'ACME-9', cwd: 'C:/g/ts' })).ok).toBe(false);
    const dup = make({ assigned: () => ({ ...EV, key: 'ACME-1' }) });
    expect((await dup.s.start({ key: 'ACME-1', cwd: 'C:/g/ts' })).text).toMatch(/already has a session/);
  });

  it('offer: a start card with the ticket, its folders and no prompt to edit; OK starts it there', async () => {
    const { s, approvals, launched } = make();
    const out = s.start({ key: 'ACME-5301', cwd: 'C:/g/ts', why: 'where ACME work lives' });
    const a = approvals.list()[0];
    expect(a).toMatchObject({ kind: 'start', title: 'Start ACME-5301 in ts', ticket: { key: 'ACME-5301', summary: 'Dedupe', who: 'Dana' }, cwd: 'C:/g/ts' });
    expect(a.text).toBeUndefined();
    expect(a.folders?.map((f) => f.cwd)).toEqual(['C:/g/ts', 'C:/g/ui', 'C:/c/cora']);
    expect(s.offered()).toEqual(['ACME-5301']);
    await approvals.decide(a.id, { ok: true, cwd: 'C:/g/ui' });
    expect(launched).toEqual(['C:/g/ui /jira ACME-5301']);
    expect((await out).ok).toBe(true);
    expect(s.started()[0]).toMatchObject({ key: 'ACME-5301', cwd: 'C:/g/ui', auto: false });
  });

  it('an offer already waiting: told so, or started when the user asked for it', async () => {
    let mine = false;
    const m = make({ userTurn: () => mine });
    void m.s.start({ key: 'ACME-5301', cwd: 'C:/g/ts' });
    expect((await m.s.start({ key: 'ACME-5301', cwd: 'C:/g/ts' })).text).toMatch(/already waiting/);
    mine = true;
    expect((await m.s.start({ key: 'ACME-5301', cwd: 'C:/g/ui' })).ok).toBe(true);
    expect(m.launched).toEqual(['C:/g/ui /jira ACME-5301']);
    expect(m.approvals.list()).toEqual([]);
  });

  it('auto: starts at once under the cap, offers at the cap', async () => {
    const got: Array<[string, boolean]> = [];
    const m = make({ mode: () => 'auto', started: (r) => got.push([r.key, r.auto]) });
    expect((await m.s.start({ key: 'ACME-5301', cwd: 'C:/g/ts' })).text).toMatch(/^Started ACME-5301 in C:\/g\/ts/);
    expect(got).toEqual([['ACME-5301', true]]);
    // started on its own: in plan mode (audit S1)
    expect(m.launched).toEqual(['C:/g/ts /jira ACME-5301 [plan mode]']);
    expect(m.s.started()[0].auto).toBe(true);
    const full = make({ mode: () => 'auto', sessions: () => [ses('x', 'C:/g/ts', 'ACME-7'), ses('y', 'C:/g/ts', 'ACME-8')] });
    (full.s as any).rec = [
      { sessionId: 'x', key: 'ACME-7', summary: '', cwd: 'C:/g/ts', at: Date.now(), auto: true },
      { sessionId: 'y', key: 'ACME-8', summary: '', cwd: 'C:/g/ts', at: Date.now(), auto: true },
    ];
    expect(full.s.waiting()).toBe(2);
    void full.s.start({ key: 'ACME-5301', cwd: 'C:/g/ts' });
    expect(full.launched).toEqual([]);
    expect(full.approvals.list()[0].detail).toMatch(/2 tickets Cora started are waiting on you/);
  });

  it("its first prompt is the app's (the user's /jira, or Cora's ticket prompt)", async () => {
    const m = make({ mode: () => 'auto', ticketPrompt: async (e) => `Jira ticket ${e.key}: ${e.summary}\n…stop at a plan` });
    await m.s.start({ key: 'ACME-5301', cwd: 'C:/g/ts' });
    expect(m.launched[0]).toMatch(/^C:\/g\/ts Jira ticket ACME-5301: /);
  });

  it('auto: a failed launch becomes the offer', async () => {
    const m = make({ mode: () => 'auto', launch: async () => { throw new Error('no terminal host'); } });
    void m.s.start({ key: 'ACME-5301', cwd: 'C:/g/ts' });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.approvals.list()[0].detail).toMatch(/couldn't start: no terminal host/);
  });

  it("a missing folder: the first candidate; the user's own words start it", async () => {
    const m = make({ userTurn: () => true });
    expect((await m.s.start({ key: 'ACME-5301', cwd: 'C:/nope' })).ok).toBe(true);
    expect(m.launched).toEqual(['C:/g/ts /jira ACME-5301']);
  });

  it('waiting: not ended, and nothing typed by the user since', () => {
    const m = make({ sessions: () => [ses('x', 'C:/g/ts', 'ACME-7'), ses('y', 'C:/g/ts', 'ACME-8', 1, 'ended'), ses('z', 'C:/g/ts', 'ACME-9')], prompts: (sid) => (sid === 'z' ? 3 : 1) });
    (m.s as any).rec = ['x', 'y', 'z'].map((sessionId) => ({ sessionId, key: 'K', summary: '', cwd: '', at: Date.now(), auto: true }));
    expect(m.s.waiting()).toBe(1);
  });

  it('withdraws offers for tickets no longer yours', async () => {
    const m = make();
    void m.s.start({ key: 'ACME-5301', cwd: 'C:/g/ts' });
    m.s.still(['ACME-5301']);
    expect(m.approvals.list()).toHaveLength(1);
    m.s.still([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.approvals.list()).toEqual([]);
    expect(m.notes[0]).toMatch(/ACME-5301 isn't assigned to the user any more/);
  });
});
