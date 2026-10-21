import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let srv: Running;
afterEach(async () => {
  vi.useRealTimers();
  await srv?.close();
});
const H = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };

async function hosted() {
  const writes: string[] = [];
  const spawn = () => ({ onData() {}, onExit() {}, write: (d: string) => void writes.push(d), resize() {}, kill() {} });
  srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-stop-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope-client') }), { tail: false, listen: false, spawn });
  const r = await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'new', cwd: mkdtempSync(join(tmpdir(), 'ab-term-')) } });
  const { terminalId, sessionId } = r.json();
  const stop = (key: string) => srv.app.inject({ method: 'POST', url: `/api/terminals/${terminalId}/interrupt`, headers: H, payload: { key } });
  const state = (s: 'working' | 'idle' | 'needs-you') => srv.store.upsertSession({ id: sessionId, state: s });
  return { writes, stop, state };
}

describe("stopping a session's work from the composer", () => {
  it('types Esc or Ctrl+C into its terminal while it works, and lets a second press go for a moment', async () => {
    const { writes, stop, state } = await hosted();
    state('working');
    writes.length = 0;
    expect((await stop('esc')).json()).toEqual({ sent: true });
    expect(writes).toEqual(['\x1b']);
    // pressed again at once: let go (twice could open Claude Code's rewind, or quit it)
    expect((await stop('ctrl-c')).json()).toMatchObject({ sent: false, why: 'Already stopping it.' });
    expect(writes).toEqual(['\x1b']);
    vi.useFakeTimers({ now: Date.now() + 2000, toFake: ['Date'] });
    expect((await stop('ctrl-c')).json()).toEqual({ sent: true });
    expect(writes).toEqual(['\x1b', '\x03']);
  });

  it("does nothing when nothing's running (an idle prompt), and takes only those two keys", async () => {
    const { writes, stop, state } = await hosted();
    state('idle');
    writes.length = 0;
    expect((await stop('ctrl-c')).json()).toEqual({ sent: false, why: 'Nothing is running to stop.' });
    expect((await stop('rm -rf')).statusCode).toBe(400);
    expect(writes).toEqual([]);
    state('needs-you');
    expect((await stop('esc')).json()).toEqual({ sent: true });
  });
});
