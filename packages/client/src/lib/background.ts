import type { BrainEvent } from '@cora/shared';
import { programOf } from '../scene/programs';

export type BgStatus = 'running' | 'completed' | 'failed' | 'killed' | 'stopped' | 'lost';

/** A shell command Claude sent to the background, and how it ended. */
export type BgTask = {
  /** the Bash call's tool-use id */
  key: string;
  /** Claude Code's task id, once the call has returned */
  taskId: string | null;
  agentId: string;
  /** what Claude called it (the Bash description), else the command */
  label: string;
  command: string;
  program: string;
  startedAt: number;
  endedAt: number | null;
  status: BgStatus;
  exit?: number;
  outputFile?: string;
};

const SHELL = new Set(['Bash', 'PowerShell']);
/** A task with no word for this long is assumed gone (Claude Code exited without telling us). */
const STALE_MS = 12 * 3600_000;

const clip = (s: string, n = 60) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function statusOf(s: string, exit?: number): BgStatus {
  if (s === 'completed') return exit != null && exit !== 0 ? 'failed' : 'completed';
  if (s === 'failed' || s === 'killed' || s === 'stopped') return s;
  return 'completed';
}

const tasksCache = new WeakMap<BrainEvent[], { minute: number; tasks: BgTask[] }>();
/** Background shell commands in a session (cached per events list and minute; see backgroundTasksUncached). */
export function backgroundTasks(events: BrainEvent[], now = Date.now()): BgTask[] {
  const minute = Math.floor(now / 60_000);
  const c = tasksCache.get(events);
  if (c && c.minute === minute) return c.tasks;
  const tasks = backgroundTasksUncached(events, now);
  tasksCache.set(events, { minute, tasks });
  return tasks;
}

/**
 * Background shell commands in a session, oldest first: started by a Bash call with run_in_background, returned at
 * once with a task id, ended by Claude Code's task-notification (or a TaskStop, or the session ending).
 */
function backgroundTasksUncached(events: BrainEvent[], now: number): BgTask[] {
  const byKey = new Map<string, BgTask>();
  const byTask = new Map<string, BgTask>();
  for (const e of events) {
    if (e.kind === 'tool' && e.toolUseId && SHELL.has(e.tool?.name ?? '')) {
      const inp = (e.tool?.input ?? {}) as { command?: unknown; description?: unknown; run_in_background?: unknown };
      // only calls that asked for the background (events recorded before this rule may carry a stray `background`)
      if (inp.run_in_background !== true && !byKey.has(e.toolUseId)) continue;
      const bg = e.tool?.background;
      let t = byKey.get(e.toolUseId);
      if (!t) {
        const command = String(inp.command ?? e.tool?.summary ?? '');
        t = { key: e.toolUseId, taskId: null, agentId: e.agentId, label: clip(String(inp.description ?? '')) || clip(command), command, program: programOf(command), startedAt: e.ts, endedAt: null, status: 'running' };
        byKey.set(e.toolUseId, t);
      }
      if (e.phase !== 'end') continue;
      if (bg) {
        t.taskId = bg.taskId;
        if (bg.outputFile) t.outputFile = bg.outputFile;
        byTask.set(bg.taskId, t);
      } else if (t.endedAt == null) {
        // it never made it to the background (refused, or failed to start)
        t.endedAt = e.ts;
        t.status = e.tool?.failed ? 'failed' : 'completed';
      }
    } else if (e.kind === 'task' && e.task) {
      const t = (e.toolUseId ? byKey.get(e.toolUseId) : undefined) ?? byTask.get(e.task.id);
      if (!t || t.endedAt != null) continue;
      t.endedAt = e.ts;
      t.exit = e.task.exit;
      t.status = statusOf(e.task.status, e.task.exit);
      t.taskId ??= e.task.id;
      if (!t.outputFile && e.task.outputFile) t.outputFile = e.task.outputFile;
    } else if (e.kind === 'tool' && e.phase === 'end' && e.tool?.name === 'TaskStop' && !e.tool.failed) {
      const t = byTask.get(String((e.tool.input as { task_id?: unknown; shell_id?: unknown } | undefined)?.task_id ?? (e.tool.input as { shell_id?: unknown } | undefined)?.shell_id ?? ''));
      if (t && t.endedAt == null) {
        t.endedAt = e.ts;
        t.status = 'stopped';
      }
    } else if (e.kind === 'session_end') {
      // background commands don't outlive their Claude Code process
      for (const t of byKey.values())
        if (t.endedAt == null && t.startedAt < e.ts) {
          t.endedAt = e.ts;
          t.status = 'lost';
        }
    }
  }
  for (const t of byKey.values())
    if (t.endedAt == null && now - t.startedAt > STALE_MS) {
      t.endedAt = t.startedAt + STALE_MS;
      t.status = 'lost';
    }
  return [...byKey.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** How long ago / how long, short: 45s, 6m, 1h 12m. */
export function shortDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** One line for a background task's outcome: "done in 6m", "failed (exit 1) after 40s", "stopped after 2m". */
export function outcome(t: BgTask): string {
  if (t.endedAt == null) return 'running';
  const d = shortDur(t.endedAt - t.startedAt);
  if (t.status === 'completed') return `done in ${d}`;
  if (t.status === 'failed') return `failed${t.exit != null ? ` (exit ${t.exit})` : ''} after ${d}`;
  if (t.status === 'lost') return 'ended with its session';
  return `${t.status} after ${d}`;
}
