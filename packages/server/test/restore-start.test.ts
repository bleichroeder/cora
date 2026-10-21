import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';
import { Store } from '../src/store';
import type { PtyBackend } from '../src/ptyhost/backend';

let srv: Running | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

/** A host that outlived the last server, holding one terminal whose Claude exited while no server was attached. */
const hostWithExitedTerminal = (sessionId: string): PtyBackend => ({
  persistent: true,
  restored: [{ id: 't1', meta: { sessionId, cwd: tmpdir(), mode: 'new', startedAt: 1 }, alive: false, exitCode: 0, buf: 'bye' }],
  spawn() {},
  write() {},
  resize() {},
  kill() {},
  onData() {},
  onExit() {},
  close: async () => {},
});

describe('starting against a terminal host', () => {
  it('a restored terminal that already exited ends its session without crashing startup', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ab-rs-'));
    const dbPath = join(dataDir, 'brain.db');
    const seed = new Store(dbPath);
    seed.upsertSession({ id: 's1', cwd: tmpdir(), startedAt: 1, lastTs: 1 });
    seed.close();

    const config = loadConfig({ dataDir, dbPath, hookToken: 'h', uiToken: 'u', clientDir: join(tmpdir(), 'nope-client') });
    srv = await startServer(config, { tail: false, listen: false, ptyBackend: hostWithExitedTerminal('s1') });
    expect(srv.store.getSession('s1')?.exitReason).toBe('exited');
  });
});
