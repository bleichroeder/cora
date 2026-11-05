import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drill } from '@cora/shared/test/fixtures';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let dir: string;
let srv: Running | undefined;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-archive-'))));
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
const req = (method: 'POST' | 'GET', url: string, payload?: object) => srv!.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });

/** A Cora whose terminals are fakes: each exits on Ctrl+C, as Claude Code does; `resumed`: the sessions launched with --resume. */
async function boot() {
  const resumed: string[] = [];
  const fakeSpawn = (_file: string, args: string[]) => {
    const r = args.indexOf('--resume');
    if (r >= 0) resumed.push(args[r + 1]);
    let exit: ((e: { exitCode: number }) => void) | null = null;
    return { onData() {}, onExit: (cb: (e: { exitCode: number }) => void) => void (exit = cb), write: (d: string) => void (d === '\x03' && setTimeout(() => exit?.({ exitCode: 0 }), 10)), resize() {}, kill() {} };
  };
  const cfg = loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', projectsDir: join(dir, 'projects') });
  srv = await startServer(cfg, { tail: false, listen: false, ci: false, security: false, spawn: fakeSpawn as never });
  const pid = (await req('POST', '/api/projects', { name: 'Tags' })).json().project.id as string;
  const now = Date.now();
  // two running here (resumed into Cora's terminals), one ended a while ago
  for (const sid of ['sess-a', 'sess-b']) {
    srv.store.upsertSession({ id: sid, cwd: dir, state: 'ended', startedAt: now, lastTs: now } as never);
    expect((await req('POST', '/api/terminals', { mode: 'resume', sessionId: sid, cwd: dir })).statusCode).toBe(200);
  }
  srv.store.upsertSession({ id: 'sess-c', cwd: dir, state: 'ended', startedAt: now, lastTs: now } as never);
  for (const sid of ['sess-a', 'sess-b', 'sess-c']) await req('POST', `/api/projects/${pid}/sessions`, { sessionId: sid });
  resumed.length = 0;
  const s = srv;
  const alive = (sid: string) => !!s.ptys.forSession(sid)?.alive;
  return { pid, s, resumed, alive };
}

describe("an archived project's sessions", () => {
  it('archiving ends the running ones (it says how many); bringing it back resumes all of them, in it', async () => {
    const { pid, s, resumed, alive } = await boot();
    expect(alive('sess-a') && alive('sess-b')).toBe(true);
    expect((await req('POST', `/api/projects/${pid}/archive`, { on: true })).json()).toEqual({ ok: true, ended: 2 });
    await vi.waitFor(() => expect(alive('sess-a') || alive('sess-b')).toBe(false));
    await vi.waitFor(() => expect(s.store.getSession('sess-a')!.state).toBe('ended'));
    expect(s.projects.get(pid)!.archivedAt).toBeGreaterThan(0);
    // still its members, hidden with it
    expect(s.projects.get(pid)!.sessions).toEqual(['sess-a', 'sess-b', 'sess-c']);

    // back: every one of them resumed (the one that had ended before too), and it's back in the nav
    const back = (await req('POST', `/api/projects/${pid}/archive`, { on: false })).json();
    expect(back).toEqual({ ok: true, resumed: ['sess-a', 'sess-b', 'sess-c'] });
    expect(resumed).toEqual(['sess-a', 'sess-b', 'sess-c']);
    expect(s.projects.get(pid)!.archivedAt).toBeUndefined();
    expect(s.projects.get(pid)!.sessions).toEqual(['sess-a', 'sess-b', 'sess-c']);
  });

  it('nothing running: archived without stopping anything (no count)', async () => {
    const { pid, s } = await boot();
    for (const sid of ['sess-a', 'sess-b']) await s.app.inject({ method: 'POST', url: `/api/sessions/${sid}/end`, headers: UI, payload: {} });
    await vi.waitFor(() => expect(['sess-a', 'sess-b'].map((x) => s.store.getSession(x)!.state)).toEqual(['ended', 'ended']));
    expect((await req('POST', `/api/projects/${pid}/archive`, { on: true })).json()).toEqual({ ok: true });
  });

  it('resuming one of its sessions brings the project back too, with the rest of its sessions (and says so)', async () => {
    const { pid, s, resumed } = await boot();
    await req('POST', `/api/projects/${pid}/archive`, { on: true });
    await vi.waitFor(() => expect(s.store.getSession('sess-b')!.state).toBe('ended'));
    const r = await req('POST', '/api/terminals', { mode: 'resume', sessionId: 'sess-b', cwd: dir });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ sessionId: 'sess-b', broughtBack: { project: 'Tags', resumed: 2 } });
    expect(s.projects.get(pid)!.archivedAt).toBeUndefined();
    // it once (as asked), the other two with it
    expect([...resumed].sort()).toEqual(['sess-a', 'sess-b', 'sess-c']);
    // a session of a project that isn't archived: just resumed
    s.store.upsertSession({ id: 'sess-d', cwd: dir, state: 'ended', startedAt: Date.now(), lastTs: Date.now() } as never);
    expect((await req('POST', '/api/terminals', { mode: 'resume', sessionId: 'sess-d', cwd: dir })).json().broughtBack).toBeUndefined();
  });

  it("a team that was up stands down with it, and comes back through Bring up (its seats aren't resumed one by one)", async () => {
    const { pid, s, resumed } = await boot();
    s.projects.setTeam(pid, drill(), 'you');
    s.projects.setSeat(pid, 'sess-c', 'analyst-ing', 1);
    s.projects.setTeamUp(pid, true);
    await req('POST', `/api/projects/${pid}/archive`, { on: true });
    expect(s.projects.get(pid)).toMatchObject({ upWhenArchived: true });
    expect(s.projects.get(pid)!.teamUp).toBeUndefined();
    await vi.waitFor(() => expect(s.store.getSession('sess-b')!.state).toBe('ended'));
    const back = (await req('POST', `/api/projects/${pid}/archive`, { on: false })).json();
    // the two without a seat resumed; the seat's member left to Bring up (which can't run here: no Claude Code mods)
    expect(back).toMatchObject({ ok: true, resumed: ['sess-a', 'sess-b'], problems: [expect.stringMatching(/^Teams need Claude Code/)] });
    expect(resumed).toEqual(['sess-a', 'sess-b']);
    expect(s.projects.get(pid)!.upWhenArchived).toBeUndefined();
  });
});
