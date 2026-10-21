import type { BrainEvent } from '@cora/shared';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';
export type Task = { id: string; subject: string; activeForm?: string; status: TaskStatus; agentId: string };

const STATUSES = new Set<TaskStatus>(['pending', 'in_progress', 'completed']);

/**
 * Claude's task list for a session, replayed from its task tool calls in order:
 * TaskCreate { subject, activeForm } (the result says "Task #N created"), TaskUpdate { taskId, status, subject? },
 * and the older TodoWrite { todos: [{ content, status, activeForm }] }, which replaces the whole list.
 */
export function deriveTasks(events: BrainEvent[]): Task[] {
  let tasks: Task[] = [];
  const byId = new Map<string, Task>();
  const created = new Map<string, Task>(); // toolUseId → task, until its result names the id
  let seq = 0;
  for (const e of events) {
    if (e.kind !== 'tool' || !e.tool) continue;
    const name = e.tool.name;
    const inp = (e.tool.input ?? {}) as Record<string, unknown>;
    if (name === 'TodoWrite' && e.phase === 'start' && Array.isArray(inp.todos)) {
      tasks = (inp.todos as Array<Record<string, unknown>>).map((t, i) => ({
        id: `todo-${i}`,
        subject: String(t.content ?? t.subject ?? ''),
        activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
        status: STATUSES.has(t.status as TaskStatus) ? (t.status as TaskStatus) : 'pending',
        agentId: e.agentId,
      }));
      byId.clear();
      for (const t of tasks) byId.set(t.id, t);
      continue;
    }
    if (name === 'TaskCreate') {
      if (e.phase === 'start' && e.toolUseId && !created.has(e.toolUseId)) {
        // ids are per session and sequential; the result confirms the real one
        const t: Task = { id: String(++seq), subject: String(inp.subject ?? ''), activeForm: typeof inp.activeForm === 'string' ? inp.activeForm : undefined, status: 'pending', agentId: e.agentId };
        created.set(e.toolUseId, t);
        tasks.push(t);
        byId.set(t.id, t);
      } else if (e.phase === 'end' && e.toolUseId) {
        const t = created.get(e.toolUseId);
        // transcript results say "Task #3 created…"; hook results are JSON ({"task":{"id":"3",…}})
        const m = (e.tool.preview ?? '').match(/Task #(\w+) created|"id"\s*:\s*"(\w+)"/);
        const real = m?.[1] ?? m?.[2];
        if (t && real && real !== t.id) {
          byId.delete(t.id);
          t.id = real;
          byId.set(real, t);
          if (/^\d+$/.test(real)) seq = Math.max(seq, Number(real));
        }
        if (e.tool.failed && t) tasks = tasks.filter((x) => x !== t);
      }
      continue;
    }
    if (name === 'TaskUpdate' && e.phase === 'start') {
      const t = byId.get(String(inp.taskId ?? ''));
      if (!t) continue;
      if (inp.status === 'deleted') {
        tasks = tasks.filter((x) => x !== t);
        byId.delete(t.id);
        continue;
      }
      if (STATUSES.has(inp.status as TaskStatus)) t.status = inp.status as TaskStatus;
      if (typeof inp.subject === 'string' && inp.subject) t.subject = inp.subject;
      if (typeof inp.activeForm === 'string' && inp.activeForm) t.activeForm = inp.activeForm;
    }
  }
  return tasks;
}

export const taskProgress = (tasks: Task[]) => ({ done: tasks.filter((t) => t.status === 'completed').length, total: tasks.length });
