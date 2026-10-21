import * as THREE from 'three';
import { isPresentTool, shortToolName, type AgentInfo, type BrainEvent, type IconRef } from '@cora/shared';
import { agentColor } from '../lib/format';
import { assignSlots, nestedPos, MAIN_POS, resourceColumn, resourceLabel, slotPos, topResources } from './layout';
import { programColor, programOf } from './programs';
import { backgroundTasks, type BgStatus, type BgTask } from '../lib/background';

export const FADE_MS = 2000;
const TRAIL_MS = 10_000;
const isAgentTool = (n?: string) => n === 'Agent' || n === 'Task';

export type FileOp = 'read' | 'edit' | 'write' | 'run';
export type FileTouch = {
  name: string;
  op: FileOp;
  count: number;
  lastTs: number;
  /** full path (latest touch) */
  path?: string;
  /** edited or written this session: it has a diff */
  changed?: boolean;
  /** a program around the shell radiant (git, npm…): its colour, whether a command is running, how the last one ended */
  program?: { color: string; runningSince: number | null; failed: boolean; /** background commands of this program still running */ background: number };
};
export type Tone = 'run' | 'think' | 'idle' | 'done';

export type AgentView = {
  a: AgentInfo;
  /** who started it ('main', or the subagent that started it when that one is still on show) */
  parentId: string;
  pos: THREE.Vector3;
  color: string;
  isMain: boolean;
  name: string;
  status: { text: string; icon?: IconRef; tone: Tone };
  thinking: boolean;
  running: boolean;
  lastActivity: number;
  bornAt: number;
  diedAt: number | null;
  bubble: { text: string; at: number } | null;
  tools: number;
  /** calls in flight right now */
  busy: number;
  /** world-registry key of the resource the latest call is aimed at */
  targetKey: string | null;
};

export type CometView = { key: string; agentId: string; resource: string; file?: string; startedAt: number; endedAt: number | null; failed: boolean; color: string; resultSize: number };
export type ExplainView = { toolUseId: string; ts: number; event: BrainEvent };
export type ContextView = { used: number; max: number; compactedAt: number | null };
export type CommandView = { key: string; text: string; ts: number; live: boolean; failed: boolean; ms?: number; /** sent to the background: its task and how it's doing */ bg?: { taskId: string | null; status: BgStatus } };
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const COMMANDS_SHOWN = 5;
const COMMAND_MS = 60_000;

export type Derived = {
  agents: AgentView[];
  overflow: number;
  resources: Array<{ id: string; pos: THREE.Vector3; files: FileTouch[]; calls: number }>;
  comets: CometView[];
  live: Set<string>;
  busy: number;
  context: ContextView | null;
  explains: ExplainView[];
  /** last `say` per agent (for the speech-particle effect) */
  says: Array<{ agentId: string; id: string; ts: number }>;
  /** recent shell commands, oldest first, shown under the shell node */
  commands: CommandView[];
  /** shell commands sent to the background, oldest first */
  tasks: BgTask[];
};

const OPS: Record<string, FileOp> = { Read: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write' };

/** The file a tool call touched, when it names one (Read/Edit/Write…); Grep and Glob work on folders, so none. */
export function fileOf(e: BrainEvent): { name: string; op: FileOp; path: string } | null {
  const op = OPS[e.tool?.name ?? ''];
  const inp = e.tool?.input as { file_path?: unknown; notebook_path?: unknown } | undefined;
  const p = inp?.file_path ?? inp?.notebook_path;
  if (!op || typeof p !== 'string' || !p) return null;
  return { name: p.split(/[\\/]/).filter(Boolean).pop() ?? p, op, path: p };
}

/** Context window size: the 1M variants say so in the model id; anything past 200k must be one too. */
export function contextMax(model: string | undefined, peak: number): number {
  return /\[1m\]/i.test(model ?? '') || peak > 200_000 ? 1_000_000 : 200_000;
}

const MAX_FILES = 10;

export function derive(events: BrainEvent[], agents: AgentInfo[], slots: Map<string, number>, now: number, model?: string): Derived & { slots: Map<string, number> } {
  const open = new Map<string, BrainEvent>();
  const ended = new Map<string, { start: BrainEvent; end: BrainEvent }>();
  const lastAct = new Map<string, number>();
  const lastSay = new Map<string, BrainEvent>();
  const toolCount = new Map<string, number>();
  const files = new Map<string, Map<string, FileTouch & { first: number }>>();
  const calls = new Map<string, number>();
  const explains = new Map<string, ExplainView>();
  const shellStarts: BrainEvent[] = [];
  const endOf = new Map<string, BrainEvent>();
  /** shell call → the program it ran */
  const progOf = new Map<string, string>();
  let ctxUsed = 0;
  let ctxAt = 0;
  let peak = 0;
  let compactedAt: number | null = null;

  for (const e of events) {
    lastAct.set(e.agentId, Math.max(lastAct.get(e.agentId) ?? 0, e.ts));
    if (e.kind === 'say') lastSay.set(e.agentId, e);
    if (e.agentId === 'main' && e.tokens) {
      const used = e.tokens.in + e.tokens.out;
      peak = Math.max(peak, used);
      if (e.ts >= ctxAt) {
        ctxUsed = used;
        ctxAt = e.ts;
      }
    }
    if (e.kind === 'compact' && e.agentId === 'main') compactedAt = Math.max(compactedAt ?? 0, e.ts);
    if (e.kind !== 'tool' || !e.toolUseId || isAgentTool(e.tool?.name)) continue;
    if (isPresentTool(e.tool?.name) && !explains.has(e.toolUseId)) explains.set(e.toolUseId, { toolUseId: e.toolUseId, ts: e.ts, event: e });
    if (e.phase === 'start') {
      open.set(e.toolUseId, e);
      if (SHELL_TOOLS.has(e.tool?.name ?? '')) shellStarts.push(e);
      toolCount.set(e.agentId, (toolCount.get(e.agentId) ?? 0) + 1);
      const r = e.tool?.resource;
      if (r) {
        calls.set(r, (calls.get(r) ?? 0) + 1);
        // shell commands: a droplet per program (git, npm, node…)
        if (r === 'shell' && SHELL_TOOLS.has(e.tool?.name ?? '')) {
          const prog = programOf(String((e.tool?.input as { command?: unknown } | undefined)?.command ?? e.tool?.summary ?? ''));
          const m = files.get(r) ?? new Map();
          files.set(r, m);
          const t = m.get(prog) ?? { name: prog, op: 'run' as FileOp, count: 0, lastTs: 0, first: e.ts, program: { color: programColor(prog), runningSince: null, failed: false, background: 0 } };
          t.count++;
          t.lastTs = e.ts;
          progOf.set(e.toolUseId, prog);
          m.set(prog, t);
        }
        const f = fileOf(e);
        if (f) {
          const m = files.get(r) ?? new Map();
          files.set(r, m);
          const t = m.get(f.name) ?? { name: f.name, op: f.op, count: 0, lastTs: 0, first: e.ts };
          t.count++;
          t.op = f.op;
          t.lastTs = e.ts;
          t.path = f.path;
          if (f.op !== 'read') t.changed = true;
          m.set(f.name, t);
        }
      }
    } else {
      endOf.set(e.toolUseId, e);
      const prog = progOf.get(e.toolUseId);
      if (prog) {
        const t = files.get('shell')?.get(prog);
        if (t?.program) t.program.failed = Boolean(e.tool?.failed);
      }
      const s = open.get(e.toolUseId);
      open.delete(e.toolUseId);
      if (s && now - e.ts < TRAIL_MS) ended.set(e.toolUseId, { start: s, end: e });
    }
  }
  for (const [id, e] of open) if (now - e.ts > 30 * 60_000) open.delete(id);

  const visible = agents.filter((a) => a.agentId === 'main' || a.state !== 'done' || (a.endedAt != null && now - a.endedAt < FADE_MS));
  const subs = visible.filter((a) => a.agentId !== 'main').sort((x, y) => x.startedAt - y.startedAt);
  // main's subagents take the column's slots; one started by another subagent sits beside that parent
  const shownIds = new Set(visible.map((a) => a.agentId));
  const parentOf = (a: AgentInfo) => (a.parentAgentId && a.parentAgentId !== 'main' && a.parentAgentId !== a.agentId && shownIds.has(a.parentAgentId) ? a.parentAgentId : 'main');
  const direct = subs.filter((a) => parentOf(a) === 'main');
  const nextSlots = assignSlots(slots, direct.map((a) => a.agentId));
  const posOf = new Map<string, THREE.Vector3>([['main', new THREE.Vector3(MAIN_POS.x, MAIN_POS.y, 0)]]);
  let overflow = 0;
  for (const a of direct) {
    const slot = nextSlots.get(a.agentId) ?? -1;
    if (slot < 0) overflow++;
    else {
      const p = slotPos(slot);
      posOf.set(a.agentId, new THREE.Vector3(p.x, p.y, 0));
    }
  }
  // a parent always started before its children, so it's placed first; each keeps clear of everyone placed so far
  for (const a of subs) {
    const parent = parentOf(a);
    if (parent === 'main') continue;
    const pp = posOf.get(parent);
    if (!pp) {
      overflow++;
      continue;
    }
    const n = nestedPos(pp, [...posOf.values()]);
    posOf.set(a.agentId, new THREE.Vector3(n.x, n.y, 0));
  }

  const resIds = topResources(events.filter((e) => now - e.ts < 15 * 60_000));
  const column = resourceColumn(resIds);
  // programs with a command still running
  for (const [id, st] of open) {
    const prog = progOf.get(id);
    const t = prog ? files.get('shell')?.get(prog) : undefined;
    if (t?.program) t.program.runningSince = st.ts;
  }
  // background commands: their program's droplet keeps running until Claude Code says the task ended
  const tasks = backgroundTasks(events, now);
  const bgOf = new Map(tasks.map((t) => [t.key, t]));
  for (const t of tasks) {
    const p = files.get('shell')?.get(t.program)?.program;
    if (!p) continue;
    if (t.endedAt == null) {
      p.runningSince = Math.min(p.runningSince ?? Infinity, t.startedAt);
      p.background++;
    } else if (t.endedAt >= (files.get('shell')?.get(t.program)?.lastTs ?? 0)) p.failed = t.status === 'failed';
  }
  const resources = [...column].map(([id, p]) => {
    // the most-used files, kept in first-seen order so each keeps its orbit
    const all = [...(files.get(id)?.values() ?? [])];
    const top = new Set(all.sort((a, b) => b.count - a.count || b.lastTs - a.lastTs).slice(0, MAX_FILES));
    const list = all.filter((f) => top.has(f)).sort((a, b) => a.first - b.first).map(({ first: _first, ...f }) => f);
    return { id, pos: new THREE.Vector3(p.x, p.y, 0), files: list, calls: calls.get(id) ?? 0 };
  });
  const shown = new Set(column.keys());

  const comets: CometView[] = [];
  const live = new Set<string>();
  const pushComet = (start: BrainEvent, end: BrainEvent | null) => {
    const r = start.tool?.resource;
    if (!r || !shown.has(r) || !posOf.has(start.agentId)) return;
    if (!end) live.add(r);
    const a = agents.find((x) => x.agentId === start.agentId);
    comets.push({
      key: start.toolUseId!,
      agentId: start.agentId,
      resource: r,
      file: fileOf(start)?.name ?? progOf.get(start.toolUseId!),
      startedAt: start.ts,
      endedAt: end ? end.ts : null,
      failed: Boolean(end?.tool?.failed),
      color: agentColor(a),
      resultSize: (end?.tool?.preview ?? '').length,
    });
  };
  for (const s of open.values()) pushComet(s, null);
  for (const { start, end } of ended.values()) pushComet(start, end);

  const subsAlive = subs.some((a) => a.state !== 'done');
  let busy = 0;
  const out: AgentView[] = [];
  for (const a of visible) {
    const pos = posOf.get(a.agentId);
    if (!pos) continue;
    const running = [...open.values()].filter((e) => e.agentId === a.agentId);
    const cur = running[running.length - 1];
    // "working" with nothing in flight is Claude generating between calls (e.g. writing out a long tool input
    // before the call starts): that's thinking, as the live-activity row shows it, not idle
    const thinking = !cur && (a.state === 'thinking' || a.state === 'working');
    busy += running.length + (thinking ? 0.5 : 0);
    let status: AgentView['status'];
    if (a.state === 'done') status = { text: 'done', tone: 'done' };
    else if (cur?.tool && SHELL_TOOLS.has(cur.tool.name) && cur.tool.summary) status = { text: `$ ${cur.tool.summary}`, icon: cur.icon, tone: 'run' };
    else if (cur?.tool) status = { text: `${shortToolName(cur.tool.name)}${cur.tool.resource ? ` → ${resourceLabel(cur.tool.resource)}` : ''}`, icon: cur.icon, tone: 'run' };
    else if (a.agentId === 'main' && subsAlive && a.state !== 'working') status = { text: 'waiting on subagents', tone: 'idle' };
    else if (thinking) status = { text: 'thinking…', tone: 'think' };
    else status = { text: 'idle', tone: 'idle' };
    const say = lastSay.get(a.agentId);
    out.push({
      a,
      parentId: a.agentId === 'main' ? 'main' : parentOf(a),
      pos,
      color: agentColor(a),
      isMain: a.agentId === 'main',
      name: a.agentId === 'main' ? 'main' : a.label,
      status,
      thinking,
      running: running.length > 0,
      lastActivity: lastAct.get(a.agentId) ?? a.startedAt,
      bornAt: a.agentId === 'main' ? 0 : a.startedAt,
      diedAt: a.state === 'done' ? a.endedAt ?? now : null,
      bubble: say ? { text: (say.text ?? '').slice(0, 600), at: say.ts } : null,
      tools: toolCount.get(a.agentId) ?? 0,
      busy: running.length,
      targetKey: cur?.tool?.resource && shown.has(cur.tool.resource) ? `res:${cur.tool.resource}` : null,
    });
  }

  const context: ContextView | null = ctxAt ? { used: compactedAt != null && compactedAt > ctxAt ? 0 : ctxUsed, max: contextMax(model, peak), compactedAt } : null;
  return {
    agents: out,
    overflow,
    resources,
    comets: comets.slice(-40),
    live,
    busy,
    context,
    explains: [...explains.values()].sort((a, b) => a.ts - b.ts),
    says: [...lastSay.values()].map((e) => ({ agentId: e.agentId, id: e.id, ts: e.ts })),
    commands: tape(shellStarts, open, endOf, bgOf, now),
    tasks,
    slots: nextSlots,
  };
}

/**
 * The shell tape: the last few commands that ran within a minute or are still running. A background command counts
 * as running until its task ends (and stays a minute after), and is never pushed off the tape while it runs.
 */
function tape(starts: BrainEvent[], open: Map<string, BrainEvent>, endOf: Map<string, BrainEvent>, bgOf: Map<string, BgTask>, now: number): CommandView[] {
  const running = (e: BrainEvent) => open.has(e.toolUseId!) || bgOf.get(e.toolUseId!)?.endedAt === null;
  const recent = (e: BrainEvent) => {
    const bg = bgOf.get(e.toolUseId!);
    return now - (bg?.endedAt ?? e.ts) < COMMAND_MS;
  };
  const shown = starts.filter((e) => running(e) || recent(e));
  const last = shown.slice(-COMMANDS_SHOWN);
  const kept = [...shown.filter((e) => running(e) && !last.includes(e)), ...last];
  return kept.map((e) => {
    const bg = bgOf.get(e.toolUseId!);
    const end = endOf.get(e.toolUseId!);
    return {
      key: e.toolUseId!,
      text: e.tool?.summary ?? '',
      ts: e.ts,
      live: running(e),
      failed: bg ? bg.status === 'failed' : Boolean(end?.tool?.failed),
      ms: bg ? (bg.endedAt != null ? bg.endedAt - bg.startedAt : undefined) : end?.durationMs,
      ...(bg ? { bg: { taskId: bg.taskId, status: bg.status } } : {}),
    };
  });
}
