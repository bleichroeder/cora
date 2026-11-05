import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { journalDir } from '../src/journal';
import { startServer, type Running } from '../src/server';

let dir: string;
let srv: Running | undefined;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-e2e-journal-'))));
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
const H = { 'x-cora-token': 'hooktok', accept: 'application/json, text/event-stream', 'content-type': 'application/json' };

describe("a throwaway Cora's journal", () => {
  it('is kept where its config says (under its root), never in your Documents', async () => {
    const own = join(dir, 'journal');
    const cfg = loadConfig({ dataDir: join(dir, 'home'), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', journalDir: own });
    expect(cfg.journalDir).toBe(own);
    srv = await startServer(cfg, { tail: false, listen: false, ci: false, security: false });
    expect((await srv.app.inject({ url: '/api/journal', headers: UI })).json()).toEqual({ dir: own });
    // a session's entry: written under the root
    const now = Date.now();
    srv.store.upsertSession({ id: 'sess-e2e-0001', cwd: dir, state: 'idle', startedAt: now, lastTs: now } as never);
    const r = await srv.app.inject({ method: 'POST', url: '/mcp', headers: { ...H, 'x-cora-session': 'sess-e2e-0001' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'journal', arguments: { text: 'Checked the Library.', kind: 'done' } } } });
    expect(r.statusCode).toBe(200);
    const files = (readdirSync(own, { recursive: true }) as string[]).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    expect(relative(dir, join(own, files[0])).startsWith('..')).toBe(false);
  });

  it('unset: the usual Documents\\Cora\\Journal', () => {
    const cfg = loadConfig({ dataDir: join(dir, 'home'), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' });
    expect(cfg.journalDir).toBeUndefined();
    expect(journalDir()).toMatch(/Cora[\\/]Journal$/);
    expect(existsSync(join(dir, 'journal'))).toBe(false);
  });
});
