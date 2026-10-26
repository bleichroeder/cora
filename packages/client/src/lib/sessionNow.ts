import type { BrainEvent } from '@cora/shared';
import { contextMax } from '../scene/derive';

/** What a session is doing this second (its newest tool still running), and how full its context is. */
export type SessionNow = {
  /** the tool running now: what it says it's doing, and since when */
  doing: { label: string; since: number } | null;
  /** its context window: used of the most, and the share */
  ctx: { used: number; max: number; share: number } | null;
  /** when its last turn ended (it's resting since) */
  restedAt: number | null;
  /** its latest turn: from your prompt to its end (null: still going) */
  turn: { since: number; until: number | null } | null;
  /** what it has changed (it and its agents): files, lines added and removed */
  changed: { files: number; add: number; del: number };
};

const LABEL_MAX = 90;

/** From a session's events (oldest first): its main agent's running tool, its context, its last turn's end. */
export function sessionNow(events: BrainEvent[], model?: string): SessionNow {
  const starts = new Map<string, BrainEvent>();
  const ended = new Set<string>();
  let used = 0;
  let usedAt = 0;
  let peak = 0;
  let compacted = 0;
  let rested: number | null = null;
  let prompted: number | null = null;
  const files = new Set<string>();
  let add = 0;
  let del = 0;
  for (const e of events) {
    // (as the Changes tab counts them: a finished tool that didn't fail)
    const ch = e.kind === 'tool' && e.phase === 'end' && !e.tool?.failed ? e.tool?.change : undefined;
    if (ch) files.add(ch.path), (add += ch.add), (del += ch.del);
    if (e.agentId !== 'main') continue;
    if (e.tokens) {
      const u = e.tokens.in + e.tokens.out;
      peak = Math.max(peak, u);
      if (e.ts >= usedAt) (used = u), (usedAt = e.ts);
    }
    if (e.kind === 'compact') compacted = Math.max(compacted, e.ts);
    if (e.kind === 'turn_end') rested = e.ts;
    if (e.kind === 'prompt') prompted = e.ts;
    if (e.kind !== 'tool' || !e.toolUseId) continue;
    if (e.phase === 'start') starts.set(e.toolUseId, e);
    else ended.add(e.toolUseId);
  }
  // running: started, not finished (wherever its end came in the list: around a restart they can come out of order),
  // and since its turn last ended (a turn that ended isn't running anything, even if a tool's end never came)
  const cur = [...starts.values()].filter((e) => !ended.has(e.toolUseId!) && (rested == null || e.ts > rested)).sort((a, b) => b.ts - a.ts)[0];
  const label = cur ? String(cur.tool?.summary || cur.tool?.name || 'Working').replace(/\s+/g, ' ').trim() : '';
  const max = contextMax(model, peak);
  const now = usedAt ? (compacted > usedAt ? 0 : used) : null;
  return {
    doing: cur ? { label: label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label, since: cur.ts } : null,
    ctx: now == null ? null : { used: now, max, share: Math.min(1, now / max) },
    restedAt: cur ? null : rested,
    turn: prompted == null ? null : { since: prompted, until: rested != null && rested >= prompted ? rested : null },
    changed: { files: files.size, add, del },
  };
}
