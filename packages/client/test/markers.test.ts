import { describe, expect, it } from 'vitest';
import type { BrainEvent, PendingRequest } from '@cora/shared';
import { markersFrom } from '../src/lib/markers';
import { requestSummary, trackWaits, type Wait } from '../src/lib/waits';

const NOW = 5_000_000;
const base = { seq: 1, sessionId: 's', agentId: 'main', icon: { name: 'x', family: 'look' as const }, source: 'transcript' as const };
const ev = (id: string, ts: number, extra: Partial<BrainEvent>): BrainEvent => ({ ...base, id, ts, kind: 'say', ...extra });
const call = (id: string, ts: number, phase: 'start' | 'end', name: string, input: unknown, tool: object = {}, extra: Partial<BrainEvent> = {}): BrainEvent =>
  ev(`${id}:${phase}`, ts, { kind: 'tool', phase, toolUseId: id, tool: { name, input, summary: '', ...tool }, ...extra });
const req = (id: string, createdAt: number, extra: Partial<PendingRequest> = {}): PendingRequest => ({
  id, kind: 'permission', sessionId: 's', agentId: 'main', toolName: 'Bash', toolInput: { command: 'docker push x' }, toolUseId: `tu-${id}`, createdAt, expiresAt: createdAt + 60_000, ...extra,
});

describe('trackWaits', () => {
  it('opens a wait for a new request and closes it when the request goes away', () => {
    let w: Wait[] = trackWaits([], [req('a', 100)], 150);
    expect(w).toEqual([{ id: 'a', sessionId: 's', agentId: 'main', kind: 'permission', toolName: 'Bash', toolUseId: 'tu-a', summary: 'docker push x', from: 100, to: null }]);
    w = trackWaits(w, [req('a', 100), req('b', 200)], 250);
    expect(w.map((x) => [x.id, x.to])).toEqual([['a', null], ['b', null]]);
    w = trackWaits(w, [req('b', 200)], 300);
    expect(w.map((x) => [x.id, x.to])).toEqual([['a', 300], ['b', null]]);
    // closed waits stay closed when it comes up again
    expect(trackWaits(w, [], 400).map((x) => x.to)).toEqual([300, 400]);
  });
  it('returns the same list when nothing changed (no re-render)', () => {
    const w = trackWaits([], [req('a', 100)], 150);
    expect(trackWaits(w, [req('a', 100)], 160)).toBe(w);
  });
  it('sums a request up', () => {
    expect(requestSummary({ file_path: '/x/y.ts' })).toBe('/x/y.ts');
    expect(requestSummary({ questions: [{ question: 'Which DB?' }] })).toBe('Which DB?');
    expect(requestSummary(null)).toBe('');
  });
});

describe('markersFrom', () => {
  const events: BrainEvent[] = [
    ev('p1', NOW - 9000, { kind: 'prompt', text: 'ship   the\nrelease' }),
    ev('sub-p', NOW - 8900, { kind: 'prompt', agentId: 'sub1', text: 'a task' }),
    call('e1', NOW - 8000, 'start', 'Edit', { file_path: '/repo/src/a.ts' }),
    call('e1', NOW - 7900, 'end', 'Edit', { file_path: '/repo/src/a.ts' }, { change: { path: '/repo/src/a.ts', kind: 'edit', add: 3, del: 1 } }),
    call('w1', NOW - 7000, 'end', 'Write', { file_path: '/repo/new.md' }),
    call('r1', NOW - 6900, 'end', 'Read', { file_path: '/repo/README.md' }),
    call('f1', NOW - 6000, 'end', 'Bash', { command: 'npm test' }, { failed: true, resultSummary: 'exit 1' }),
    call('f2', NOW - 5900, 'end', 'Edit', { file_path: '/repo/b.ts' }, { failed: true }),
    ev('c1', NOW - 5000, { kind: 'compact' }),
    call('x1', NOW - 4000, 'start', 'mcp__cora__present', { title: 'How the tailer works', format: 'markdown', content: '#' }),
    call('x1', NOW - 3900, 'end', 'mcp__cora__present', { title: 'How the tailer works' }),
    call('q1', NOW - 3500, 'start', 'AskUserQuestion', { questions: [{ question: 'Which DB?' }] }),
    call('bg', NOW - 3000, 'start', 'Bash', { command: 'npm run build', description: 'Build it', run_in_background: true }),
    call('bg', NOW - 2990, 'end', 'Bash', { command: 'npm run build', run_in_background: true }, { background: { taskId: 'T1' } }),
    ev('t1', NOW - 1000, { kind: 'task', task: { id: 'T1', status: 'completed', exit: 2 } }),
  ];
  const waits: Wait[] = [{ id: 'w', sessionId: 's', agentId: 'main', kind: 'permission', toolName: 'Bash', toolUseId: 'push', summary: 'docker push', from: NOW - 2000, to: NOW - 1500 }];
  const m = markersFrom(events, waits, NOW);
  const of = (k: string) => m.filter((x) => x.kind === k);

  it('finds every kind, in time order', () => {
    expect(m.map((x) => x.ts)).toEqual([...m.map((x) => x.ts)].sort((a, b) => a - b));
    expect(new Set(m.map((x) => x.kind))).toEqual(new Set(['prompt', 'edit', 'fail', 'compact', 'explain', 'needs', 'task']));
  });
  it('prompts: yours only (not a subagent task), whitespace folded', () => {
    expect(of('prompt')).toEqual([expect.objectContaining({ ts: NOW - 9000, eventId: 'p1', detail: 'ship the release' })]);
  });
  it('edits: successful edits and writes with their file, not reads or failed edits', () => {
    expect(of('edit').map((x) => [x.title, x.path, x.detail, x.toolUseId])).toEqual([
      ['Edited a.ts', '/repo/src/a.ts', '+3 −1 · /repo/src/a.ts', 'e1'],
      ['Wrote new.md', '/repo/new.md', '/repo/new.md', 'w1'],
    ]);
  });
  it('failures: the tool and what it said', () => {
    expect(of('fail').map((x) => [x.title, x.detail, x.toolUseId])).toEqual([
      ['Bash failed', 'exit 1', 'f1'],
      ['Edit failed', '', 'f2'],
    ]);
  });
  it('explains once per call, titled, carrying the call for the viewer', () => {
    expect(of('explain')).toHaveLength(1);
    expect(of('explain')[0]).toMatchObject({ title: 'How the tailer works', toolUseId: 'x1', ts: NOW - 4000 });
    expect(of('explain')[0].explain?.id).toBe('x1:start');
  });
  it('needs you: the waits seen (with how long) and questions asked', () => {
    expect(of('needs').map((x) => [x.title, x.detail, x.to])).toEqual([
      ['asked you a question', 'Which DB?', undefined],
      ['Bash: asked permission', 'docker push · waited 1s', NOW - 1500],
    ]);
  });
  it('background commands: when they went off and how they ended', () => {
    expect(of('task').map((x) => [x.ts, x.title, x.detail, !!x.bad])).toEqual([
      [NOW - 3000, 'In the background: Build it', 'failed (exit 2) after 2s', false],
      [NOW - 1000, 'Build it', 'failed (exit 2) after 2s', true],
    ]);
  });
  it('a question already logged as a wait shows once', () => {
    const q = markersFrom([call('q1', 10, 'start', 'AskUserQuestion', {})], [{ ...waits[0], toolUseId: 'q1', kind: 'question', from: 11 }], NOW);
    expect(q).toHaveLength(1);
    expect(q[0].key).toBe('wait:w');
  });
});
