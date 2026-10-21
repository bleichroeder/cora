import { describe, expect, it } from 'vitest';
import { dayKey, summarizeUsage } from '../src/usage';

const NOW = new Date(2026, 9, 12, 15, 0, 0).getTime();
const DAY = 86_400_000;
const call = (sessionId: string, ts: number, inT: number, out: number, cached = 0) => ({ sessionId, ts, kind: 'say' as const, tokens: { in: inT, out, cached } });
const turn = (sessionId: string, ts: number) => ({ sessionId, ts, kind: 'turn_end' as const });

describe('summarizeUsage', () => {
  it('totals per day (oldest first) and per session today', () => {
    const u = summarizeUsage(
      [
        call('a', NOW - 2 * DAY, 1000, 100),
        call('a', NOW - 60_000, 50_000, 2_000, 45_000),
        call('b', NOW - 30_000, 20_000, 500, 18_000),
        call('b', NOW - 20_000, 21_000, 700, 19_000),
        turn('b', NOW - 10_000),
        { sessionId: 'c', ts: NOW, kind: 'tool' as const }, // no tokens: ignored
      ],
      3,
      NOW,
    );
    expect(u.days.map((d) => d.day)).toEqual([dayKey(NOW - 2 * DAY), dayKey(NOW - DAY), dayKey(NOW)]);
    expect(u.days[0]).toMatchObject({ out: 100, in: 1000, calls: 1, sessions: 1 });
    expect(u.days[1]).toMatchObject({ out: 0, calls: 0, sessions: 0 });
    expect(u.today).toMatchObject({ out: 3200, in: 91_000, cached: 82_000, calls: 3, turns: 1, sessions: 2 });
    expect(u.sessions.map((s) => [s.sessionId, s.out, s.turns])).toEqual([['a', 2000, 0], ['b', 1200, 1]]);
  });

  it('ignores events outside the window', () => {
    const u = summarizeUsage([call('a', NOW - 10 * DAY, 5, 5)], 7, NOW);
    expect(u.days.every((d) => d.calls === 0)).toBe(true);
  });
});
