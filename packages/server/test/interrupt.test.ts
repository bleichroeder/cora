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

describe('Esc just after a prompt went from the composer (take it back)', () => {
  const RULE = '─'.repeat(60);
  async function withScreen() {
    const writes: string[] = [];
    let draw: (d: string) => void = () => {};
    // Claude Code: Esc puts the prompt back in its input box
    let sent = '';
    const spawn = () => ({
      onData: (cb: (d: string) => void) => void (draw = cb),
      onExit() {},
      write: (d: string) => {
        writes.push(d);
        if (d === String.fromCharCode(27) && sent) draw(`${String.fromCharCode(27)}[2J${String.fromCharCode(27)}[H${['older output', RULE, `❯ ${sent}`, RULE, '  status'].join(String.fromCharCode(13, 10))}`);
      },
      resize() {},
      kill() {},
    });
    srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-recall-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope-client') }), { tail: false, listen: false, spawn });
    const r = await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'new', cwd: mkdtempSync(join(tmpdir(), 'ab-term-')) } });
    const { terminalId, sessionId } = r.json();
    const send = async (text: string) => {
      sent = text;
      return srv.app.inject({ method: 'POST', url: `/api/terminals/${terminalId}/input`, headers: H, payload: { text, submit: true } });
    };
    const stop = (recall: boolean) => srv.app.inject({ method: 'POST', url: `/api/terminals/${terminalId}/interrupt`, headers: H, payload: { key: 'esc', recall } });
    return { writes, send, stop, sessionId };
  }

  it('stops it though its state still says idle, clears it from the input box, says so, and marks the transcript', async () => {
    const { writes, send, stop, sessionId } = await withScreen();
    srv.store.upsertSession({ id: sessionId, state: 'idle' });
    expect((await send('fix the login bug')).statusCode).toBe(200);
    // (its Enter goes a beat after the text)
    await new Promise((r) => setTimeout(r, 150));
    writes.length = 0;
    expect((await stop(true)).json()).toEqual({ sent: true, recalled: 'fix the login bug' });
    expect(writes).toEqual([String.fromCharCode(27), String.fromCharCode(21)]);
    expect(srv.store.eventsForSession(sessionId).some((e) => e.kind === 'interrupt' && e.text?.startsWith('Cancelled'))).toBe(true);
  });

  it("idle, with nothing sent lately: still nothing to stop", async () => {
    const { writes, stop, sessionId } = await withScreen();
    srv.store.upsertSession({ id: sessionId, state: 'idle' });
    writes.length = 0;
    expect((await stop(true)).json()).toEqual({ sent: false, why: 'Nothing is running to stop.' });
    expect(writes).toEqual([]);
  });
});
