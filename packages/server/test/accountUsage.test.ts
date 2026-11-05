import { describe, expect, it } from 'vitest';
import { normalizeUsage } from '@cora/shared';
import { FRESH_MS, accountUsage, retryAfterMs } from '../src/accountUsage';

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

  it("asks with Claude Code's login, at most every five minutes; no login, an expired one or a refusal say so", async () => {
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
    t += 4 * 60_000;
    await a.get();
    expect(asked).toBe(1);
    t += FRESH_MS;
    await a.get();
    expect(asked).toBe(2);
    expect((await accountUsage({ read: async () => { throw new Error('ENOENT'); } }).get()).state).toBe('none');
    expect((await accountUsage({ read: creds({ accessToken: 'tok', expiresAt: 1 }), now: () => t }).get()).state).toBe('expired');
    expect((await accountUsage({ fetch: (async () => new Response('', { status: 401 })) as typeof fetch, read: creds({ accessToken: 'tok' }) }).get()).state).toBe('expired');
  });

  it('rate-limited (429): the last good reading stays on show, marked as of when; asked again after 5 minutes, doubling to 30; a good answer ends it', async () => {
    let t = 1_000_000;
    let asked = 0;
    let answer = () => new Response(JSON.stringify(ANSWER));
    const a = accountUsage({ fetch: (async () => (asked++, answer())) as typeof fetch, read: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }), now: () => t });
    const first = await a.get();
    expect(first.state).toBe('ok');
    answer = () => new Response('', { status: 429 });
    t += FRESH_MS;
    const kept = await a.get();
    expect(asked).toBe(2);
    expect(kept).toMatchObject({ state: 'ok', limits: first.limits, at: first.at });
    expect(kept.stale?.message).toMatch(/^Asked for too often just now: as of \d\d:\d\d, asked again at \d\d:\d\d\.$/);
    expect(kept.stale?.retryAt).toBe(t + 5 * 60_000);
    // not asked again meanwhile, however often the panels look
    t += 4 * 60_000;
    expect((await a.get()).stale).toBeDefined();
    expect(asked).toBe(2);
    // 5 minutes on: asked, refused again: 10 minutes, then 20, then 30 (no more)
    for (const wait of [10, 20, 30, 30]) {
      t += 60_000;
      await a.get();
      const n = asked;
      expect((await a.get()).stale?.retryAt).toBe(t + wait * 60_000);
      t += wait * 60_000 - 1000;
      await a.get();
      expect(asked).toBe(n);
      t -= 60_000 - 1000;
    }
    // it answers again: fresh numbers, nothing stale, and the wait starts over
    answer = () => new Response(JSON.stringify(ANSWER));
    t += 60_000;
    const back = await a.get();
    expect(back.stale).toBeUndefined();
    expect(back.at).toBe(t);
  });

  it("a Retry-After is honoured (seconds, or a date); other failures back off from a minute; nothing read yet says when it's asked again; a test Cora never asks", async () => {
    expect(retryAfterMs('120', 0)).toBe(120_000);
    expect(retryAfterMs(new Date(600_000).toUTCString(), 0)).toBe(600_000);
    expect(retryAfterMs('soon', 0)).toBeNull();
    expect(retryAfterMs(null, 0)).toBeNull();
    // (within reason: not 5 seconds, not a day)
    expect(retryAfterMs('5', 0)).toBe(30_000);
    expect(retryAfterMs('86400', 0)).toBe(2 * 3_600_000);
    let t = 1_000_000;
    let asked = 0;
    let answer = () => new Response('', { status: 429, headers: { 'retry-after': '120' } });
    const a = accountUsage({ fetch: (async () => (asked++, answer())) as typeof fetch, read: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }), now: () => t });
    // refused before anything was read: an error, saying when it's asked again
    const none = await a.get();
    expect(none.state).toBe('error');
    expect(none.message).toMatch(/HTTP 429\)\. Asked again at \d\d:\d\d\.$/);
    t += 119_000;
    await a.get();
    expect(asked).toBe(1);
    t += 1000;
    answer = () => new Response('', { status: 503 });
    await a.get();
    expect(asked).toBe(2);
    // a server error: a minute, then two
    t += 59_000;
    await a.get();
    expect(asked).toBe(2);
    t += 1000;
    await a.get();
    expect(asked).toBe(3);
    t += 119_000;
    await a.get();
    expect(asked).toBe(3);
    // a test Cora (CORA_NO_USAGE): never asked
    let never = 0;
    const off = await accountUsage({ fetch: (async () => (never++, new Response('{}'))) as typeof fetch, read: async () => '{}', off: () => true }).get();
    expect(off.state).toBe('off');
    expect(off.message).toMatch(/off in a test Cora/);
    expect(never).toBe(0);
  });
});
