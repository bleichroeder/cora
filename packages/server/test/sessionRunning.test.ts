import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';
import { buildApp } from '../src/app';
import { Hub } from '../src/hub';

const UI = { cookie: 'ab_session=u' };
let srv: Running | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

describe('is a session running in another terminal', () => {
  it("says whether it could look: not found is not the same as couldn't check", async () => {
    const cfg = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-run-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') });
    srv = await startServer(cfg, { tail: false, listen: false });
    srv.store.upsertSession({ id: 's1', cwd: 'C:/w', state: 'ended', lastTs: 5 });
    const ask = async (findProcess: (id: string) => Promise<number[] | null>) => {
      const app = await buildApp({ config: cfg, store: srv!.store, hub: new Hub(srv!.store, () => [], 50, () => []), pipeline: srv!.pipeline, pending: srv!.pending, projects: srv!.projects, findProcess });
      try {
        return (await app.inject({ url: '/api/sessions/s1/running', headers: UI })).json();
      } finally {
        await app.close();
      }
    };
    expect(await ask(async () => [])).toMatchObject({ hosted: false, checked: true, elsewhere: false });
    expect(await ask(async () => [42])).toMatchObject({ hosted: false, checked: true, elsewhere: true, pids: [42] });
    // the scan failed, timed out, or can't run here
    expect(await ask(async () => null)).toMatchObject({ hosted: false, checked: false, elsewhere: false });
  });

  it("ending one: a failed check stops nothing and says it couldn't tell, rather than \"it wasn't running\"", async () => {
    const cfg = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-end-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') });
    srv = await startServer(cfg, { tail: false, listen: false });
    srv.store.upsertSession({ id: 's1', cwd: 'C:/w', state: 'idle', lastTs: 5 });
    const exited: string[] = [];
    const registry = { sessionExited: (id: string) => exited.push(id), updateSessionMeta: () => {}, sessionLaunched: () => {} } as never;
    const end = async (findProcess: (id: string) => Promise<number[] | null>) => {
      const app = await buildApp({ config: cfg, store: srv!.store, hub: new Hub(srv!.store, () => [], 50, () => []), pipeline: srv!.pipeline, pending: srv!.pending, projects: srv!.projects, findProcess, registry });
      try {
        return (await app.inject({ method: 'POST', url: '/api/sessions/s1/end', headers: { ...UI, origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }, payload: '{}' })).json();
      } finally {
        await app.close();
      }
    };
    expect(await end(async () => null)).toEqual({ how: 'unknown' });
    expect(await end(async () => Promise.reject(new Error('powershell timed out')))).toEqual({ how: 'unknown' });
    expect(exited).toEqual([]);
    // looked, and it isn't there: that is "not running"
    expect(await end(async () => [])).toEqual({ how: 'none' });
  });
});
