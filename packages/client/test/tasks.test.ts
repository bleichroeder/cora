import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { deriveTasks, taskProgress } from '../src/lib/tasks';

let n = 0;
const ev = (name: string, input: unknown, phase: 'start' | 'end' = 'start', toolUseId = `t${n++}`, extra: object = {}): BrainEvent => ({
  id: `${toolUseId}:${phase}`, seq: 1, sessionId: 's', agentId: 'main', ts: n, kind: 'tool', phase, toolUseId,
  icon: { name: 'x', family: 'plan' }, source: 'transcript', tool: { name, input, summary: '', ...extra },
});

describe('deriveTasks', () => {
  it('replays TaskCreate / TaskUpdate into a list with statuses', () => {
    const events = [
      ev('TaskCreate', { subject: 'Draft issue', activeForm: 'Drafting issue' }, 'start', 'c1'),
      ev('TaskCreate', {}, 'end', 'c1', { preview: 'Task #1 created successfully: Draft issue' }),
      ev('TaskCreate', { subject: 'Open branch', activeForm: 'Opening branch' }, 'start', 'c2'),
      ev('TaskCreate', {}, 'end', 'c2', { preview: 'Task #2 created successfully: Open branch' }),
      ev('TaskUpdate', { taskId: '1', status: 'completed' }),
      ev('TaskUpdate', { taskId: '2', status: 'in_progress' }),
    ];
    const tasks = deriveTasks(events);
    expect(tasks.map((t) => [t.id, t.subject, t.status])).toEqual([['1', 'Draft issue', 'completed'], ['2', 'Open branch', 'in_progress']]);
    expect(tasks[1].activeForm).toBe('Opening branch');
    expect(taskProgress(tasks)).toEqual({ done: 1, total: 2 });
  });

  it('works before results arrive (sequential ids), and follows renames and deletes', () => {
    const tasks = deriveTasks([
      ev('TaskCreate', { subject: 'A' }),
      ev('TaskCreate', { subject: 'B' }),
      ev('TaskUpdate', { taskId: '2', subject: 'B, renamed' }),
      ev('TaskUpdate', { taskId: '1', status: 'deleted' }),
    ]);
    expect(tasks.map((t) => [t.id, t.subject])).toEqual([['2', 'B, renamed']]);
  });

  it('reads the id from hook-style JSON results too', () => {
    const tasks = deriveTasks([
      ev('TaskCreate', { subject: 'X' }, 'start', 'h1'),
      ev('TaskCreate', {}, 'end', 'h1', { preview: '{"task":{"id":"7","subject":"X"}}' }),
      ev('TaskUpdate', { taskId: '7', status: 'completed' }),
    ]);
    expect(tasks.map((t) => [t.id, t.status])).toEqual([['7', 'completed']]);
  });

  it('TodoWrite replaces the whole list', () => {
    const tasks = deriveTasks([
      ev('TaskCreate', { subject: 'old' }),
      ev('TodoWrite', { todos: [{ content: 'one', status: 'completed', activeForm: 'Doing one' }, { content: 'two', status: 'in_progress', activeForm: 'Doing two' }] }),
    ]);
    expect(tasks.map((t) => [t.subject, t.status])).toEqual([['one', 'completed'], ['two', 'in_progress']]);
  });
});
