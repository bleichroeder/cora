import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';
import { Store } from '../src/store';

const cfg = () => loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-ph-')), dbPath: ':memory:', hookToken: 'h', uiToken: 'u', clientDir: join(tmpdir(), 'nope-client') });
let srv: Running | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const base = { session_id: 's1', cwd: 'C:\\code\\x', transcript_path: 'C:\\t\\s1.jsonl' };

describe("Claude Code's hidden helpers", () => {
  it('a SubagentStop with no start (e.g. the next-prompt suggestion) creates no agent and no report', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    srv.pipeline.ingestHook('SubagentStop', { ...base, hook_event_name: 'SubagentStop', agent_id: 'a0d95b50493162', last_assistant_message: "let's start on the shell tabs" });
    expect(srv.store.listAgents('s1').filter((a) => a.agentId !== 'main')).toEqual([]);
    expect(srv.store.eventsForSession('s1').filter((e) => e.kind === 'report')).toEqual([]);
  });

  it('a real subagent (started, then stopped) still gets its lifecycle and report', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    srv.pipeline.ingestHook('SubagentStart', { ...base, hook_event_name: 'SubagentStart', agent_id: 'real1', agent_type: 'Explore' });
    srv.pipeline.ingestHook('SubagentStop', { ...base, hook_event_name: 'SubagentStop', agent_id: 'real1', agent_type: 'Explore', last_assistant_message: 'Found 3 tests.' });
    expect(srv.store.getAgent('s1', 'real1')).toMatchObject({ agentType: 'Explore', state: 'done' });
    expect(srv.store.eventsForSession('s1').some((e) => e.kind === 'report' && e.text === 'Found 3 tests.')).toBe(true);
  });
});

describe('purgePhantomAgents', () => {
  it('removes only zero-lifetime, parentless, report-only "subagent" records', () => {
    const s = new Store(':memory:');
    const ev = (agentId: string, kind: 'report' | 'say', id: string) =>
      s.upsertEvent({ id, sessionId: 's1', agentId, ts: 5, kind, icon: { name: 'x', family: 'delegate' }, source: 'hook', text: 't' });
    s.upsertAgent({ sessionId: 's1', agentId: 'phantom', agentType: 'subagent', label: 'phantom', parentToolUseId: null, startedAt: 5, endedAt: 5, state: 'done' });
    ev('phantom', 'report', 'r1');
    s.upsertAgent({ sessionId: 's1', agentId: 'real', agentType: 'Explore', label: 'Explore', parentToolUseId: 'tu1', startedAt: 1, endedAt: 9, state: 'done' });
    ev('real', 'report', 'r2');
    s.upsertAgent({ sessionId: 's1', agentId: 'quick', agentType: 'subagent', label: 'quick', parentToolUseId: null, startedAt: 5, endedAt: 5, state: 'done' });
    ev('quick', 'say', 'q1'); // it said something: not a phantom
    expect(s.purgePhantomAgents()).toBe(1);
    expect(s.listAgents('s1').map((a) => a.agentId).sort()).toEqual(['quick', 'real']);
    expect(s.eventsForSession('s1').map((e) => e.id).sort()).toEqual(['q1', 'r2']);
  });
});
