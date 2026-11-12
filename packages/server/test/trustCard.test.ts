import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let srv: Running;
afterEach(async () => void (await srv?.close()));
const H = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };
const ESC = String.fromCharCode(27);
const RULE = '─'.repeat(60);
const trustScreen = (folder: string, yes: boolean) => ['', RULE, ' Accessing workspace:', '', ` ${folder}`, '', ' Quick safety check: Is this a project you created or one you trust?', '', yes ? '   No, exit' : ' ❯ No, exit', yes ? ' ❯ Yes, I trust this folder' : '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'];
const readyScreen = ['', ' Claude Code', RULE, '❯ ', RULE, '  ? for shortcuts'];

/** A hosted Claude Code that asks whether to trust its folder: Down moves to Yes, Enter on Yes starts it. */
async function asking() {
  const writes: string[] = [];
  let draw: (d: string) => void = () => {};
  const cwd = mkdtempSync(join(tmpdir(), 'ab-trust-'));
  let on: 'no' | 'yes' | 'started' = 'no';
  const paint = () => draw(`${ESC}[2J${ESC}[H${(on === 'started' ? readyScreen : trustScreen(cwd, on === 'yes')).join(String.fromCharCode(13, 10))}`);
  const spawn = () => ({
    onData: (cb: (d: string) => void) => void (draw = cb),
    onExit() {},
    write: (d: string) => {
      writes.push(d);
      if (d === `${ESC}[B` && on === 'no') on = 'yes';
      else if (d === '\r' && on === 'yes') on = 'started';
      else return;
      setTimeout(paint, 5);
    },
    resize() {},
    kill() {},
  });
  srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-trustd-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope-client') }), { tail: false, listen: false, spawn });
  const r = await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'new', cwd } });
  const { terminalId } = r.json();
  paint();
  await new Promise((res) => setTimeout(res, 20));
  srv.ptys!.scanStatus();
  const answer = (trust: boolean) => srv.app.inject({ method: 'POST', url: `/api/terminals/${terminalId}/trust`, headers: H, payload: { trust } });
  const info = () => srv.ptys!.list().find((t) => t.terminalId === terminalId)!;
  return { writes, answer, info };
}

describe('the "trust this folder?" question, answered from the dashboard', () => {
  it("is flagged on the terminal (the composer's card and the rail show it)", async () => {
    const { info } = await asking();
    expect(info().asksTrust).toBe(true);
  });
  it('Trust: moves to Yes and confirms, and the flag goes once it has started', async () => {
    const { writes, answer, info } = await asking();
    writes.length = 0;
    expect((await answer(true)).json()).toEqual({ ok: true, answered: 'yes' });
    expect(writes).toEqual([`${ESC}[B`, '\r']);
    srv.ptys!.scanStatus();
    expect(info().asksTrust).toBeUndefined();
  });
  it("Don't start: Esc (Claude Code exits); and nothing to answer once it isn't asking", async () => {
    const { writes, answer } = await asking();
    writes.length = 0;
    expect((await answer(false)).json()).toEqual({ ok: true, answered: 'no' });
    expect(writes).toEqual([ESC]);
  });
});
