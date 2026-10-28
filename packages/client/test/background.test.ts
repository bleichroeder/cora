import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { backgroundTasks, outcome } from '../src/lib/background';

let seq = 0;
const base = { sessionId: 's', agentId: 'main', icon: { name: 'x', family: 'run' as const }, source: 'transcript' as const };
const bash = (id: string, ts: number, command: string, extra: object = {}): BrainEvent => ({ ...base, seq: seq++, id: `tool:${id}:start`, ts, kind: 'tool', phase: 'start', toolUseId: id, tool: { name: 'Bash', input: { command, run_in_background: true, ...extra }, summary: command } });
const sent = (id: string, ts: number, taskId: string): BrainEvent => ({ ...base, seq: seq++, id: `tool:${id}:end`, ts, kind: 'tool', phase: 'end', toolUseId: id, tool: { name: 'Bash', input: {}, summary: '', resultSummary: 'running in background', background: { taskId, outputFile: `C:/t/${taskId}.output` } } });
const done = (taskId: string, toolUseId: string, ts: number, status: string, exit?: number): BrainEvent => ({ ...base, seq: seq++, id: `task:${taskId}`, ts, kind: 'task', toolUseId, task: { id: taskId, status, ...(exit != null ? { exit } : {}) } });

describe('backgroundTasks', () => {
  it('a background command runs until its task-notification, named by its description', () => {
    const ev = [bash('t1', 1000, 'glab ci status --live', { description: 'Poll library MR pipeline until finished' }), sent('t1', 1100, 'bpoll')];
    const [r] = backgroundTasks(ev, 5000);
    expect(r).toMatchObject({ taskId: 'bpoll', label: 'Poll library MR pipeline until finished', program: 'glab', status: 'running', endedAt: null, outputFile: 'C:/t/bpoll.output' });
    const [f] = backgroundTasks([...ev, done('bpoll', 't1', 361_000, 'completed', 0)], 400_000);
    expect(f).toMatchObject({ status: 'completed', exit: 0, endedAt: 361_000 });
    expect(outcome(f)).toBe('done in 6m');
  });

  it('a non-zero exit is a failure; TaskStop stops it; a session ending loses it', () => {
    const failed = backgroundTasks([bash('a', 0, 'npm test'), sent('a', 10, 'ba'), done('ba', 'a', 40_000, 'completed', 1)])[0];
    expect(failed.status).toBe('failed');
    expect(outcome(failed)).toBe('failed (exit 1) after 40s');
    const stop: BrainEvent = { ...base, seq: seq++, id: 'tool:s:end', ts: 5000, kind: 'tool', phase: 'end', toolUseId: 's', tool: { name: 'TaskStop', input: { task_id: 'bb' }, summary: '' } };
    expect(backgroundTasks([bash('b', 0, 'npm run dev'), sent('b', 10, 'bb'), stop])[0].status).toBe('stopped');
    const end: BrainEvent = { ...base, seq: seq++, id: 'end', ts: 9000, kind: 'session_end' };
    expect(backgroundTasks([bash('c', 0, 'tail -f x'), sent('c', 10, 'bc'), end])[0].status).toBe('lost');
  });

  it('ignores foreground commands and gives up on silent ones after 12 hours', () => {
    const fg: BrainEvent = { ...base, seq: seq++, id: 'tool:f:start', ts: 0, kind: 'tool', phase: 'start', toolUseId: 'f', tool: { name: 'Bash', input: { command: 'ls' }, summary: 'ls' } };
    expect(backgroundTasks([fg])).toEqual([]);
    expect(backgroundTasks([bash('d', 0, 'sleep 1d'), sent('d', 10, 'bd')], 13 * 3600_000)[0].status).toBe('lost');
  });
});

describe('a command you ran yourself (!) that Claude Code moved to the background', () => {
  it('is a background task from when it started, ended by its task-notification', () => {
    const tool = { name: 'Bash', input: { command: 'node scripts/package.mjs --publish' }, summary: 'node scripts/package.mjs --publish', byYou: true as const };
    const start: BrainEvent = { ...base, seq: seq++, id: 'tool:bang:u1:start', ts: 1000, kind: 'tool', phase: 'start', toolUseId: 'bang:u1', tool };
    const end: BrainEvent = { ...base, seq: seq++, id: 'tool:bang:u1:end', ts: 121_000, durationMs: 120_000, kind: 'tool', phase: 'end', toolUseId: 'bang:u1', tool: { ...tool, resultSummary: 'running in background', background: { taskId: 'b1g', outputFile: 'C:/t/b1g.output' } } };
    const [r] = backgroundTasks([start, end], 130_000);
    expect(r).toMatchObject({ key: 'bang:u1', taskId: 'b1g', label: 'node scripts/package.mjs --publish', program: 'node', startedAt: 1000, status: 'running' });
    const [f] = backgroundTasks([start, end, done('b1g', 'x:inner', 200_000, 'completed', 0)], 210_000);
    expect(f).toMatchObject({ status: 'completed', endedAt: 200_000 });
    // one that finished in time is no background task
    const quick: BrainEvent = { ...end, id: 'tool:bang:u2:end', toolUseId: 'bang:u2', tool: { ...tool, resultSummary: '1 line' } };
    expect(backgroundTasks([{ ...start, id: 'tool:bang:u2:start', toolUseId: 'bang:u2' }, quick])).toEqual([]);
  });
});

describe('only commands that asked for the background', () => {
  it('ignores an ordinary command whose output merely mentions a background task', () => {
    const start: BrainEvent = { ...base, seq: seq++, id: 'tool:g:start', ts: 0, kind: 'tool', phase: 'start', toolUseId: 'g', tool: { name: 'Bash', input: { command: 'grep -r "running in background" .' }, summary: 'grep' } };
    const end: BrainEvent = { ...base, seq: seq++, id: 'tool:g:end', ts: 10, kind: 'tool', phase: 'end', toolUseId: 'g', tool: { name: 'Bash', input: { command: 'grep -r "running in background" .' }, summary: 'grep', background: { taskId: 'bstray' } } };
    expect(backgroundTasks([start, end])).toEqual([]);
  });
});
