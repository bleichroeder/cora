import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let srv: Running;
afterEach(async () => srv?.close());
const UI = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };

describe('the setup routes', () => {
  it('lists the checklist; installs the hooks (backed up); skips and un-skips a feature; the first run is seen once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-su-'));
    const claudeSettingsFile = join(dir, 'settings.json');
    writeFileSync(claudeSettingsFile, JSON.stringify({ theme: 'dark' }));
    const all = async (c: string) => `C:\bin\${c}.exe`;
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, claudeSettingsFile, setupChecks: { which: all, glabAuthed: async () => true, onePassword: async () => ({ app: true, cli: true, connected: true }) } });
    const get = async () => (await srv.app.inject({ method: 'GET', url: '/api/setup', headers: UI })).json();
    let s = await get();
    expect(s).toMatchObject({ seen: false, fresh: true });
    expect(s.items.find((i: any) => i.id === 'hooks').status).toBe('needs');
    expect((await srv.app.inject({ method: 'GET', url: '/api/setup/hooks', headers: UI })).json().diff).toMatch(/PreToolUse/);
    expect((await srv.app.inject({ method: 'POST', url: '/api/setup/run', headers: UI, payload: { item: 'hooks', need: 'hooks' } })).json()).toMatchObject({ ok: true });
    const written = JSON.parse(readFileSync(claudeSettingsFile, 'utf8'));
    expect(written.theme).toBe('dark');
    expect(Object.keys(written.hooks)).toContain('PreToolUse');
    s = await get();
    expect(s.items.find((i: any) => i.id === 'hooks').status).toBe('ready');
    // nothing the client names runs unless the server knows it
    expect((await srv.app.inject({ method: 'POST', url: '/api/setup/run', headers: UI, payload: { item: 'voice', need: 'rm -rf' } })).statusCode).toBe(400);
    await srv.app.inject({ method: 'POST', url: '/api/setup/skip', headers: UI, payload: { item: 'gmail', skip: true } });
    expect((await get()).items.find((i: any) => i.id === 'gmail').status).toBe('skipped');
    await srv.app.inject({ method: 'POST', url: '/api/setup/skip', headers: UI, payload: { item: 'gmail', skip: false } });
    expect((await get()).items.find((i: any) => i.id === 'gmail').status).toBe('needs');
    await srv.app.inject({ method: 'POST', url: '/api/setup/seen', headers: UI });
    expect((await get()).seen).toBe(true);
  });

  it("a malformed Claude settings file: Setup says what's wrong and never writes to it (audit B3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-su-bad-'));
    const claudeSettingsFile = join(dir, 'settings.json');
    writeFileSync(claudeSettingsFile, '{ "theme": "dark", ');
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, claudeSettingsFile, setupChecks: { which: async () => null, glabAuthed: async () => false, onePassword: async () => ({ app: false, cli: false, connected: false }) } });
    const s = (await srv.app.inject({ method: 'GET', url: '/api/setup', headers: UI })).json();
    const hooks = s.items.find((i: any) => i.id === 'hooks');
    expect(hooks.status).toBe('needs');
    expect(hooks.needs[0].detail).toMatch(/isn't valid JSON/);
    const run = await srv.app.inject({ method: 'POST', url: '/api/setup/run', headers: UI, payload: { item: 'hooks', need: 'hooks' } });
    expect(run.statusCode).toBe(400);
    expect(readFileSync(claudeSettingsFile, 'utf8')).toBe('{ "theme": "dark", ');
    expect((await srv.app.inject({ method: 'GET', url: '/api/setup/hooks', headers: UI })).statusCode).toBe(400);
  });
});
