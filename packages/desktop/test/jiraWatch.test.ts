import { describe, expect, it } from 'vitest';
import { CHECK_MS, JiraWatcher, type WatchApi, type WatchServer } from '../src/jiraWatch';

const ME = 'acc-me';
const T0 = Date.parse('2026-10-16T14:00:00Z');

function fakes(o: { signedIn?: boolean; issues?: Record<string, any[]>; failing?: boolean; on?: boolean; kinds?: Record<string, string>; offered?: string[] } = {}) {
  const paths: string[] = [];
  const sent: any[] = [];
  let since: number | null = T0 - 120_000;
  const api: WatchApi = {
    myself: async () => (o.signedIn === false ? { ok: false, error: 'signed-out' } : { ok: true, value: { accountId: ME, name: 'David' } }),
    get: async (_site, path) => {
      // a query string: + is a space
      const p = decodeURIComponent(path.replace(/\+/g, ' '));
      paths.push(p);
      if (o.failing) return { ok: false, error: 'offline' };
      const which = p.includes('key in (') ? 'still' : p.includes('watcher') ? 'watched' : p.includes('comment ~') ? 'mentions' : 'mine';
      return { ok: true, value: { issues: o.issues?.[which] ?? [] } };
    },
  };
  const server: WatchServer = {
    info: async () => ({ on: o.on ?? true, site: 's.atlassian.net', kinds: (o.kinds ?? { assigned: 'say', mentioned: 'say', commented: 'notify', status: 'notify', watched: 'quiet' }) as any, since, ...(o.offered ? { offered: o.offered } : {}) }),
    send: async (b) => {
      sent.push(b);
      if (b.checkedAt) since = b.checkedAt;
    },
  };
  const w = new JiraWatcher({ api, server, sites: async () => ['s.atlassian.net'], now: () => T0 });
  return { w, paths, sent };
}

describe('the Jira watcher', () => {
  it('runs a search per watched group, only for tickets updated since the last check, and reports events', async () => {
    const assigned = { key: 'ACME-5301', fields: { summary: 'Dedupe', assignee: { accountId: ME }, reporter: { accountId: 'acc-dana', displayName: 'Dana' }, created: '2026-10-01T00:00:00Z', comment: { comments: [], total: 0 } }, changelog: { histories: [{ id: '9', author: { accountId: 'acc-dana', displayName: 'Dana' }, created: '2026-10-16T13:59:30Z', items: [{ field: 'assignee', to: ME }] }] } };
    const f = fakes({ issues: { mine: [assigned] } });
    await f.w.check();
    expect(f.paths).toHaveLength(3);
    expect(f.paths.every((p) => p.includes('updated >= -4m') && p.includes('expand=changelog'))).toBe(true);
    expect(f.sent[0]).toMatchObject({ checkedAt: T0, status: { state: 'ok' } });
    expect(f.sent[0].events.map((e: any) => [e.kind, e.key])).toEqual([['assigned', 'ACME-5301']]);
  });

  it('skips searches for kinds that are off, and does nothing when watching is off', async () => {
    const f = fakes({ kinds: { assigned: 'off', mentioned: 'say', commented: 'off', status: 'off', watched: 'off' } });
    await f.w.check();
    expect(f.paths).toHaveLength(1);
    expect(f.paths[0]).toMatch(/comment ~ currentUser\(\)/);
    const off = fakes({ on: false });
    await off.w.check();
    expect(off.paths).toEqual([]);
    expect(off.sent).toEqual([]);
  });

  it('signed out: paused, and where to resume is kept', async () => {
    const f = fakes({ signedIn: false });
    await f.w.check();
    expect(f.paths).toEqual([]);
    expect(f.sent[0]).toEqual({ events: [], status: { state: 'paused', message: "You're signed out of Jira in Cora's browser" } });
  });

  it('three failed checks in a row are an error', async () => {
    const f = fakes({ failing: true });
    await f.w.check();
    await f.w.check();
    expect(f.sent).toEqual([]);
    await f.w.check();
    expect(f.sent[0].status).toMatchObject({ state: 'error' });
  });

  it('re-checks the tickets Cora offered to start: which are still yours (keys checked before they go in a search)', async () => {
    const f = fakes({ offered: ['ACME-5301', 'ACME-9', 'x) OR 1=1'], issues: { still: [{ key: 'ACME-5301' }] } });
    await f.w.check();
    const q = f.paths.filter((p) => p.includes('key in ('));
    expect(q).toHaveLength(1);
    expect(q[0]).toContain('key in (ACME-5301,ACME-9) AND assignee = currentUser()');
    expect(f.sent[0].still).toEqual(['ACME-5301']);
    const none = fakes();
    await none.w.check();
    expect(none.paths.some((p) => p.includes('key in ('))).toBe(false);
    expect(none.sent[0].still).toBeUndefined();
  });

  it('ticks every 30 s; while you are away, only every 2 min', async () => {
    let now = T0;
    let away = false;
    const checks: number[] = [];
    const w = new JiraWatcher({ api: {} as any, server: {} as any, sites: async () => [], now: () => now, away: () => away });
    (w as any).check = async () => void checks.push(now);
    expect(CHECK_MS).toBe(30_000);
    await w.tick();
    now += 30_000;
    await w.tick();
    expect(checks).toHaveLength(2);
    away = true;
    now += 30_000;
    await w.tick();
    expect(checks).toHaveLength(2);
    now += 90_000;
    await w.tick();
    expect(checks).toHaveLength(3);
    away = false;
    now += 30_000;
    await w.tick();
    expect(checks).toHaveLength(4);
  });
});
