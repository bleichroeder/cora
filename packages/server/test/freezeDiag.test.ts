import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer } from '../src/server';

/** A window that freezes can say where its JavaScript was stuck: the pages opt in to having their call stack read. */
describe('the pages and a frozen window', () => {
  it('HTML pages carry the Document-Policy that lets the desktop app read their call stack; other files do not', async () => {
    const clientDir = mkdtempSync(join(tmpdir(), 'cora-client-'));
    writeFileSync(join(clientDir, 'lock.html'), '<!doctype html><p>lock</p>');
    writeFileSync(join(clientDir, 'app.js'), 'console.log(1)');
    const dir = mkdtempSync(join(tmpdir(), 'cora-freeze-'));
    const srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'h', uiToken: 'u', clientDir }), { tail: false, listen: false });
    try {
      const page = await srv.app.inject({ method: 'GET', url: '/lock.html' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['document-policy']).toBe('include-js-call-stacks-in-crash-reports');
      const js = await srv.app.inject({ method: 'GET', url: '/app.js', headers: { cookie: 'ab_session=u' } });
      expect(js.headers['document-policy']).toBeUndefined();
    } finally {
      await srv.close();
    }
  });
});
