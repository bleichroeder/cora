import type { BrainEvent, IconRef } from '@cora/shared';

export type Item =
  | { kind: 'tool'; key: string; start?: BrainEvent; end?: BrainEvent }
  | { kind: 'think'; key: string; e: BrainEvent }
  | { kind: 'spawn'; key: string; e: BrainEvent; childAgentId?: string }
  | { kind: 'report'; key: string; e: BrainEvent }
  /** a background agent's narration or task, inside its folded row */
  | { kind: 'note'; key: string; e: BrainEvent }
  | { kind: 'compact' | 'turn_end' | 'interrupt'; key: string; e: BrainEvent };

export type Step = {
  key: string;
  agentId: string;
  ts: number;
  text?: string;
  /** the reply's say-line (spoken summary), and the id voice reads it under */
  said?: { id: string; text: string };
  prompt?: string;
  /** the prompt is a message you sent while Claude was working: it got it here, mid-turn */
  mid?: boolean;
  cont: boolean;
  items: Item[];
  fingerprint: IconRef[];
  /** a stretch of a background agent's work, folded into one row ("All" view only) */
  fold?: true;
  /** a command you ran yourself (`!` in Claude Code): its one tool item, a step of its own */
  ran?: true;
};

const MAX_FP = 14;
const isAgentTool = (e: BrainEvent) => e.tool?.name === 'Agent' || e.tool?.name === 'Task';
/** A command you ran yourself (`!` in Claude Code), not one of Claude's (events recorded before `byYou` have only the id). */
export const isYourCommand = (e: Pick<BrainEvent, 'toolUseId' | 'tool'>) => !!e.tool?.byYou || !!e.toolUseId?.startsWith('bang:');

export const byTime = (a: BrainEvent, b: BrainEvent) => a.ts - b.ts || a.seq - b.seq;

/** The id a reply's say-line is read under (the transcript's replay button and the automation agree on it). */
export const saidId = (e: BrainEvent) => `said:say:${e.id}`;

/**
 * Group an agent's events into readable steps: narration (or a prompt) followed by what the agent did.
 * In the "all" view, when another agent's step intervenes, the next activity opens a "continued" step so
 * live activity always lands at the bottom.
 *
 * A background agent (its Agent call returned at once) and the helpers it starts can keep working after main has
 * replied and finished its turn: in the "all" view that work would bury the reply under its steps, so each stretch of
 * it after main's turn ends is one folded row (its own tab shows it all; its report shows as usual). While main is
 * working, everything is inline as it comes.
 */
export function buildSteps(events: BrainEvent[], filter: 'all' | string, childBySpawn: Map<string, string> = new Map()): Step[] {
  const steps: Step[] = [];
  const current = new Map<string, Step>();
  const toolItems = new Map<string, Extract<Item, { kind: 'tool' }>>();
  const sorted = [...events].sort(byTime);
  const spawnOf = new Map([...childBySpawn].map(([toolUseId, child]) => [child, toolUseId]));
  const spawnEnded = new Set<string>();
  const background = new Set<string>();
  const folds = new Map<string, { step: Step; at: number }>();
  // the index of the last step that isn't a fold: a fold row is reused until another agent's step comes after it
  let lastPlain = -1;
  // main finished its turn and is waiting for you
  let mainIdle = false;

  const open = (e: BrainEvent, fields: Partial<Step> = {}, cont = false): Step => {
    const s: Step = { key: `${e.id}#step`, agentId: e.agentId, ts: e.ts, cont, items: [], fingerprint: [], ...fields };
    steps.push(s);
    current.set(e.agentId, s);
    lastPlain = steps.length - 1;
    return s;
  };
  const foldFor = (e: BrainEvent): Step => {
    const had = folds.get(e.agentId);
    if (had && had.at > lastPlain) return had.step;
    const s: Step = { key: `${e.id}#fold`, agentId: e.agentId, ts: e.ts, cont: !!had, items: [], fingerprint: [], fold: true };
    steps.push(s);
    folds.set(e.agentId, { step: s, at: steps.length - 1 });
    return s;
  };
  const inBackground = (e: BrainEvent): boolean => {
    if (e.agentId === 'main') return false;
    const t = spawnOf.get(e.agentId);
    if (t && spawnEnded.has(t)) background.add(e.agentId);
    return background.has(e.agentId);
  };
  const stepFor = (e: BrainEvent): Step => {
    const cur = current.get(e.agentId);
    if (!cur) return open(e);
    if (filter === 'all' && steps[steps.length - 1] !== cur) return open(e, {}, true);
    return cur;
  };

  for (const e of sorted) {
    if (filter !== 'all' && e.agentId !== filter) continue;
    if (e.kind === 'tool' && e.phase === 'end' && e.toolUseId && isAgentTool(e)) spawnEnded.add(e.toolUseId);
    // a helper a background agent starts runs in the background too
    if (e.kind === 'spawn' && e.toolUseId && background.has(e.agentId)) {
      const child = childBySpawn.get(e.toolUseId);
      if (child) background.add(child);
    }
    if (e.agentId === 'main') {
      if (e.kind === 'turn_end') mainIdle = true;
      else if ((e.kind === 'prompt' && !e.queue) || e.kind === 'say' || (e.kind === 'tool' && !isYourCommand(e)) || e.kind === 'think' || e.kind === 'spawn') mainIdle = false;
    }
    if (inBackground(e) && filter === 'all' && mainIdle && e.kind !== 'report') {
      if (e.kind === 'tool' && isAgentTool(e)) continue;
      const id = e.toolUseId ?? e.id;
      const existing = e.kind === 'tool' ? toolItems.get(id) : undefined;
      if (existing) {
        if (e.phase === 'end') existing.end = e;
        else existing.start = e;
        continue;
      }
      const f = foldFor(e);
      if (e.kind === 'tool') {
        const item: Extract<Item, { kind: 'tool' }> = { kind: 'tool', key: `tool:${id}`, ...(e.phase === 'end' ? { end: e } : { start: e }) };
        toolItems.set(id, item);
        f.items.push(item);
        if (f.fingerprint.length < MAX_FP) f.fingerprint.push(e.icon);
      } else if (e.kind === 'say' || e.kind === 'prompt') {
        if (e.text) f.items.push({ kind: 'note', key: e.id, e });
      } else if (e.kind === 'think') f.items.push({ kind: 'think', key: e.id, e });
      else if (e.kind === 'spawn') f.items.push({ kind: 'spawn', key: e.id, e, childAgentId: e.toolUseId ? childBySpawn.get(e.toolUseId) : undefined });
      else if (e.kind === 'compact' || e.kind === 'interrupt') f.items.push({ kind: e.kind, key: e.id, e });
      continue;
    }
    switch (e.kind) {
      case 'say':
        open(e, { text: e.text || undefined, ...(e.said ? { said: { id: saidId(e), text: e.said } } : {}) });
        break;
      case 'prompt':
        // a message you sent while it worked: waiting, it's pinned below the transcript (not here); taken, its own
        // prompt (midTurn) shows where Claude got it
        if (e.queue) break;
        open(e, { prompt: e.text, ...(e.midTurn ? { mid: true } : {}) });
        break;
      case 'tool': {
        if (isAgentTool(e)) break;
        const id = e.toolUseId ?? e.id;
        const existing = toolItems.get(id);
        if (existing) {
          if (e.phase === 'end') existing.end = e;
          else existing.start = e;
          break;
        }
        const item: Extract<Item, { kind: 'tool' }> = { kind: 'tool', key: `tool:${id}`, ...(e.phase === 'end' ? { end: e } : { start: e }) };
        toolItems.set(id, item);
        // a command you ran: a step of its own, like a prompt (what Claude does next starts a step after it)
        if (isYourCommand(e)) {
          open(e, { ran: true, items: [item], fingerprint: [e.icon] });
          current.delete(e.agentId);
          break;
        }
        const s = stepFor(e);
        s.items.push(item);
        if (s.fingerprint.length < MAX_FP) s.fingerprint.push(e.icon);
        break;
      }
      case 'think':
        stepFor(e).items.push({ kind: 'think', key: e.id, e });
        break;
      case 'spawn':
        stepFor(e).items.push({ kind: 'spawn', key: e.id, e, childAgentId: e.toolUseId ? childBySpawn.get(e.toolUseId) : undefined });
        break;
      case 'report':
        stepFor(e).items.push({ kind: 'report', key: e.id, e });
        break;
      case 'compact':
        stepFor(e).items.push({ kind: 'compact', key: e.id, e });
        break;
      case 'turn_end':
        if (e.agentId === 'main') stepFor(e).items.push({ kind: 'turn_end', key: e.id, e });
        break;
      case 'interrupt':
        stepFor(e).items.push({ kind: 'interrupt', key: e.id, e });
        break;
      default:
        break;
    }
  }
  return steps.filter((s) => s.text || s.prompt || s.items.length);
}
