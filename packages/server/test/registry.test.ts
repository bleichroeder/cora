import { describe, expect, it } from 'vitest';
import type { BrainEvent, NewEvent } from '@cora/shared';
import { Store } from '../src/store';
import { Registry } from '../src/registry';

let seq = 0;
const E = (o: Partial<NewEvent> & Pick<NewEvent, 'id' | 'kind'>): BrainEvent => ({
  sessionId: 's1', agentId: 'main', ts: 1000, icon: { name: 'x', family: 'mind' }, source: 'transcript', seq: ++seq, ...o,
});
const agentSpawn = (toolUseId: string, prompt: string, description: string, ts = 1000) => [
  E({ id: `tool:${toolUseId}:start`, kind: 'tool', phase: 'start', toolUseId, ts, tool: { name: 'Agent', input: { prompt, description, subagent_type: 'Explore' }, summary: description } }),
  E({ id: `spawn:${toolUseId}`, kind: 'spawn', toolUseId, ts, text: description }),
];

function setup() {
  const store = new Store(':memory:');
  const changes: any[] = [];
  const reg = new Registry(store, (c) => changes.push(c));
  return { store, reg, changes };
}

describe('Registry agent tree', () => {
  it('links a child by explicit link (Agent tool result)', () => {
    const { store, reg } = setup();
    agentSpawn('t1', 'Check docs', 'Verify hooks').forEach((e) => reg.ingest(e));
    reg.ingest(E({ id: 'x1', kind: 'tool', phase: 'start', agentId: 'a1', toolUseId: 'k1', ts: 1100 }));
    expect(store.getAgent('s1', 'a1')?.parentAgentId).toBe('main');
    reg.linkChild('s1', { toolUseId: 't1', childAgentId: 'a1', description: 'Verify hooks', prompt: 'Check docs' });
    expect(store.getAgent('s1', 'a1')).toMatchObject({ parentAgentId: 'main', parentToolUseId: 't1', label: 'Verify hooks' });
  });

  it('links a child by matching its first prompt to a pending spawn', () => {
    const { store, reg } = setup();
    agentSpawn('t1', 'Scan transcripts please', 'Scan transcripts').forEach((e) => reg.ingest(e));
    agentSpawn('t2', 'Check docs', 'Verify hooks').forEach((e) => reg.ingest(e));
    reg.ingest(E({ id: 'p', kind: 'prompt', agentId: 'a2', text: 'Check docs', ts: 1050 }));
    expect(store.getAgent('s1', 'a2')).toMatchObject({ parentToolUseId: 't2', label: 'Verify hooks' });
  });

  it('prompt match still links when hook events created the agent first', () => {
    const { store, reg } = setup();
    agentSpawn('t3', 'Count lines', 'Counter').forEach((e) => reg.ingest(e));
    agentSpawn('t4', 'Other task', 'Other').forEach((e) => reg.ingest(e));
    reg.ingest(E({ id: 'h1', kind: 'tool', phase: 'start', agentId: 'a5', toolUseId: 'z', source: 'hook' }));
    reg.ingest(E({ id: 'p5', kind: 'prompt', agentId: 'a5', text: 'Other task' }));
    expect(store.getAgent('s1', 'a5')).toMatchObject({ parentToolUseId: 't4', label: 'Other' });
  });

  it('SubagentStart provisionally links FIFO by agent type', () => {
    const { store, reg } = setup();
    agentSpawn('t1', 'A', 'First').forEach((e) => reg.ingest(e));
    reg.agentStarted('s1', 'a9', 'Explore', 1001);
    expect(store.getAgent('s1', 'a9')).toMatchObject({ parentToolUseId: 't1', label: 'First', agentType: 'Explore' });
  });

  it('nested subagents get their spawning agent as parent', () => {
    const { store, reg } = setup();
    reg.ingest(E({ id: 'tool:t5:start', kind: 'tool', phase: 'start', agentId: 'a1', toolUseId: 't5', tool: { name: 'Agent', input: { prompt: 'deep', description: 'Deeper' }, summary: 'Deeper' } }));
    reg.linkChild('s1', { toolUseId: 't5', childAgentId: 'a7' });
    expect(store.getAgent('s1', 'a7')?.parentAgentId).toBe('a1');
  });
});

describe('Registry states', () => {
  it('tool start → working, end → thinking, turn end → idle', () => {
    const { store, reg } = setup();
    reg.ingest(E({ id: 'p', kind: 'prompt', ts: 1000 }));
    expect(store.getSession('s1')?.state).toBe('thinking');
    reg.ingest(E({ id: 'tool:t:start', kind: 'tool', phase: 'start', toolUseId: 't', ts: 1001 }));
    expect(store.getSession('s1')?.state).toBe('working');
    expect(store.getAgent('s1', 'main')?.state).toBe('working');
    reg.ingest(E({ id: 'tool:t:end', kind: 'tool', phase: 'end', toolUseId: 't', ts: 1002 }));
    expect(store.getSession('s1')?.state).toBe('thinking');
    reg.ingest(E({ id: 'te', kind: 'turn_end', ts: 1003 }));
    expect(store.getSession('s1')?.state).toBe('idle');
  });

  it('a running subagent keeps the session working after main turn ends', () => {
    const { store, reg } = setup();
    reg.ingest(E({ id: 'tool:k:start', kind: 'tool', phase: 'start', agentId: 'a1', toolUseId: 'k' }));
    reg.turnEnded('s1', 1005);
    expect(store.getSession('s1')?.state).toBe('working');
    reg.agentStopped('s1', 'a1', 1006);
    expect(store.getAgent('s1', 'a1')).toMatchObject({ state: 'done', endedAt: 1006 });
  });

  it('pending requests override to needs-you', () => {
    const { store, reg } = setup();
    reg.ingest(E({ id: 'p', kind: 'prompt' }));
    reg.setPendingCount('s1', 1);
    expect(store.getSession('s1')).toMatchObject({ state: 'needs-you', needsYou: 1 });
    reg.setPendingCount('s1', 0);
    expect(store.getSession('s1')?.state).toBe('thinking');
  });

  it('silence > 10 min turns a thinking session idle', () => {
    const { store, reg } = setup();
    reg.ingest(E({ id: 'p', kind: 'prompt', ts: 1000 }));
    reg.tick(1000 + 11 * 60_000);
    expect(store.getSession('s1')?.state).toBe('idle');
    expect(store.getAgent('s1', 'main')?.state).toBe('idle');
  });

  it("a session with a live terminal in Cora isn't ended by silence; one this rule ended comes back", () => {
    const store = new Store(':memory:');
    let live = true;
    const reg = new Registry(store, () => {}, { hosted: () => live });
    reg.ingest(E({ id: 'p', kind: 'prompt', ts: 1000 }));
    reg.tick(1000 + 31 * 60_000);
    expect(store.getSession('s1')?.state).not.toBe('ended');
    // its terminal closed: silence ends it as before
    live = false;
    reg.tick(1000 + 32 * 60_000);
    expect(store.getSession('s1')?.state).toBe('ended');
    // open again in Cora (resumed, nothing said yet): back from what silence did
    live = true;
    reg.tick(1000 + 33 * 60_000);
    expect(store.getSession('s1')?.state).toBe('idle');
    // a session Claude Code ended stays ended while its terminal lingers
    reg.ingest(E({ id: 'se', kind: 'session_end', ts: 1000 + 34 * 60_000 }));
    reg.tick(1000 + 35 * 60_000);
    expect(store.getSession('s1')?.state).toBe('ended');
  });

  it('session_end → ended; silence > 30 min → ended', () => {
    const { store, reg } = setup();
    reg.ingest(E({ id: 'p', kind: 'prompt', ts: 1000 }));
    reg.tick(1000 + 31 * 60_000);
    expect(store.getSession('s1')?.state).toBe('ended');
    reg.ingest(E({ id: 'p2', kind: 'prompt', ts: 2_000_000_000, sessionId: 's2' }));
    reg.ingest(E({ id: 'se', kind: 'session_end', ts: 2_000_000_001, sessionId: 's2' }));
    expect(store.getSession('s2')?.state).toBe('ended');
  });

  it('an interrupt makes a working session idle', () => {
    const { store, reg } = setup();
    reg.ingest(E({ id: 'tool:t:start', kind: 'tool', phase: 'start', toolUseId: 't' }));
    expect(store.getSession('s1')?.state).toBe('working');
    reg.ingest(E({ id: 'int', kind: 'interrupt', ts: 1001 }));
    expect(store.getSession('s1')?.state).toBe('idle');
  });

  it('a hosted exit ends the session at once; new activity revives it', () => {
    const { store, reg } = setup();
    reg.ingest(E({ id: 'p', kind: 'prompt', ts: 1000 }));
    reg.sessionExited('s1', 2000);
    expect(store.getSession('s1')).toMatchObject({ state: 'ended', exitReason: 'exited' });
    reg.ingest(E({ id: 'p2', kind: 'prompt', ts: 3000 }));
    expect(store.getSession('s1')).toMatchObject({ state: 'thinking', exitReason: null });
  });

  it("catching up on a session's transcript after it ended doesn't revive it (only newer activity does)", () => {
    const { store, reg } = setup();
    reg.ingest(E({ id: 'p', kind: 'prompt', ts: 1000 }));
    // Cora starts: the hosted terminal is found dead, then the transcript's last lines are read
    reg.sessionExited('s1', 5000);
    reg.ingest(E({ id: 'tool:old:start', kind: 'tool', phase: 'start', toolUseId: 'old', ts: 1500 }));
    reg.ingest(E({ id: 'p-old', kind: 'prompt', ts: 1600 }));
    expect(store.getSession('s1')).toMatchObject({ state: 'ended', exitReason: 'exited' });
    reg.ingest(E({ id: 'p-new', kind: 'prompt', ts: 6000 }));
    expect(store.getSession('s1')).toMatchObject({ state: 'thinking', exitReason: null });
  });

  it('a session that ended stays ended when Cora restarts and catches up on its transcript', () => {
    const store = new Store(':memory:');
    const first = new Registry(store, () => {});
    // one that ended (its hook said so) and was then wrongly shown idle by an older Cora; one that's just over
    for (const e of [E({ id: 'p', kind: 'prompt', ts: 1000 }), E({ id: 'se', kind: 'session_end', ts: 2000 })]) store.upsertEvent(e), first.ingest(e);
    store.upsertSession({ id: 's1', state: 'idle' });
    first.ingest(E({ id: 'q', kind: 'prompt', ts: 1000, sessionId: 's2' }));
    first.sessionExited('s2', 3000);
    const again = new Registry(store, () => {});
    expect(store.getSession('s1')?.state).toBe('ended');
    again.ingest(E({ id: 'tool:t:start', kind: 'tool', phase: 'start', toolUseId: 't', ts: 1500 }));
    again.ingest(E({ id: 'q2', kind: 'prompt', ts: 1100, sessionId: 's2' }));
    expect(store.getSession('s1')?.state).toBe('ended');
    expect(store.getSession('s2')?.state).toBe('ended');
    // its dead terminal, found again: its last activity stays put
    again.sessionExited('s2', 9000);
    expect(store.getSession('s2')?.lastTs).toBe(3000);
  });

  it('a session launched (resumed) from Cora is live at once, so quitting it right away still ends it', () => {
    const { store, reg, changes } = setup();
    reg.ingest(E({ id: 'p', kind: 'prompt', ts: 1000 }));
    reg.ingest(E({ id: 't', kind: 'turn_end', ts: 1100 }));
    reg.sessionExited('s1', 2000);
    expect(store.getSession('s1')?.state).toBe('ended');
    reg.sessionLaunched('s1', 5000);
    expect(store.getSession('s1')).toMatchObject({ state: 'idle', lastTs: 5000, exitReason: null });
    expect(changes.at(-1)?.session?.state).toBe('idle');
    reg.sessionExited('s1', 5200);
    expect(store.getSession('s1')?.state).toBe('ended');
  });

  it('notifies on session and agent changes', () => {
    const { reg, changes } = setup();
    reg.ingest(E({ id: 'p', kind: 'prompt' }));
    expect(changes.some((c) => c.session?.id === 's1')).toBe(true);
    expect(changes.some((c) => c.agent?.agentId === 'main')).toBe(true);
  });
});
