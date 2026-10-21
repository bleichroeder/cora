import { describe, expect, it } from 'vitest';
import { Approvals } from '../src/orchestrator/approvals';

describe('approvals with folders', () => {
  it('runs with the folder you chose, only one of its own', async () => {
    const a = new Approvals({ onChange: () => {} });
    const ran: Array<string | undefined> = [];
    void a.request({ kind: 'start', title: 'Start ACME-1', detail: '', cwd: 'C:/a', folders: [{ cwd: 'C:/a', why: 'x' }, { cwd: 'C:/b', why: 'y' }] }, async (_t, _l, cwd) => (ran.push(cwd), 'ok'));
    const id = a.list()[0].id;
    expect(await a.decide(id, { ok: true, cwd: 'C:/evil' })).toEqual({ ok: false, error: 'not one of its folders' });
    expect(await a.decide(id, { ok: true, cwd: 'C:/b' })).toMatchObject({ ok: true });
    expect(ran).toEqual(['C:/b']);
  });

  it('tells what it asked, and what you answered', async () => {
    const asked: string[] = [];
    const answered: Array<[string, boolean, string | undefined]> = [];
    const ap = new Approvals({ onChange: () => {}, waitMs: 5, onAsk: (a) => asked.push(a.title), onAnswer: (a, ok, result) => answered.push([a.title, ok, result]) });
    void ap.request({ kind: 'start', title: 'Start ACME-1 in app', detail: 'd' }, async () => 'Started');
    await ap.decide(ap.list()[0].id, { ok: true });
    void ap.request({ kind: 'start', title: 'Start ACME-2 in app', detail: 'd' }, async () => 'Started');
    await ap.decide(ap.list()[0].id, { ok: false });
    expect(asked).toEqual(['Start ACME-1 in app', 'Start ACME-2 in app']);
    expect(answered).toEqual([['Start ACME-1 in app', true, 'Started'], ['Start ACME-2 in app', false, undefined]]);
  });
});

// docs/audit-2026-10-20.md U3
describe("Cora's cards across a restart", () => {
  it("are kept with what they do: after a restart an OK does it again, and the agent hears; cards that can't be kept are told", async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'cora-ap-')), 'approvals.json');
    const before = new Approvals({ onChange: () => {}, waitMs: 5, file });
    void before.request({ kind: 'start', title: 'Start a session in app', detail: 'C:/code/app', text: 'fix the bug', cwd: 'C:/code/app' }, async () => 'ran before', { do: 'start', cwd: 'C:/code/app' });
    void before.request({ kind: 'send', title: 'Answer "x"\'s question', detail: '', text: 'Q → A' }, async () => 'answered');
    const lost: string[] = [];
    const late: string[] = [];
    const after = new Approvals({ onChange: () => {}, file, onLost: (l) => lost.push(...l.map((a) => a.title)), onLate: (_a, r) => late.push(r) });
    await new Promise((r) => setTimeout(r, 0));
    expect(lost).toEqual(['Answer "x"\'s question']);
    const [card] = after.list();
    expect(card).toMatchObject({ title: 'Start a session in app', waiting: false });
    // not until Cora's up
    expect(await after.decide(card.id, { ok: true })).toMatchObject({ ok: false, error: expect.stringMatching(/still starting/) });
    const did: Array<[string, string | undefined]> = [];
    after.setRedo(async (r, text) => (did.push([r.do, text]), 'Started again'));
    expect(await after.decide(card.id, { ok: true, text: 'fix the bug, carefully' })).toEqual({ ok: true, result: 'Started again' });
    expect(did).toEqual([['start', 'fix the bug, carefully']]);
    expect(late).toEqual(['Started again']);
    expect(new Approvals({ onChange: () => {}, file }).list()).toEqual([]);
  });
});
