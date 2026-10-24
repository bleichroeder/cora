import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';
import { Lock } from '../src/lock';

describe('lockdown', () => {
  it('keeps a hash of the PIN, never the PIN, and stays locked over a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-lock-'));
    const l = new Lock(dir);
    expect(l.lock()).toBe(false);
    expect(l.setPin('12a4')).toEqual({ ok: false, error: 'A PIN is 4 to 8 digits.' });
    expect(l.setPin('4821')).toEqual({ ok: true });
    expect(readFileSync(join(dir, 'lock.json'), 'utf8')).not.toContain('4821');
    expect(l.lock()).toBe(true);
    const again = new Lock(dir);
    expect(again.status()).toMatchObject({ locked: true, hasPin: true, digits: 4 });
    expect(again.unlock('4821')).toEqual({ ok: true });
    expect(new Lock(dir).locked).toBe(false);
  });

  it('changes or takes away the PIN only with the current one', () => {
    const l = new Lock(null);
    l.setPin('1111');
    expect(l.setPin('2222', '9999')).toMatchObject({ ok: false });
    expect(l.setPin('2222', '1111')).toEqual({ ok: true });
    expect(l.clearPin('1111')).toMatchObject({ ok: false });
    expect(l.clearPin('2222')).toEqual({ ok: true });
    expect(l.hasPin).toBe(false);
  });

  it('makes each try wait longer after five wrong PINs', () => {
    let now = 1_000_000;
    const l = new Lock(null, () => now);
    l.setPin('123456');
    l.lock();
    for (let i = 0; i < 4; i++) expect(l.unlock('000000')).toEqual({ ok: false, waitMs: 0 });
    expect(l.unlock('000000')).toEqual({ ok: false, waitMs: 30_000 });
    // waiting: even the right PIN waits
    expect(l.unlock('123456')).toEqual({ ok: false, waitMs: 30_000 });
    now += 30_000;
    expect(l.unlock('000000')).toEqual({ ok: false, waitMs: 60_000 });
    now += 60_000;
    expect(l.unlock('123456')).toEqual({ ok: true });
    l.lock();
    expect(l.unlock('000000')).toEqual({ ok: false, waitMs: 0 });
  });

  let srv: Running;
  afterEach(async () => srv?.close());
  it('gives your pages nothing but the lock screen while locked; hooks carry on', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cora-lockapp-'));
    srv = await startServer(loadConfig({ dataDir, dbPath: ':memory:', projectsDir: join(dataDir, 'p'), hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope-client') }), { tail: false, listen: false });
    const ui = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };
    const req = (method: 'GET' | 'POST' | 'PUT', url: string, body?: object, headers: Record<string, string> = ui) => srv.app.inject({ method, url, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });

    expect((await req('POST', '/api/lock')).statusCode).toBe(409);
    expect((await req('POST', '/api/local/lock', { reason: 'tray' }, { 'x-cora-token': 'hooktok' })).json()).toEqual({ locked: false, needsPin: true });
    expect((await req('PUT', '/api/lock/pin', { pin: '2468' })).json()).toMatchObject({ hasPin: true, locked: false });
    expect((await req('POST', '/api/lock')).json()).toEqual({ ok: true });

    expect((await req('GET', '/api/sessions')).statusCode).toBe(423);
    expect((await req('PUT', '/api/lock/pin', { pin: '1357', current: '2468' })).statusCode).toBe(423);
    expect((await req('GET', '/api/lock')).json()).toMatchObject({ locked: true, digits: 4, needsYou: 0 });
    const page = await req('GET', '/');
    expect([page.statusCode, page.headers.location]).toEqual([302, '/lock.html']);
    // sessions' hooks still land
    expect((await srv.app.inject({ method: 'POST', url: '/hook/Stop', headers: { 'x-cora-token': 'hooktok', 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(204);

    expect((await req('POST', '/api/lock/unlock', { pin: '0000' })).statusCode).toBe(403);
    expect((await req('POST', '/api/lock/unlock', { pin: '2468' })).json()).toEqual({ ok: true });
    expect((await req('GET', '/api/sessions')).statusCode).toBe(200);
  });
});
