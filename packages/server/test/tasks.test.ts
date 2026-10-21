import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let srv: Running | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const H = { cookie: 'ab_session=uitok' };

describe('background command output', () => {
  it('tails the output file the transcript named for the task, colour codes stripped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-tasks-'));
    mkdirSync(join(dir, 'tasks'));
    const file = join(dir, 'tasks', 'bpoll1.output');
    writeFileSync(file, 'starting\n\u001b[32mstage build: ok\u001b[0m\nstage test: running\n');
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'h', uiToken: 'uitok' }), { tail: false, listen: false });
    srv.store.upsertEvent({ id: 'tool:t1:end', sessionId: 's', agentId: 'main', ts: 5, kind: 'tool', phase: 'end', toolUseId: 't1', icon: { name: 'x', family: 'run' }, source: 'transcript', tool: { name: 'Bash', input: {}, summary: 'poll', background: { taskId: 'bpoll1', outputFile: file } } });
    const r = await srv.app.inject({ url: '/api/sessions/s/tasks/bpoll1/tail', headers: H });
    expect(r.json()).toMatchObject({ lines: ['starting', 'stage build: ok', 'stage test: running'] });
    expect((await srv.app.inject({ url: '/api/sessions/s/tasks/nope/tail', headers: H })).statusCode).toBe(404);
    expect((await srv.app.inject({ url: '/api/sessions/s/tasks/bpoll1/tail' })).statusCode).toBe(401);
  });

  it('only reads a path ending in the task id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-tasks-'));
    const other = join(dir, 'secret.txt');
    writeFileSync(other, 'nope');
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'h', uiToken: 'uitok' }), { tail: false, listen: false });
    srv.store.upsertEvent({ id: 'tool:t2:end', sessionId: 's', agentId: 'main', ts: 5, kind: 'tool', phase: 'end', toolUseId: 't2', icon: { name: 'x', family: 'run' }, source: 'transcript', tool: { name: 'Bash', input: {}, summary: 'x', background: { taskId: 'bx2', outputFile: other } } });
    expect((await srv.app.inject({ url: '/api/sessions/s/tasks/bx2/tail', headers: H })).statusCode).toBe(404);
  });
});
