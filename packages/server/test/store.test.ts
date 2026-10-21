import { describe, expect, it } from 'vitest';
import type { NewEvent } from '@cora/shared';
import { Store } from '../src/store';

const ev = (over: Partial<NewEvent> = {}): NewEvent => ({
  id: 'tool:t1:end', sessionId: 's1', agentId: 'main', ts: 1000, kind: 'tool', phase: 'end', toolUseId: 't1',
  icon: { name: 'FileText', family: 'look' }, source: 'hook',
  tool: { name: 'Read', input: { file_path: 'a' }, summary: 'a' }, ...over,
});

describe('Store', () => {
  it('inserts events with monotonic seq', () => {
    const s = new Store(':memory:');
    const a = s.upsertEvent(ev({ id: 'e1' }))!;
    const b = s.upsertEvent(ev({ id: 'e2' }))!;
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(s.lastSeq()).toBe(2);
  });

  it('re-inserting identical event is a no-op (returns null)', () => {
    const s = new Store(':memory:');
    s.upsertEvent(ev());
    expect(s.upsertEvent(ev())).toBeNull();
    expect(s.lastSeq()).toBe(1);
  });

  it('merges hook + transcript versions: fills fields, keeps earliest ts, source hook', () => {
    const s = new Store(':memory:');
    s.upsertEvent(ev({ ts: 1000, source: 'hook' }));
    const m = s.upsertEvent(ev({ ts: 1200, source: 'transcript', tool: { name: 'Read', input: { file_path: 'a' }, summary: 'a', resultSummary: '19 lines', preview: 'x' } }))!;
    expect(m.seq).toBe(2);
    expect(m.ts).toBe(1000);
    expect(m.source).toBe('hook');
    expect(m.tool?.resultSummary).toBe('19 lines');
    expect(s.eventsForSession('s1')).toHaveLength(1);
  });

  it('truncates very large tool input / preview', () => {
    const s = new Store(':memory:');
    const big = 'x'.repeat(20000);
    const e = s.upsertEvent(ev({ id: 'big', tool: { name: 'Write', input: { content: big }, summary: 'f', preview: big } }))!;
    expect(JSON.stringify(e.tool!.input).length).toBeLessThan(9000);
    expect(e.tool!.preview!.length).toBeLessThan(9000);
  });

  it('keeps an explain document whole (the viewer renders it from the stored input)', () => {
    const s = new Store(':memory:');
    const doc = `<!DOCTYPE html><html>${'x'.repeat(20000)}</html>`;
    const input = { title: 'Big chart', format: 'html', content: doc };
    const e = s.upsertEvent(ev({ id: 'present', tool: { name: 'mcp__cora__present', input, summary: 'Big chart' } }))!;
    expect(e.tool!.input).toEqual(input);
  });

  it('eventsSince and eventsForSession ordering/paging', () => {
    const s = new Store(':memory:');
    s.upsertEvent(ev({ id: 'a', ts: 30 }));
    s.upsertEvent(ev({ id: 'b', ts: 10 }));
    s.upsertEvent(ev({ id: 'c', ts: 20, sessionId: 's2' }));
    expect(s.eventsSince(1).map((e) => e.id)).toEqual(['b', 'c']);
    expect(s.eventsForSession('s1').map((e) => e.id)).toEqual(['b', 'a']);
    expect(s.eventsForSession('s1', { before: 30 }).map((e) => e.id)).toEqual(['b']);
  });

  it('sessions and agents upsert with partial updates', () => {
    const s = new Store(':memory:');
    s.upsertSession({ id: 's1', cwd: 'C:\\code\\proj', startedAt: 5, lastTs: 5 });
    const ss = s.upsertSession({ id: 's1', title: 'Design review', lastTs: 9 });
    expect(ss).toMatchObject({ id: 's1', cwd: 'C:\\code\\proj', project: 'proj', title: 'Design review', lastTs: 9, startedAt: 5, state: 'idle' });
    s.upsertAgent({ sessionId: 's1', agentId: 'main', label: 'main', startedAt: 5 });
    const a = s.upsertAgent({ sessionId: 's1', agentId: 'a1', parentAgentId: 'main', label: 'Scan', startedAt: 6 });
    expect(a).toMatchObject({ agentId: 'a1', parentAgentId: 'main', colorIdx: 0, state: 'thinking' });
    expect(s.listAgents('s1')).toHaveLength(2);
    expect(s.listSessions()).toHaveLength(1);
  });

  it('prune deletes old events and ended sessions', () => {
    const s = new Store(':memory:');
    s.upsertEvent(ev({ id: 'old', ts: 1 }));
    s.upsertEvent(ev({ id: 'new', ts: 10_000 }));
    expect(s.prune(5000)).toBe(1);
    expect(s.eventsForSession('s1').map((e) => e.id)).toEqual(['new']);
  });
});

describe('compacting', () => {
  it('leaves a small database alone', () => {
    expect(new Store(':memory:').compact()).toBe(false);
  });

  it("a message sent mid-turn (the hook gives it the turn's prompt id) doesn't replace the turn's prompt", () => {
    const s = new Store(':memory:');
    const p = (text: string, source: 'hook' | 'transcript') => ev({ id: 'prompt:p1', kind: 'prompt', text, source, tool: undefined, toolUseId: undefined, phase: undefined });
    s.upsertEvent(p('pick more than one profile', 'hook'));
    s.upsertEvent(p('pick more than one profile', 'transcript'));
    expect(s.upsertEvent(p('also, add a home button', 'hook'))).toBeNull();
    expect(s.eventsForSession('s1').find((e) => e.id === 'prompt:p1')?.text).toBe('pick more than one profile');
  });
});
