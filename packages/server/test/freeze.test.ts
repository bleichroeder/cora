import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TerminalInfo } from '@cora/shared';
import { Freeze } from '../src/freeze';

const t = (id: string, sessionId: string, o: Partial<TerminalInfo> = {}): TerminalInfo => ({ terminalId: id, sessionId, cwd: `C:/code/${sessionId}`, mode: 'resume', alive: true, startedAt: 1, ...o });
const wait = () => new Promise((r) => setTimeout(r, 650));
const none = () => false;

describe('deep freeze', () => {
  it('keeps what was open over the PC going down (the terminal host gone), and offers it to the next Cora', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-freeze-'));
    const f = new Freeze(dir);
    f.update([t('c1', 's1'), t('sh1', 's1', { mode: 'shell', shell: 'PowerShell 7' }), t('b1', 's1', { mode: 'shell', shell: 'Git Bash', place: 'board' }), t('c2', 's2')]);
    // open now: nothing to bring back
    expect(f.items(none)).toEqual([]);
    // the host goes: every terminal ends at once, and stays kept
    f.update([t('c1', 's1', { alive: false, exitCode: -1 }), t('c2', 's2', { alive: false, exitCode: -1 })], true);
    f.flush();
    await wait();
    const next = new Freeze(dir);
    expect(next.items(none)).toEqual([
      { sessionId: 's1', cwd: 'C:/code/s1', claude: true, shells: [{ id: 'sh1', shell: 'PowerShell 7' }, { id: 'b1', shell: 'Git Bash', place: 'board' }] },
      { sessionId: 's2', cwd: 'C:/code/s2', claude: true, shells: [] },
    ]);
    expect(next.at).toBeGreaterThan(0);
  });

  it("lets go of what you ended while Cora watched (a session ended, a shell closed)", () => {
    const f = new Freeze(null);
    f.update([t('c1', 's1'), t('c2', 's2'), t('sh1', 's2', { mode: 'shell' })]);
    // s1 ended (Claude quit), s2's shell closed (gone from the list)
    f.update([t('c1', 's1', { alive: false, exitCode: 0 }), t('c2', 's2')]);
    // then the PC goes down
    f.update([t('c2', 's2', { alive: false, exitCode: -1 })], true);
    const again = new Freeze(null);
    expect(again.items(none)).toEqual([]);
    // (this one's own memory: only s2, without its shell, is kept)
    const kept = (f as unknown as { kept: Map<string, unknown> }).kept;
    expect([...kept.keys()]).toEqual(['c2']);
  });

  it("doesn't offer a session that's open again, and forgets what was brought back or not wanted", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-freeze-'));
    const f = new Freeze(dir);
    f.update([t('c1', 's1'), t('c2', 's2'), t('c3', 's3')]);
    f.update([], true);
    f.flush();
    await wait();
    const next = new Freeze(dir);
    // s2 was resumed by hand meanwhile
    expect(next.items((sid) => sid === 's2').map((i) => i.sessionId)).toEqual(['s1', 's3']);
    next.forget(['s1']);
    expect(next.items(none).map((i) => i.sessionId)).toEqual(['s2', 's3']);
    next.forget();
    expect(next.items(none)).toEqual([]);
  });

  it('never offers one that ended while Cora was closed (its host kept running and says so)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-freeze-'));
    const f = new Freeze(dir);
    f.update([t('c1', 's1'), t('c2', 's2')]);
    f.flush();
    await wait();
    // Cora restarts; the host kept s2 going, but s1's Claude quit meanwhile
    const next = new Freeze(dir);
    next.update([t('c1', 's1', { alive: false, exitCode: 0 }), t('c2', 's2')]);
    expect(next.items(none)).toEqual([]);
  });
});

describe('bringing sessions back', () => {
  it('offers what was kept and resumes it: Claude in its folder, its shells opened again (their new ids told)', async () => {
    const { startServer } = await import('../src/server');
    const { loadConfig } = await import('../src/config');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const dataDir = mkdtempSync(join(tmpdir(), 'cora-thaw-'));
    const work = join(dataDir, 'work');
    mkdirSync(work);
    writeFileSync(join(dataDir, 'freeze.json'), JSON.stringify({ v: 1, terms: [{ id: 'old-c', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', cwd: work, claude: true, at: 5 }, { id: 'old-s', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', cwd: work, claude: false, shell: 'Shell', place: 'board', at: 6 }] }));
    const spawned: string[][] = [];
    const fakeSpawn = (file: string, args: string[]) => (spawned.push([file, ...args]), { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
    const srv = await startServer(loadConfig({ dataDir, dbPath: join(dataDir, 'db.sqlite'), projectsDir: join(dataDir, 'p'), hookToken: 'h', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, spawn: fakeSpawn as never });
    try {
      const h = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' };
      const offer = (await srv.app.inject({ method: 'GET', url: '/api/freeze', headers: h })).json();
      expect(offer.items).toEqual([expect.objectContaining({ sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', claude: true, shells: [{ id: 'old-s', shell: 'Shell', place: 'board' }] })]);
      const r = (await srv.app.inject({ method: 'POST', url: '/api/freeze/thaw', headers: h, payload: JSON.stringify({ sessionIds: ['aaaaaaaa-1111-2222-3333-444444444444'] }) })).json();
      expect(r.started).toBe(1);
      expect(Object.keys(r.shells)).toEqual(['old-s']);
      expect(spawned.some((a) => a.includes('--resume') && a.includes('aaaaaaaa-1111-2222-3333-444444444444'))).toBe(true);
      // brought back: not offered again
      expect((await srv.app.inject({ method: 'GET', url: '/api/freeze', headers: h })).json().items).toEqual([]);
    } finally {
      await srv.close();
    }
  });
});
