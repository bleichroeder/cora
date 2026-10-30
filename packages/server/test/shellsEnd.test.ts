import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe("a session's shells", () => {
  it('close when it really ends (you end it, Ctrl+C, Claude Code says so), not while its Claude is still running', async () => {
    const { startServer } = await import('../src/server');
    const { loadConfig } = await import('../src/config');
    const dataDir = mkdtempSync(join(tmpdir(), 'cora-shells-end-'));
    const cwd = mkdtempSync(join(tmpdir(), 'cora-shells-work-'));
    const killed: string[] = [];
    let n = 0;
    const fakeSpawn = (file: string) => {
      const id = `${file}#${++n}`;
      const exits: Array<(e: { exitCode: number }) => void> = [];
      return { id, onData() {}, onExit: (cb: (e: { exitCode: number }) => void) => void exits.push(cb), write() {}, resize() {}, kill: () => (killed.push(id), exits.forEach((cb) => cb({ exitCode: 0 }))) };
    };
    const srv = await startServer(loadConfig({ dataDir, dbPath: join(dataDir, 'db.sqlite'), projectsDir: join(dataDir, 'p'), hookToken: 'h', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, spawn: fakeSpawn as never });
    try {
      const H = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' };
      srv.pipeline.ingestHook('UserPromptSubmit', { session_id: 's1', cwd, transcript_path: join(dataDir, 's1.jsonl'), hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: 'hi' });
      const shell = (await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'shell', sessionId: 's1' } })).json();
      expect(shell).toMatchObject({ mode: 'shell', sessionId: 's1', alive: true });
      expect(killed).toEqual([]);
      // Claude Code says it ended (going quiet doesn't count: the registry's tests): its shell goes with it
      srv.pipeline.ingestHook('SessionEnd', { session_id: 's1', cwd, transcript_path: join(dataDir, 's1.jsonl'), hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
      await new Promise((r) => setTimeout(r, 20));
      expect(killed).toHaveLength(1);
      const list = (await srv.app.inject({ url: '/api/terminals', headers: { cookie: H.cookie } })).json();
      expect(list.terminals.filter((t: { mode: string; alive: boolean }) => t.mode === 'shell' && t.alive)).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it("don't end it: closing one of its shells (a tab's x) leaves the session live and its other shells running", async () => {
    const { startServer } = await import('../src/server');
    const { loadConfig } = await import('../src/config');
    const dataDir = mkdtempSync(join(tmpdir(), 'cora-shells-close-'));
    const cwd = mkdtempSync(join(tmpdir(), 'cora-shells-work-'));
    const killed: string[] = [];
    let n = 0;
    const fakeSpawn = (file: string) => {
      const id = `${file}#${++n}`;
      const exits: Array<(e: { exitCode: number }) => void> = [];
      return { id, onData() {}, onExit: (cb: (e: { exitCode: number }) => void) => void exits.push(cb), write() {}, resize() {}, kill: () => (killed.push(id), exits.forEach((cb) => cb({ exitCode: 1 }))) };
    };
    const srv = await startServer(loadConfig({ dataDir, dbPath: join(dataDir, 'db.sqlite'), projectsDir: join(dataDir, 'p'), hookToken: 'h', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, spawn: fakeSpawn as never });
    try {
      const H = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' };
      srv.pipeline.ingestHook('UserPromptSubmit', { session_id: 's1', cwd, transcript_path: join(dataDir, 's1.jsonl'), hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: 'hi' });
      const a = (await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'shell', sessionId: 's1' } })).json();
      const b = (await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'shell', sessionId: 's1' } })).json();
      expect((await srv.app.inject({ method: 'POST', url: `/api/terminals/${a.terminalId}/close`, headers: H, payload: {} })).statusCode).toBe(200);
      // asked twice (the tab and the board both): ended once
      await srv.app.inject({ method: 'POST', url: `/api/terminals/${a.terminalId}/close`, headers: H, payload: {} });
      await new Promise((r) => setTimeout(r, 20));
      expect(killed).toHaveLength(1);
      const list = (await srv.app.inject({ url: '/api/terminals', headers: { cookie: H.cookie } })).json();
      expect(list.terminals.filter((t: { mode: string; alive: boolean }) => t.mode === 'shell' && t.alive).map((t: { terminalId: string }) => t.terminalId)).toEqual([b.terminalId]);
      expect(srv.store.getSession('s1')?.state).not.toBe('ended');
    } finally {
      await srv.close();
    }
  });
});
