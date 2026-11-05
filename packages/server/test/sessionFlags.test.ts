import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import { dueReminders, flagFrom, remindText } from '../src/sessionFlags';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

/** Sessions flagged to come back to (the nav row's bookmark): kept with the session, cleared only by you. */

describe('a flag in the store', () => {
  it('set whole, kept through the session changing, cleared; reminders due by now come once', () => {
    const s = new Store(':memory:');
    s.upsertSession({ id: 'a', cwd: 'C:/w/a', lastTs: 1 });
    s.upsertSession({ id: 'b', cwd: 'C:/w/b', lastTs: 1 });
    expect(s.setFlag('nope', { at: 1 })).toBeUndefined();
    s.setFlag('a', { at: 10, note: 'check the deploy finished', remindAt: 500 });
    // the session's own changes (its state, its name) leave the flag as it is
    s.upsertSession({ id: 'a', state: 'working', alias: 'Deploy', lastTs: 20 });
    expect(s.getSession('a')).toMatchObject({ alias: 'Deploy', flag: { at: 10, note: 'check the deploy finished', remindAt: 500 } });
    // a new flag doesn't keep the old one's note
    s.setFlag('b', { at: 1, note: 'old' });
    s.setFlag('b', { at: 2 });
    expect(s.getSession('b')!.flag).toEqual({ at: 2 });
    expect(s.dueFlags(499)).toEqual([]);
    expect(dueReminders(s, 500).map((x) => [x.id, x.flag])).toEqual([['a', { at: 10, note: 'check the deploy finished', remindAt: 500, due: true }]]);
    expect(dueReminders(s, 10_000)).toEqual([]);
    s.setFlag('a', null);
    expect(s.getSession('a')!.flag).toBeNull();
    expect(s.dueFlags(10_000)).toEqual([]);
  });

  it("a request's flag: its note one line (null clears it, left out keeps it), its reminder a time (a new one is due again)", () => {
    expect(flagFrom(null, {}, 100)).toEqual({ flag: { at: 100 } });
    expect(flagFrom(null, { note: '  check\n the  deploy ' }, 100)).toEqual({ flag: { at: 100, note: 'check the deploy' } });
    const due = { at: 5, note: 'x', remindAt: 50, due: true as const };
    // left out: kept (and still due); the note cleared
    expect(flagFrom(due, { note: null }, 100)).toEqual({ flag: { at: 5, remindAt: 50, due: true } });
    // a new reminder is due again when it comes; none at all
    expect(flagFrom(due, { remindAt: 900 }, 100)).toEqual({ flag: { at: 5, note: 'x', remindAt: 900 } });
    expect(flagFrom(due, { remindAt: null }, 100)).toEqual({ flag: { at: 5, note: 'x' } });
    expect(flagFrom(null, { note: 'x'.repeat(121) }, 100)).toMatchObject({ error: expect.stringMatching(/at most 120/) });
    expect(flagFrom(null, { note: 7 }, 100)).toMatchObject({ error: expect.any(String) });
    expect(flagFrom(null, { remindAt: 'tomorrow' }, 100)).toMatchObject({ error: expect.any(String) });
    expect(flagFrom(null, { remindAt: 100 + 400 * 24 * 3_600_000 }, 100)).toMatchObject({ error: expect.any(String) });
    expect(remindText('Deploy', { at: 1, note: 'check it finished' })).toBe('Come back to "Deploy": check it finished');
    expect(remindText('Deploy', { at: 1 })).toBe('Come back to "Deploy"');
  });
});

describe('the flag API', () => {
  let srv: Running | undefined;
  let dir: string;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('flags a session, changes its note and reminder, clears it; its reminder comes when due; unknown sessions and bad input refused', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cora-flags-'));
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'h', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, ci: false, security: false, flagCheckMs: 20 });
    const req = (method: 'POST' | 'DELETE', url: string, payload?: object) => srv!.app.inject({ method, url, headers: { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' }, ...(payload ? { payload } : {}) });
    srv.store.upsertSession({ id: 's1', cwd: 'C:/w/x', alias: 'Deploy', lastTs: Date.now() });
    const set = await req('POST', '/api/sessions/s1/flag', {});
    expect(set.statusCode).toBe(200);
    expect(set.json().flag).toEqual({ at: expect.any(Number) });
    const at = set.json().flag.at;
    const noted = await req('POST', '/api/sessions/s1/flag', { note: 'check the deploy finished', remindAt: Date.now() + 60_000 });
    expect(noted.json().flag).toMatchObject({ at, note: 'check the deploy finished' });
    expect((await req('POST', '/api/sessions/s1/flag', { note: 'x'.repeat(200) })).statusCode).toBe(400);
    expect((await req('POST', '/api/sessions/nope/flag', {})).statusCode).toBe(404);
    expect((await req('DELETE', '/api/sessions/nope/flag')).statusCode).toBe(404);
    // its reminder, due now: it comes (once)
    await req('POST', '/api/sessions/s1/flag', { remindAt: Date.now() - 1 });
    for (let i = 0; i < 50 && !srv.store.getSession('s1')!.flag?.due; i++) await new Promise((r) => setTimeout(r, 20));
    expect(srv.store.getSession('s1')!.flag).toMatchObject({ at, note: 'check the deploy finished', due: true });
    // cleared only by you
    const off = await req('DELETE', '/api/sessions/s1/flag');
    expect(off.statusCode).toBe(200);
    expect(off.json().flag).toBeNull();
  });
});
