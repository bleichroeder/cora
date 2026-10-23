import { describe, expect, it } from 'vitest';
import { normalizeUsage } from '@cora/shared';
import { accountUsage } from '../src/accountUsage';

const ANSWER = {
  five_hour: { utilization: 31, resets_at: '2026-10-22T23:00:00+00:00' },
  seven_day: { utilization: 27, resets_at: '2026-10-28T04:00:00+00:00' },
  extra_usage: { is_enabled: true, monthly_limit: 4000, used_credits: 2449, utilization: 61.2, currency: 'USD', decimal_places: 2 },
  limits: [
    { kind: 'session', group: 'session', percent: 31, severity: 'normal', resets_at: '2026-10-22T23:00:00+00:00' },
    { kind: 'weekly_all', group: 'weekly', percent: 27, severity: 'normal', resets_at: '2026-10-28T04:00:00+00:00' },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, scope: 'opus' },
    { kind: 'weekly_scoped', group: 'weekly', percent: 12, scope: 'sonnet' },
  ],
};

describe('your plan usage', () => {
  it('reads the limits as /usage words them, and extra usage in money', () => {
    const u = normalizeUsage(ANSWER, 0, 'max');
    expect(u.limits.map((l) => [l.label, l.percent])).toEqual([
      ['Current session', 31],
      ['This week · all models', 27],
      ['This week · Sonnet', 12],
    ]);
    expect(u.limits[0].resetsAt).toBe(Date.parse('2026-10-22T23:00:00+00:00'));
    expect(u.extra).toEqual({ used: 24.49, limit: 40, currency: 'USD', percent: 61.2 });
    expect(u.plan).toBe('max');
    // the older shape
    const { limits: _, ...old } = ANSWER;
    expect(normalizeUsage(old, 0).limits.map((l) => l.label)).toEqual(['Current session', 'This week · all models']);
    expect(normalizeUsage({ nope: 1 }, 0).limits).toEqual([]);
  });

  it("asks with Claude Code's login, at most once a minute; no login, an expired one or a refusal say so", async () => {
    let t = 1_000_000;
    let asked = 0;
    const creds = (login: object) => async () => JSON.stringify({ claudeAiOauth: login });
    const ok = async (url: string, init?: RequestInit) => {
      asked++;
      expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      return new Response(JSON.stringify(ANSWER));
    };
    const a = accountUsage({ fetch: ok as typeof fetch, read: creds({ accessToken: 'tok', expiresAt: t + 3600_000 }), now: () => t });
    expect((await a.get()).limits).toHaveLength(3);
    await a.get();
    expect(asked).toBe(1);
    t += 61_000;
    await a.get();
    expect(asked).toBe(2);
    expect((await accountUsage({ read: async () => { throw new Error('ENOENT'); } }).get()).state).toBe('none');
    expect((await accountUsage({ read: creds({ accessToken: 'tok', expiresAt: 1 }), now: () => t }).get()).state).toBe('expired');
    expect((await accountUsage({ fetch: (async () => new Response('', { status: 401 })) as typeof fetch, read: creds({ accessToken: 'tok' }) }).get()).state).toBe('expired');
  });
});
