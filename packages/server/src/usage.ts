import type { BrainEvent } from '@cora/shared';

export type UsageTotals = { out: number; in: number; cached: number; calls: number; turns: number };
export type UsageDay = UsageTotals & { day: string; sessions: number };
export type UsageSession = UsageTotals & { sessionId: string; lastTs: number };
export type Usage = { days: UsageDay[]; today: UsageDay; sessions: UsageSession[] };

const zero = (): UsageTotals => ({ out: 0, in: 0, cached: 0, calls: 0, turns: 0 });

/** Local calendar day, e.g. "2026-10-12". */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Token use per day (oldest first, `days` of them ending today) and per session for today (most output first).
 * Counts model calls (events carrying `tokens`) and finished turns.
 */
export function summarizeUsage(events: Iterable<Pick<BrainEvent, 'sessionId' | 'ts' | 'kind' | 'tokens'>>, days: number, now: number): Usage {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(dayKey(now - i * 86_400_000));
  const byDay = new Map(keys.map((k) => [k, { ...zero(), day: k, sessions: 0, ids: new Set<string>() }]));
  const today = keys[keys.length - 1];
  const bySession = new Map<string, UsageSession>();
  for (const e of events) {
    const d = byDay.get(dayKey(e.ts));
    if (!d) continue;
    const add = (t: UsageTotals) => {
      if (e.tokens) {
        t.out += e.tokens.out;
        t.in += e.tokens.in;
        t.cached += e.tokens.cached ?? 0;
        t.calls++;
      }
      if (e.kind === 'turn_end') t.turns++;
    };
    if (!e.tokens && e.kind !== 'turn_end') continue;
    add(d);
    d.ids.add(e.sessionId);
    if (d.day === today) {
      const s = bySession.get(e.sessionId) ?? { ...zero(), sessionId: e.sessionId, lastTs: 0 };
      add(s);
      s.lastTs = Math.max(s.lastTs, e.ts);
      bySession.set(e.sessionId, s);
    }
  }
  const out = keys.map((k) => {
    const { ids, ...d } = byDay.get(k)!;
    return { ...d, sessions: ids.size };
  });
  return { days: out, today: out[out.length - 1], sessions: [...bySession.values()].sort((a, b) => b.out - a.out) };
}
