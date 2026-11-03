import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Seat, Team } from '@cora/shared';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-teams-mod-deadline-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };

describe("a new seat whose mod hasn't come, through the app", () => {
  let srv: Running;
  const req = (method: 'GET' | 'POST', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  afterEach(async () => srv?.close());

  it('its first prompt is typed in once its terminal is ready, you are told, and what comes meanwhile goes in after it', async () => {
    const typed: string[] = [];
    // a Claude Code that draws its input box a moment after it starts, and keeps what's typed into it (never a mod)
    const readyClaude = () => ({
      onData(cb: (d: string) => void) {
        setTimeout(() => cb(`${'─'.repeat(40)}\r\n❯ \r\n${'─'.repeat(40)}\r\n`), 20);
      },
      onExit() {},
      write: (d: string) => void typed.push(d),
      resize() {},
      kill() {},
    });
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, ci: false, security: false, spawn: readyClaude as never, pluginDir: join(dir, 'claude-plugin'), modFirstWaitMs: 50 });
    const seat: Seat = { id: 'triage', name: 'Triage', instructions: 'Be triage.', agent: {}, skills: [], folder: { path: dir }, count: { min: 1, max: 1 }, startup: { prompt: 'Begin.' } };
    const team: Team = { version: 0, seats: [seat], groups: [], labels: [], routes: [], fallback: 'user', escalation: [] };
    const pid = (await req('POST', '/api/projects', { name: 'Ops' })).json().project.id;
    expect(srv.projects.setTeam(pid, team, 'you').ok).toBe(true);
    const up = (await req('POST', `/api/projects/${pid}/team/bring-up`, {})).json();
    expect(up.problems).toEqual([]);
    const sid = up.started[0] as string;
    // its mod hasn't come: nothing typed while it's waited for
    expect(typed.join('')).not.toContain('Begin.');
    await new Promise((r) => setTimeout(r, 100));
    // the deadline passed and its first prompt is being typed in; its mod turns up now (it asks), and then something
    // more for it (a proposal of its, rejected): that still waits behind the first prompt, typed in after it
    const asked = srv.app.inject({ url: `/api/mod/inbox?session=${sid}`, headers: { 'x-cora-token': 'hooktok' } }).catch(() => null);
    await new Promise((r) => setTimeout(r, 30));
    srv.projects.setTeamProposal(pid, { team: { ...team, version: 1 }, why: 'x', by: sid, at: 5, base: 1 });
    await req('POST', `/api/projects/${pid}/team/proposal/reject`);
    expect(typed.join('')).not.toContain("Your team change wasn't taken.");
    for (let i = 0; i < 60 && !typed.join('').includes("Your team change wasn't taken."); i++) await new Promise((r) => setTimeout(r, 100));
    const all = typed.join('');
    expect(all.indexOf('Begin.')).toBeGreaterThanOrEqual(0);
    expect(all.indexOf("Your team change wasn't taken.")).toBeGreaterThan(all.indexOf('Begin.'));
    void asked;
    const told = JSON.stringify(srv.inbox.list());
    expect(told).toContain("Cora mod hadn't connected after 0 seconds, so what Cora had for it was typed into its terminal instead");
  }, 15_000);

  it("a question on its screen when its mod is late: the first prompt isn't lost; you're told why; its mod gets it when it comes", async () => {
    const typed: string[] = [];
    // a Claude Code asking whether to trust its folder, whose answer never takes (and never a mod, until the test says)
    const askingClaude = () => ({
      onData(cb: (d: string) => void) {
        setTimeout(() => cb(' Do you trust the files in this folder?\r\n\r\n ❯ 1. Yes, proceed\r\n   2. No, exit\r\n\r\n Enter to confirm · Esc to exit\r\n'), 20);
      },
      onExit() {},
      write: (d: string) => void typed.push(d),
      resize() {},
      kill() {},
    });
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, ci: false, security: false, spawn: askingClaude as never, pluginDir: join(dir, 'claude-plugin'), modFirstWaitMs: 50 });
    const seat: Seat = { id: 'triage', name: 'Triage', instructions: 'Be triage.', agent: {}, skills: [], folder: { path: dir }, count: { min: 1, max: 1 }, startup: { prompt: 'Begin.' } };
    const pid = (await req('POST', '/api/projects', { name: 'Ops' })).json().project.id;
    expect(srv.projects.setTeam(pid, { version: 0, seats: [seat], groups: [], labels: [], routes: [], fallback: 'user', escalation: [] }, 'you').ok).toBe(true);
    const sid = (await req('POST', `/api/projects/${pid}/team/bring-up`, {})).json().started[0] as string;
    // (waited for, not a fixed pause: under a full test run its deadline and screen come late)
    for (let i = 0; i < 50 && !JSON.stringify(srv.inbox.list()).includes("couldn't be typed"); i++) await new Promise((r) => setTimeout(r, 100));
    expect(typed.join('')).not.toContain('Begin.');
    const told = JSON.stringify(srv.inbox.list());
    expect(told).toContain("couldn't be typed into its terminal (it's asking whether to trust the folder");
    expect(told).not.toContain('was typed into its terminal instead');
    // its mod comes at last: the first prompt is there for it
    const items = (await srv.app.inject({ url: `/api/mod/inbox?session=${sid}`, headers: { 'x-cora-token': 'hooktok' } })).json().items as Array<{ text: string }>;
    expect(items.map((x) => x.text)).toEqual(['Begin.']);
  }, 15_000);

  it("its folder's trust question is answered yes at once, before its mod comes (it never does): then its first prompt is typed in", async () => {
    const typed: string[] = [];
    let spawnedIn: string | undefined;
    const RULE = '─'.repeat(40);
    // a Claude Code new to its folder: it asks whether to trust it ("No, exit" highlighted), and once told yes draws its input box
    const newFolderClaude = (_file: string, _args: string[], opts: { cwd?: string }) => {
      spawnedIn = opts?.cwd;
      let out: (d: string) => void = () => {};
      let yes = false;
      let asking = true;
      const ask = () =>
        out(`\x1b[2J\x1b[H Accessing workspace:\r\n\r\n Quick safety check: Is this a project you created or one you trust?\r\n\r\n ${yes ? '  No, exit' : '❯ No, exit'}\r\n ${yes ? '❯ Yes, I trust this folder' : '  Yes, I trust this folder'}\r\n\r\n Enter to confirm · Esc to cancel\r\n`);
      return {
        onData(cb: (d: string) => void) {
          out = cb;
          setTimeout(ask, 20);
        },
        onExit() {},
        write: (d: string) => {
          typed.push(d);
          if (!asking) return;
          if (d === '\x1b[B') {
            yes = true;
            ask();
          } else if (d === '\r') {
            asking = false;
            // "No, exit" would have ended it: only yes draws its box
            out(`\x1b[2J\x1b[H${yes ? `${RULE}\r\n❯ \r\n${RULE}\r\n` : 'exited\r\n'}`);
          }
        },
        resize() {},
        kill() {},
      };
    };
    const log = vi.spyOn(console, 'log');
    try {
      srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, ci: false, security: false, spawn: newFolderClaude as never, pluginDir: join(dir, 'claude-plugin'), modFirstWaitMs: 2_000 });
      const seat: Seat = { id: 'triage', name: 'Triage', instructions: 'Be triage.', agent: {}, skills: [], folder: { path: dir }, count: { min: 1, max: 1 }, startup: { prompt: 'Begin.' } };
      const pid = (await req('POST', '/api/projects', { name: 'Ops' })).json().project.id;
      expect(srv.projects.setTeam(pid, { version: 0, seats: [seat], groups: [], labels: [], routes: [], fallback: 'user', escalation: [] }, 'you').ok).toBe(true);
      const sid = (await req('POST', `/api/projects/${pid}/team/bring-up`, {})).json().started[0] as string;
      expect(spawnedIn).toBe(dir);
      // answered within a second or two: down to "Yes", then Enter (no words typed into the question)
      for (let i = 0; i < 40 && !typed.includes('\r'); i++) await new Promise((r) => setTimeout(r, 100));
      expect(typed.slice(0, 2)).toEqual(['\x1b[B', '\r']);
      // its mod never came: its first prompt is typed into its (now trusted) terminal
      for (let i = 0; i < 60 && !typed.join('').includes('Begin.'); i++) await new Promise((r) => setTimeout(r, 100));
      expect(typed.join('')).toContain('Begin.');
      expect(JSON.stringify(srv.inbox.list())).not.toContain('trust the folder');
      // and Cora's log says so (on the console, as the team's other lines: Fastify's logger is off)
      expect(log.mock.calls.map((c) => String(c[0]))).toContain(`[cora] team: ${sid.slice(0, 8)}'s folder trusted (${dir})`);
    } finally {
      log.mockRestore();
    }
  }, 15_000);
});
