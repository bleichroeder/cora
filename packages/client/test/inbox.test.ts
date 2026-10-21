import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem } from '@cora/shared';
import { applyInbox, dayGroups, openItem, shownItems, useInbox } from '../src/state/inbox';

const it1 = (id: string, o: Partial<InboxItem> = {}): InboxItem => ({ id, source: 'jira', key: `jira:${id}`, title: id, why: 'w', entries: [{ id: 'e', text: 't', at: 1, got: 1 }], at: 1, readAt: null, ...o });

beforeEach(() => {
  useInbox.setState({ items: [], sel: null, selReadAt: null, filter: 'all', unreadOnly: false });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

describe('the Inbox (client)', () => {
  it('a full list replaces; changes update in place, go, and keep newest first', () => {
    const e = (at: number) => [{ id: `e${at}`, text: 't', at, got: at }];
    applyInbox({ t: 'inbox', full: true, items: [it1('a', { entries: e(2) }), it1('b', { entries: e(1) }), it1('c', { entries: e(5) })] });
    expect(useInbox.getState().items.map((i) => i.id)).toEqual(['c', 'a', 'b']);
    applyInbox({ t: 'inbox', items: [it1('b', { entries: e(9) })], gone: ['a'] });
    expect(useInbox.getState().items.map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('filters by source and unread', () => {
    applyInbox({ t: 'inbox', full: true, items: [it1('a'), it1('m', { source: 'mail' }), it1('r', { readAt: 5 })] });
    expect(shownItems({ ...useInbox.getState(), filter: 'mail' }).map((i) => i.id)).toEqual(['m']);
    expect(shownItems({ ...useInbox.getState(), unreadOnly: true }).map((i) => i.id)).toEqual(['a', 'm']);
  });

  it('groups by day: today, yesterday, then the weekday', () => {
    const now = new Date(2026, 9, 19, 15).getTime();
    const e = (at: number) => ({ entries: [{ id: 'e', text: 't', at, got: at }] });
    const g = dayGroups([it1('a', e(now - 3600_000)), it1('b', e(now - 86400_000)), it1('c', e(now - 3 * 86400_000))], now);
    expect(g.map((x) => [x.label, x.items.map((i) => i.id)])).toEqual([['Today', ['a']], ['Yesterday', ['b']], ['Friday', ['c']]]);
  });

  it('opening an item remembers where you left off, then marks it read', () => {
    applyInbox({ t: 'inbox', full: true, items: [it1('a', { readAt: 7, at: 9 })] });
    openItem('a');
    const s = useInbox.getState();
    expect(s.sel).toBe('a');
    expect(s.selReadAt).toBe(7);
    expect(s.items[0].readAt).toBeGreaterThanOrEqual(9);
    expect(fetch).toHaveBeenCalledWith('/api/inbox/read', expect.objectContaining({ method: 'POST' }));
  });
});
