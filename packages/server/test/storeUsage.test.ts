import { describe, expect, it } from 'vitest';
import { Store } from '../src/store';

describe("a goal's spend", () => {
  it("is the same from its sessions' token events as from every usage event since then", () => {
    const s = new Store(':memory:');
    let n = 0;
    const ev = (sessionId: string, ts: number, kind: string, tokens?: object) =>
      s.upsertEvent({ id: `e${n++}`, sessionId, agentId: 'main', ts, kind, source: 'transcript', icon: { name: 'x' }, ...(tokens ? { tokens } : {}) } as never);
    for (let i = 0; i < 60; i++) {
      const sid = ['a', 'b', 'c'][i % 3];
      ev(sid, 1000 + i * 10, i % 4 ? 'say' : 'turn_end', i % 2 ? { in: 100 + i, out: 10 + i, cached: i } : undefined);
    }
    const spend = (events: Array<{ sessionId: string; tokens?: { in: number; out: number; cached?: number } }>, sids: Set<string>) =>
      events.reduce((t, e) => (sids.has(e.sessionId) && e.tokens ? t + e.tokens.out + Math.max(0, e.tokens.in - (e.tokens.cached ?? 0)) : t), 0);
    for (const sids of [['a'], ['a', 'c'], ['b', 'c', 'a'], []]) {
      const set = new Set(sids);
      expect(spend(s.tokenEvents(sids, 1200) as never, set)).toBe(spend(s.usageEvents(1200) as never, set));
    }
    expect(spend(s.tokenEvents(['a', 'b'], 1200) as never, new Set(['a', 'b']))).toBeGreaterThan(0);
  });
});
