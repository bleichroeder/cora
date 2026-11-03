import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Seat, Team } from '@cora/shared';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

/**
 * A seat's member that ended before Claude Code saved anything (it stopped at its first screen, the trust question):
 * there's nothing to resume, and resuming it only exits at once. It's started fresh in its place, through the app.
 */

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-seat-first-start-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };

describe("a seat's member that never saved a conversation", () => {
  let srv: Running;
  const req = (method: 'GET' | 'POST', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  afterEach(async () => srv?.close());

  async function setup() {
    /** each Claude Code started: its arguments, and a way to end it */
    const spawned: Array<{ args: string[]; exit(code: number): void }> = [];
    const spawn = (_file: string, args: string[]) => {
      const exits: Array<(e: { exitCode: number }) => void> = [];
      spawned.push({ args, exit: (exitCode) => exits.forEach((cb) => cb({ exitCode })) });
      return { onData() {}, onExit: (cb: (e: { exitCode: number }) => void) => void exits.push(cb), write() {}, resize() {}, kill() {} };
    };
    const projectsDir = join(dir, 'claude-projects');
    mkdirSync(projectsDir, { recursive: true });
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope'), projectsDir }), { tail: false, listen: false, ci: false, security: false, spawn: spawn as never, pluginDir: join(dir, 'claude-plugin') });
    const seat: Seat = { id: 'eng', name: 'Engineer', instructions: 'Build.', agent: {}, skills: [], folder: { path: dir }, count: { min: 1, max: 1 }, startup: { prompt: 'Begin.' } };
    const team: Team = { version: 0, seats: [seat], groups: [], labels: [], routes: [], fallback: 'user', escalation: [] };
    const pid = (await req('POST', '/api/projects', { name: 'Ops' })).json().project.id as string;
    expect(srv.projects.setTeam(pid, team, 'you').ok).toBe(true);
    const up = (await req('POST', `/api/projects/${pid}/team/bring-up`, {})).json();
    expect(up.problems).toEqual([]);
    const first = up.started[0] as string;
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toContain('--session-id');
    // it ends (exit 1, at its first screen)
    spawned[0].exit(1);
    await new Promise((r) => setTimeout(r, 20));
    return { spawned, pid, first, projectsDir };
  }

  it('is started fresh in its place (a new session), never resumed', async () => {
    const { spawned, pid, first } = await setup();
    const again = (await req('POST', `/api/projects/${pid}/team/bring-up`, {})).json();
    expect(again.problems).toEqual([]);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].args).not.toContain('--resume');
    expect(spawned[1].args).toContain('--session-id');
    const second = again.started[0] as string;
    expect(second).not.toBe(first);
    // the one that never started leaves the seat to its new member
    const p = srv.projects.get(pid)!;
    expect(p.members[second]?.seat).toBe('eng');
    expect(p.members[first]).toBeUndefined();
  }, 15_000);

  it('one that did save its conversation comes back as itself', async () => {
    const { spawned, pid, first, projectsDir } = await setup();
    mkdirSync(join(projectsDir, 'C--work'), { recursive: true });
    writeFileSync(join(projectsDir, 'C--work', `${first}.jsonl`), '{}\n');
    const again = (await req('POST', `/api/projects/${pid}/team/bring-up`, {})).json();
    expect(again.problems).toEqual([]);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].args.slice(spawned[1].args.indexOf('--resume'), spawned[1].args.indexOf('--resume') + 2)).toEqual(['--resume', first]);
    expect(again.started).toEqual([first]);
  }, 15_000);
});
