import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@cora/shared';
import { ENDED_KEEP_MS, dropOrder, inList, moved, nudgeOrder, sortedSessions } from '../src/lib/sessionOrder';

const mk = (id: string, state: SessionInfo['state'], startedAt: number, lastTs: number, order?: number): SessionInfo => ({
  id, cwd: '', project: '', title: '', state, startedAt, lastTs, cliVersion: '', transcriptPath: '', needsYou: 0, ...(order != null ? { order } : {}),
});
const byId = (...ss: SessionInfo[]) => Object.fromEntries(ss.map((s) => [s.id, s]));
const ids = (ss: SessionInfo[]) => ss.map((s) => s.id);

describe('sortedSessions', () => {
  it('keeps working sessions in a fixed order however recent their activity; needs-you stays in place', () => {
    const a = mk('a', 'working', 1, 900), b = mk('b', 'needs-you', 2, 100), c = mk('c', 'thinking', 3, 500);
    expect(ids(sortedSessions(byId(c, b, a)))).toEqual(['a', 'b', 'c']);
    expect(ids(sortedSessions(byId({ ...a, lastTs: 1 }, { ...b, lastTs: 9999 }, c)))).toEqual(['a', 'b', 'c']);
  });

  it('your order first, then unplaced oldest first; working, idle, then ended by recency', () => {
    const s = byId(mk('a', 'working', 1, 1), mk('b', 'working', 2, 1, 0), mk('c', 'idle', 3, 1), mk('d', 'ended', 4, 10), mk('e', 'ended', 5, 20), mk('f', 'idle', 6, 1, 1));
    expect(ids(sortedSessions(s))).toEqual(['b', 'a', 'f', 'c', 'e', 'd']);
  });
});

describe('reordering', () => {
  const s = byId(mk('a', 'working', 1, 1), mk('b', 'working', 2, 1), mk('c', 'working', 3, 1), mk('d', 'idle', 4, 1), mk('x', 'ended', 5, 1));
  it('moved puts an id before another, or at the end', () => {
    expect(moved(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moved(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
  });
  it('drops above or below a session, leaving ended ones out', () => {
    expect(dropOrder(s, 'c', 'a', false)).toEqual(['c', 'a', 'b', 'd']);
    expect(dropOrder(s, 'a', 'b', true)).toEqual(['b', 'a', 'c', 'd']);
    expect(dropOrder(s, 'b', 'a', true)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('nudges within the group only, skipping hidden ones', () => {
    expect(nudgeOrder(s, 'b', -1, () => true)).toEqual(['b', 'a', 'c', 'd']);
    expect(nudgeOrder(s, 'a', 1, (x) => x.id !== 'b')).toEqual(['b', 'c', 'a', 'd']);
    expect(nudgeOrder(s, 'c', 1, () => true)).toBeNull();
    expect(nudgeOrder(s, 'd', -1, () => true)).toBeNull();
    expect(nudgeOrder(s, 'x', -1, () => true)).toBeNull();
  });
});

describe('inList', () => {
  const now = 10 * ENDED_KEEP_MS;
  it('lists live sessions whatever their age, and ended ones for a few hours', () => {
    expect(inList(mk('a', 'idle', 1, 1), now, null)).toBe(true);
    expect(inList(mk('b', 'ended', 1, now - ENDED_KEEP_MS + 1000), now, null)).toBe(true);
    expect(inList(mk('c', 'ended', 1, now - ENDED_KEEP_MS - 1000), now, null)).toBe(false);
  });
  it('keeps an old ended session listed while you look at it', () => {
    expect(inList(mk('c', 'ended', 1, 1), now, 'c')).toBe(true);
  });
  it('leaves out removed sessions until they have new activity', () => {
    expect(inList({ ...mk('d', 'idle', 1, 500), dismissedAt: 600 }, now, null)).toBe(false);
    expect(inList({ ...mk('d', 'idle', 1, 700), dismissedAt: 600 }, now, null)).toBe(true);
  });
});
