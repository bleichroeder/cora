import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_JIRA_WATCH, type JiraEvent, type JiraWatchSettings } from '@cora/shared';
import { CATCHUP_MS, JiraFeed, KEEP_MS, type JiraFresh } from '../src/jiraFeed';

const ev = (id: string, kind: JiraEvent['kind'], at: number): JiraEvent => ({ id, kind, key: 'ACME-1', summary: 'S', who: 'Dana', what: 'assigned you', at, link: 'https://s/browse/ACME-1' });
const OK = { state: 'ok' as const };

function setup(watch: Partial<JiraWatchSettings> = {}, file = join(mkdtempSync(join(tmpdir(), 'cora-jira-')), 'jira-watch.json')) {
  let now = 1_000_000_000_000;
  const fresh: JiraFresh[] = [];
  const settings = { ...DEFAULT_JIRA_WATCH, on: true, ...watch };
  const feed = new JiraFeed({ file, settings: () => settings, onFresh: (f) => fresh.push(f), now: () => now });
  return { feed, fresh, file, settings, tick: (ms: number) => (now += ms), now: () => now };
}

describe('the Jira record keeper', () => {
  it("tells each new event once, with its level; drops Off kinds; resumes from the last check", () => {
    const s = setup({ kinds: { ...DEFAULT_JIRA_WATCH.kinds, watched: 'off' } });
    expect(s.feed.watchInfo()).toMatchObject({ on: true, since: null });
    const a = ev('ACME-1:h1', 'assigned', s.now());
    const r = s.feed.ingest({ checkedAt: s.now(), events: [a, ev('ACME-2:c1', 'watched', s.now())], status: OK });
    expect(r.events).toEqual([{ ...a, level: 'say' }]);
    expect(r.summary).toBeUndefined();
    s.tick(120_000);
    expect(s.feed.ingest({ checkedAt: s.now(), events: [a], status: OK }).events).toEqual([]);
    expect(s.feed.watchInfo().since).toBe(s.now());
    expect(s.fresh).toHaveLength(1);
  });

  it('a check long after the last is a catch-up: one summary', () => {
    const s = setup();
    s.feed.ingest({ checkedAt: s.now(), events: [], status: OK });
    s.tick(CATCHUP_MS + 60_000);
    const r = s.feed.ingest({ checkedAt: s.now(), events: [ev('a', 'assigned', s.now()), ev('b', 'mentioned', s.now()), ev('c', 'mentioned', s.now())], status: OK });
    expect(r.summary).toBe('While Cora was closed: 1 assigned to you, 2 mentions');
    expect(r.events).toHaveLength(3);
  });

  it('keeps what it has seen across a restart, and keeps 14 days', () => {
    const s = setup();
    const old = ev('old', 'commented', s.now());
    s.feed.ingest({ checkedAt: s.now(), events: [old], status: OK });
    const again = new JiraFeed({ file: s.file, settings: () => s.settings, now: s.now });
    expect(again.ingest({ checkedAt: s.now(), events: [old], status: OK }).events).toEqual([]);
    expect(again.recent(86_400_000).map((e) => e.id)).toEqual(['old']);
    s.tick(KEEP_MS + 1);
    again.ingest({ checkedAt: s.now(), events: [], status: OK });
    expect(again.recent(KEEP_MS * 2)).toEqual([]);
  });

  it('a paused check keeps where to resume; status shows off when watching is off', () => {
    const s = setup();
    s.feed.ingest({ checkedAt: s.now(), events: [], status: OK });
    const since = s.feed.watchInfo().since;
    s.tick(120_000);
    s.feed.ingest({ events: [], status: { state: 'paused', message: "you're signed out of Jira" } });
    expect(s.feed.watchInfo().since).toBe(since);
    expect(s.feed.status()).toMatchObject({ state: 'paused' });
    s.settings.on = false;
    expect(s.feed.status().state).toBe('off');
    expect(s.feed.watchInfo().on).toBe(false);
  });

  it('recent: newest first, by kind', () => {
    const s = setup();
    s.feed.ingest({ checkedAt: s.now(), events: [ev('a', 'assigned', s.now() - 1000), ev('b', 'mentioned', s.now())], status: OK });
    expect(s.feed.recent(60_000).map((e) => e.id)).toEqual(['b', 'a']);
    expect(s.feed.recent(60_000, ['assigned']).map((e) => e.id)).toEqual(['a']);
  });

  it("hands over which offered tickets are still yours, and asks about the offered ones", () => {
    const still: string[][] = [];
    const feed = new JiraFeed({ settings: () => ({ ...DEFAULT_JIRA_WATCH, on: true }), offered: () => ['ACME-5301'], onStill: (k) => void still.push(k) });
    expect(feed.watchInfo().offered).toEqual(['ACME-5301']);
    feed.ingest({ checkedAt: 1, events: [], status: OK, still: [] });
    feed.ingest({ checkedAt: 2, events: [], status: OK });
    expect(still).toEqual([[]]);
  });
});
