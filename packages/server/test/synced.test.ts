import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Synced } from '../src/synced';
import { loadConfig } from '../src/config';
import { startServer } from '../src/server';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-synced-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("your Cora's look on every device", () => {
  it('keeps the keys that sync (only those), across a restart', () => {
    const s = new Synced(join(dir, 'synced.json'));
    expect(s.set('ab:ui', '{"coraColor":"#f472b6"}')).toBe(true);
    expect(s.set('cora.rail.folded', '{"ended":true}')).toBe(true);
    expect(s.set('cora.browser.profile', 'x')).toBe(false);
    expect(s.set('ab:ui', 'x'.repeat(3 * 1024 * 1024))).toBe(false);
    expect(s.set('cora.rail.folded', null)).toBe(true);
    expect(new Synced(join(dir, 'synced.json')).all()).toEqual({ 'ab:ui': '{"coraColor":"#f472b6"}' });
  });

  it('through the server: your screens read and write it; a guest or another site can not', async () => {
    const srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    try {
      const pc = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
      expect((await srv.app.inject({ url: '/api/synced', headers: pc })).json()).toEqual({ values: {} });
      expect((await srv.app.inject({ method: 'PUT', url: '/api/synced/ab%3Aui', headers: pc, payload: { value: '{"scene3d":false}' } })).statusCode).toBe(200);
      expect((await srv.app.inject({ method: 'PUT', url: '/api/synced/cora.wake.muted', headers: pc, payload: { value: '1' } })).statusCode).toBe(400);
      expect((await srv.app.inject({ method: 'PUT', url: '/api/synced/ab%3Aui', headers: { cookie: pc.cookie, origin: 'https://evil.example' }, payload: { value: '{}' } })).statusCode).toBe(403);
      expect((await srv.app.inject({ method: 'PUT', url: '/api/synced/ab%3Aui', payload: { value: '{}' } })).statusCode).toBe(401);
      expect((await srv.app.inject({ url: '/api/synced', headers: pc })).json()).toEqual({ values: { 'ab:ui': '{"scene3d":false}' } });
    } finally {
      await srv.close();
    }
  });
});
