import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { displayName, type SessionInfo } from '@cora/shared';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';
import { SessionNames } from '../src/sessionNames';

const s = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({ id, cwd: 'C:/code/x', project: 'x', title: 'Claude title', state: 'ended', startedAt: 1, lastTs: 1, cliVersion: '', transcriptPath: '', needsYou: 0, ...over });

describe('session names', () => {
  it('are what the nav shows: yours, the ticket, the issue, Cora\'s, then Claude Code\'s title', () => {
    expect(displayName(s('a', { alias: 'mine', autoName: 'auto' }))).toBe('mine');
    expect(displayName(s('a', { ticket: { key: 'ACME-1', site: null, summary: 'Fix it' }, autoName: 'auto' }))).toBe('ACME-1 · Fix it');
    expect(displayName(s('a', { issue: { project: 'g/p', iid: 7, url: 'u', title: 'Issue title' } }))).toBe('Issue title');
    expect(displayName(s('a', { autoName: 'auto' }))).toBe('auto');
    expect(displayName(s('a'))).toBe('Claude title');
  });

  it('are kept past history (only ones of their own), and read back after a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-names-'));
    const n = new SessionNames(dir);
    n.remember([s('a', { alias: 'mine' }), s('b')]);
    expect(new SessionNames(dir).get('a')).toBe('mine');
    expect(new SessionNames(dir).get('b')).toBeUndefined();
  });

  let srv: Running;
  afterEach(async () => srv?.close());
  it("Resume shows a session by the nav's name, not only Claude Code's title", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cora-hist-'));
    const projectsDir = join(dataDir, 'projects');
    mkdirSync(join(projectsDir, 'C--code-x'), { recursive: true });
    const sid = '11111111-2222-3333-4444-555555555555';
    writeFileSync(join(projectsDir, 'C--code-x', `${sid}.jsonl`), [
      JSON.stringify({ type: 'user', sessionId: sid, cwd: 'C:/code/x', timestamp: '2026-10-20T10:00:00Z', message: { role: 'user', content: 'start here' } }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Claude title' }),
    ].join('\n'));
    srv = await startServer(loadConfig({ dataDir, dbPath: ':memory:', projectsDir, hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope-client') }), { tail: false, listen: false });
    srv.store.upsertSession({ ...s(sid), alias: 'My rename' });
    const r = await srv.app.inject({ method: 'GET', url: '/api/history', headers: { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' } });
    const item = (r.json() as { sessions: Array<{ sessionId: string; title: string; name?: string }> }).sessions.find((h) => h.sessionId === sid);
    expect(item).toMatchObject({ title: 'Claude title', name: 'My rename' });
  });
});
