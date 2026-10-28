import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let srv: Running;
afterEach(async () => srv?.close());

describe('a transcript read again after a restart', () => {
  it("its earlier lines teach the parser (a call's result still knows its call) but store and tell nothing", async () => {
    srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-restart-')), dbPath: ':memory:', hookToken: 'h', uiToken: 'u', clientDir: join(tmpdir(), 'nope-client') }), { tail: false, listen: false, ci: false, security: false });
    const t = new Date().toISOString();
    const call = { type: 'assistant', uuid: 'a1', timestamp: t, sessionId: 's1', cwd: 'C:\\code\\x', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] } };
    const result = { type: 'user', uuid: 'u2', timestamp: t, sessionId: 's1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'exit 1', is_error: true }] } };
    const info = { sessionId: 's1', agentId: 'main', projectSlug: 'C--code-x' };
    const before = srv.store.eventsSince(0).length;
    srv.pipeline.ingestTranscript('s1.jsonl', [call], { ...info, quiet: true });
    expect(srv.store.eventsSince(0).length).toBe(before);
    srv.pipeline.ingestTranscript('s1.jsonl', [result], info);
    const stored = srv.store.eventsSince(0).filter((e) => e.sessionId === 's1');
    expect(stored.map((e) => e.id)).toEqual(['tool:toolu_1:end']);
    expect(stored[0].tool).toMatchObject({ name: 'Bash', failed: true, summary: expect.stringContaining('npm test') });
  });
});
