import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';
import { cleanEnv } from '../src/pty';
import { computeHooksBlock } from '../src/settings';

let dir: string;
let srv: Running | undefined;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-spawned-'))));
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const hook = (event: string, sid: string, cwd: string, headers: Record<string, string> = {}) =>
  srv!.app.inject({ method: 'POST', url: `/hook/${event}`, headers: { 'x-cora-token': 'hooktok', ...headers }, payload: { session_id: sid, cwd, hook_event_name: event, ...(event === 'SessionEnd' ? { reason: 'exit' } : {}) } });

describe('a session another one started', () => {
  it("its hooks carry its spawner's marker (who, why) from its environment, and a hosted session keeps it", () => {
    const h = computeHooksBlock({ port: 4317, token: 'tok' }).SessionStart[0].hooks[0];
    expect(h.headers).toEqual({ 'x-cora-token': 'tok', 'x-cora-spawned-by': '$CORA_SPAWNED_BY', 'x-cora-spawn-why': '$CORA_SPAWN_WHY' });
    expect(h.allowedEnvVars).toEqual(['CORA_SPAWNED_BY', 'CORA_SPAWN_WHY']);
    expect(computeHooksBlock({ port: 4317, token: 'tok', envToken: true }).Stop[0].hooks[0].allowedEnvVars).toEqual(['CORA_TOKEN', 'CORA_SPAWNED_BY', 'CORA_SPAWN_WHY']);
    // what Cora launches keeps the marker it was started with (Cora's own CORA_ variables still go)
    expect(cleanEnv({ CORA_SPAWNED_BY: 'tester', CORA_SPAWN_WHY: 'e2e', CORA_DATA_DIR: 'x' })).toMatchObject({ CORA_SPAWNED_BY: 'tester', CORA_SPAWN_WHY: 'e2e' });
    expect(cleanEnv({ CORA_DATA_DIR: 'x' }).CORA_DATA_DIR).toBeUndefined();
  });

  it('is marked from its hooks (who started it, and why); an unset marker marks nothing', async () => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    await hook('SessionStart', 'sess-kid-1', dir, { 'x-cora-spawned-by': 'sess-tester', 'x-cora-spawn-why': 'e2e: a throwaway Cora on port 4399' });
    expect(srv.store.getSession('sess-kid-1')).toMatchObject({ spawnedBy: 'sess-tester', spawnWhy: 'e2e: a throwaway Cora on port 4399' });
    // the variables unset (as the user's own sessions send them): nothing
    await hook('SessionStart', 'sess-plain-1', dir, { 'x-cora-spawned-by': '$CORA_SPAWNED_BY', 'x-cora-spawn-why': '' });
    expect(srv.store.getSession('sess-plain-1')!.spawnedBy).toBeUndefined();
    // a session can't be its own spawner
    await hook('SessionStart', 'sess-self-1', dir, { 'x-cora-spawned-by': 'sess-self-1' });
    expect(srv.store.getSession('sess-self-1')!.spawnedBy).toBeUndefined();
  });

  it('leaves the list once it has ended and its folder is cleaned up (not before)', async () => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    const root = join(dir, 'cora-e2e-1730000000');
    const work = join(root, 'work');
    mkdirSync(work, { recursive: true });
    // one marked, one only in a test root; and the user's own, in a folder that goes too
    await hook('SessionStart', 'sess-kid-1', work, { 'x-cora-spawned-by': 'sess-tester' });
    await hook('SessionStart', 'sess-kid-2', work);
    const mine = join(dir, 'mine');
    mkdirSync(mine);
    await hook('SessionStart', 'sess-mine-1', mine);
    for (const sid of ['sess-kid-1', 'sess-kid-2']) await hook('SessionEnd', sid, work);
    await hook('SessionEnd', 'sess-mine-1', mine);
    const listed = () => ['sess-kid-1', 'sess-kid-2', 'sess-mine-1'].filter((sid) => !srv!.store.getSession(sid)!.dismissedAt);
    // ended, its folder still there: still listed
    expect(srv.store.getSession('sess-kid-1')!.state).toBe('ended');
    expect(listed()).toEqual(['sess-kid-1', 'sess-kid-2', 'sess-mine-1']);
    // the test root deleted: the next session's end takes them off (yours stays)
    rmSync(root, { recursive: true, force: true });
    rmSync(mine, { recursive: true, force: true });
    await hook('SessionStart', 'sess-other', dir);
    await hook('SessionEnd', 'sess-other', dir);
    expect(listed()).toEqual(['sess-mine-1']);
  });
});
