import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let srv: Running | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  delete process.env.AGENT_BRAIN_STAGE_FILE;
});

describe('startup stages for the desktop splash', () => {
  it('writes transcript backfill progress to $AGENT_BRAIN_STAGE_FILE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-st-'));
    const projects = join(dir, 'projects');
    mkdirSync(join(projects, 'C--code-x'), { recursive: true });
    for (const id of ['a1', 'b2']) writeFileSync(join(projects, 'C--code-x', `${id}.jsonl`), JSON.stringify({ type: 'user', sessionId: id, cwd: 'C:\\code\\x', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }) + '\n');
    const file = join(dir, 'stages.jsonl');
    process.env.AGENT_BRAIN_STAGE_FILE = file;

    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', projectsDir: projects, hookToken: 'h', uiToken: 'u', clientDir: join(dir, 'nope') }), { listen: false });
    await srv.close();
    srv = undefined;

    const ev = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ev[0]).toEqual({ s: 'tx', e: 'start' });
    // done: how many sessions it read, and how many are live
    expect(ev.at(-1)).toMatchObject({ s: 'tx', e: 'done', sessions: 2 });
    expect(typeof ev.at(-1).live).toBe('number');
    expect(ev.filter((x) => x.e === 'progress').every((x) => x.total === 2)).toBe(true);
  });

  it('writes nothing when the variable is unset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-st-'));
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', projectsDir: join(dir, 'none'), hookToken: 'h', uiToken: 'u', clientDir: join(dir, 'nope') }), { listen: false, tail: false });
    expect(() => readFileSync(join(dir, 'stages.jsonl'))).toThrow();
  });
});
