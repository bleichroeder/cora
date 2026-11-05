import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Seat, Team } from '@cora/shared';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';
import { PromptLog, samePrompt } from '../src/promptLanded';
import { modPreview } from '../src/app';
import { computeHooksBlock, mergeHooks } from '../src/settings';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-teams-mod-deadline-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };

/**
 * What real Claude Code does with what's typed into it: each Enter (a write of '\r' on its own) submits what was typed
 * since as a prompt, and its UserPromptSubmit hook tells Cora. Its session id comes from how it was launched.
 */
export function submits(args: string[], hook: (sid: string, prompt: string) => void): (d: string) => void {
  const at = args.indexOf('--session-id');
  const sid = at >= 0 ? args[at + 1] : '';
  let line = '';
  return (d) => {
    if (d !== '\r') return void (line += d);
    // (a new line inside is ESC Enter; a paste comes between its brackets)
    const prompt = line.replace(/\x1b\r/g, '\n').replace(/\x1b\[20[01]~/g, '').trim();
    line = '';
    if (prompt && sid) hook(sid, prompt);
  };
}

describe("a new seat whose mod hasn't come, through the app", () => {
  let srv: Running;
  /** Claude Code's prompt hook, as it calls it */
  // (a write typed after the test is over, its app closed, goes nowhere: never an error)
  const promptHook = (sid: string, prompt: string) => {
    try {
      void srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: sid, prompt, prompt_id: `p-${Date.now()}`, cwd: dir } }).catch(() => {});
    } catch {
      /* closed */
    }
  };
  const req = (method: 'GET' | 'POST', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  afterEach(async () => srv?.close());

  it('its first prompt is typed in once its terminal is ready, you are told, and what comes meanwhile goes in after it', async () => {
    const typed: string[] = [];
    // a Claude Code that draws its input box a moment after it starts, keeps what's typed into it and says each prompt
    // that comes (never a mod)
    const readyClaude = (_f: string, args: string[]) => {
      const submit = submits(args, promptHook);
      return {
        onData(cb: (d: string) => void) {
          setTimeout(() => cb(`${'─'.repeat(40)}\r\n❯ \r\n${'─'.repeat(40)}\r\n`), 20);
        },
        onExit() {},
        write: (d: string) => (typed.push(d), submit(d)),
        resize() {},
        kill() {},
      };
    };
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
    const newFolderClaude = (_file: string, args: string[], opts: { cwd?: string }) => {
      spawnedIn = opts?.cwd;
      let out: (d: string) => void = () => {};
      let yes = false;
      let asking = true;
      const submit = submits(args, promptHook);
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
          // (past the question, what's typed is a prompt)
          if (!asking) return submit(d);
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

describe('a seat\'s first prompt counts only when its prompt comes (the test PC: four seats never got theirs)', () => {
  let srv: Running;
  const req = (method: 'GET' | 'POST', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  const inbox = async (sid: string) => (await srv.app.inject({ url: `/api/mod/inbox?session=${sid}`, headers: { 'x-cora-token': 'hooktok' } })).json().items as Array<{ text: string; id: string }>;
  afterEach(async () => srv?.close());

  /** A Claude Code still starting: its box drawn, the keys taken, no prompt coming of them (and no mod, until the test says). */
  const startingClaude = (typed: string[]) => () => ({
    onData(cb: (d: string) => void) {
      setTimeout(() => cb(`${'─'.repeat(40)}\r\n❯ \r\n${'─'.repeat(40)}\r\n`), 20);
    },
    onExit() {},
    write: (d: string) => void typed.push(d),
    resize() {},
    kill() {},
  });
  const boot = async (typed: string[]) => {
    const config = loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') });
    // Cora's hooks set up: its prompts come back, so one that doesn't means something
    const claudeSettingsFile = join(dir, 'claude-settings.json');
    writeFileSync(claudeSettingsFile, JSON.stringify(mergeHooks({}, computeHooksBlock({ port: config.port, token: config.hookToken }))));
    srv = await startServer(config, { tail: false, listen: false, ci: false, security: false, spawn: startingClaude(typed) as never, pluginDir: join(dir, 'claude-plugin'), modFirstWaitMs: 50, promptLandMs: 300, claudeSettingsFile });
    const seat: Seat = { id: 'triage', name: 'Triage', instructions: 'Be triage.', agent: {}, skills: [], folder: { path: dir }, count: { min: 1, max: 1 }, startup: { prompt: 'Begin.' } };
    const team: Team = { version: 0, seats: [seat], groups: [], labels: [], routes: [], fallback: 'user', escalation: [] };
    const pid = (await req('POST', '/api/projects', { name: 'Ops' })).json().project.id as string;
    expect(srv.projects.setTeam(pid, team, 'you').ok).toBe(true);
    const sid = (await req('POST', `/api/projects/${pid}/team/bring-up`, {})).json().started[0] as string;
    return { pid, sid, team };
  };
  const until = async (ok: () => boolean, ms = 4000) => {
    for (let t = 0; t < ms && !ok(); t += 50) await new Promise((r) => setTimeout(r, 50));
  };

  it('typed in at the deadline, no prompt came of it: back for its mod, and its late hello gets it (once)', async () => {
    const typed: string[] = [];
    const { sid } = await boot(typed);
    // the deadline passes: it's typed in, and the terminal takes the keys
    await until(() => typed.join('').includes('Begin.'));
    expect(typed.join('')).toContain('Begin.');
    // no prompt comes of it (the land wait passes): its late mod's first ask has it
    await new Promise((r) => setTimeout(r, 700));
    const told = JSON.stringify(srv.inbox.list());
    expect(told).not.toContain('was typed into its terminal instead');
    expect(told).toContain('no prompt came of it');
    expect((await inbox(sid)).map((x) => x.text)).toEqual(['Begin.']);
  }, 15_000);

  it('typed in, its prompt came late (after the wait, before its mod): not given to the mod as well', async () => {
    const typed: string[] = [];
    const { sid } = await boot(typed);
    await until(() => typed.join('').includes('Begin.'));
    await new Promise((r) => setTimeout(r, 700));
    // its prompt arrives after all (Claude Code was slow to say)
    await srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: sid, prompt: 'Begin.', prompt_id: 'p1', cwd: dir } });
    const got = srv.app.inject({ url: `/api/mod/inbox?session=${sid}`, headers: { 'x-cora-token': 'hooktok' } });
    // (nothing for it: the ask waits; something new would come at once)
    const raced = await Promise.race([got.then((r) => r.json().items as unknown[]), new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 300))]);
    expect(raced).toBe('waiting');
  }, 15_000);

  it('a member being stopped is given nothing (nothing for its mod to start a turn with as it closes)', async () => {
    const typed: string[] = [];
    const { pid, sid, team } = await boot(typed);
    // its mod is here (it asks), then the team stands down: it's being stopped (this terminal never closes)
    void srv.app.inject({ url: `/api/mod/inbox?session=${sid}`, headers: { 'x-cora-token': 'hooktok' } });
    await until(() => typed.join('').includes('Begin.') || false, 200);
    await req('POST', `/api/projects/${pid}/team/stand-down`, {});
    // something for it now (its proposal rejected): not queued for its mod, not typed in
    srv.projects.setTeamProposal(pid, { team: { ...team, version: 1 }, why: 'x', by: sid, at: 5, base: 1 });
    await req('POST', `/api/projects/${pid}/team/proposal/reject`);
    const raced = await Promise.race([inbox(sid), new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 300))]);
    expect(raced).toBe('waiting');
    expect(typed.join('')).not.toContain("Your team change wasn't taken.");
  }, 15_000);
});

describe('the prompt log (promptLanded.ts)', () => {
  it('a typed prompt and the one Claude Code received are the same however spaced (and without the zero-width mark before a /)', () => {
    expect(samePrompt('Begin.', 'Begin.')).toBe(true);
    expect(samePrompt('Fix  the\nlabel', 'Fix the label')).toBe(true);
    expect(samePrompt('/jira X-1', '​/jira X-1')).toBe(true);
    expect(samePrompt('Begin.', 'Stop.')).toBe(false);
    expect(samePrompt('', 'x')).toBe(false);
  });

  it('landed: one that came since it was typed counts (not an older one, nor another session\'s); waited for a while, else not', async () => {
    let now = 1000;
    const log = new PromptLog(() => now);
    log.heard('s1', 'Begin.', 900);
    expect(log.since('s1', 1000, 'Begin.')).toBe(false);
    const wait = log.landed('s1', 1000, 'Begin.', 200);
    log.heard('s2', 'Begin.');
    now = 1050;
    log.heard('s1', 'Begin.');
    expect(await wait).toBe(true);
    expect(await log.landed('s1', 2000, 'Begin.', 50)).toBe(false);
  });

  it("no hooks (none heard, none set up): no prompt ever comes back, so typed in counts as in (said once); set up, or one heard: it's waited for", async () => {
    const said: string[] = [];
    let set = false;
    const log = new PromptLog(Date.now, { hooksSet: () => set, log: (m) => said.push(m) });
    expect(await log.landed('s1', 0, 'Begin.', 5_000)).toBe(true);
    expect(await log.landed('s2', 0, 'Begin.', 5_000)).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/can't be seen to land/);
    set = true;
    expect(await log.landed('s1', 0, 'Begin.', 20)).toBe(false);
    // one heard (whatever the settings say): prompts come back
    set = false;
    log.heard('s9', 'hi');
    expect(await log.landed('s1', 0, 'Begin.', 20)).toBe(false);
  });

  it("the mod-events trace says what each queued item is: its first few words, never all of them", () => {
    expect(modPreview('Begin.')).toBe('Begin.');
    expect(modPreview('Watch the encoders.\nCheck each feed in turn and write down what you see.')).toBe('Watch the encoders. Check each …');
  });
});
