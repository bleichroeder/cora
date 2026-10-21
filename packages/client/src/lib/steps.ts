import type { BrainEvent, IconRef } from '@cora/shared';

export type Item =
  | { kind: 'tool'; key: string; start?: BrainEvent; end?: BrainEvent }
  | { kind: 'think'; key: string; e: BrainEvent }
  | { kind: 'spawn'; key: string; e: BrainEvent; childAgentId?: string }
  | { kind: 'report'; key: string; e: BrainEvent }
  | { kind: 'compact' | 'turn_end' | 'interrupt'; key: string; e: BrainEvent };

export type Step = {
  key: string;
  agentId: string;
  ts: number;
  text?: string;
  /** the reply's say-line (spoken summary), and the id voice reads it under */
  said?: { id: string; text: string };
  prompt?: string;
  cont: boolean;
  items: Item[];
  fingerprint: IconRef[];
};

const MAX_FP = 14;
const isAgentTool = (e: BrainEvent) => e.tool?.name === 'Agent' || e.tool?.name === 'Task';

export const byTime = (a: BrainEvent, b: BrainEvent) => a.ts - b.ts || a.seq - b.seq;

/** The id a reply's say-line is read under (the transcript's replay button and the automation agree on it). */
export const saidId = (e: BrainEvent) => `said:say:${e.id}`;

/**
 * Group an agent's events into readable steps: narration (or a prompt) followed by what the agent did.
 * In the "all" view, when another agent's step intervenes, the next activity opens a "continued" step so
 * live activity always lands at the bottom.
 */
export function buildSteps(events: BrainEvent[], filter: 'all' | string, childBySpawn: Map<string, string> = new Map()): Step[] {
  const steps: Step[] = [];
  const current = new Map<string, Step>();
  const toolItems = new Map<string, Extract<Item, { kind: 'tool' }>>();
  const sorted = [...events].sort(byTime);

  const open = (e: BrainEvent, fields: Partial<Step> = {}, cont = false): Step => {
    const s: Step = { key: `${e.id}#step`, agentId: e.agentId, ts: e.ts, cont, items: [], fingerprint: [], ...fields };
    steps.push(s);
    current.set(e.agentId, s);
    return s;
  };
  const stepFor = (e: BrainEvent): Step => {
    const cur = current.get(e.agentId);
    if (!cur) return open(e);
    if (filter === 'all' && steps[steps.length - 1] !== cur) return open(e, {}, true);
    return cur;
  };

  for (const e of sorted) {
    if (filter !== 'all' && e.agentId !== filter) continue;
    switch (e.kind) {
      case 'say':
        open(e, { text: e.text || undefined, ...(e.said ? { said: { id: saidId(e), text: e.said } } : {}) });
        break;
      case 'prompt':
        open(e, { prompt: e.text });
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
