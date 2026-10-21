import { describe, expect, it } from 'vitest';
import { latestByTitle, versionsOf } from '../src/lib/explainVersions';

const x = (id: string, title: string, ts: number, sessionId = 's1') => ({ id, sessionId, title, ts });

describe("an explain's versions", () => {
  it('lists show the newest of each title (any case or spacing), per session', () => {
    const items = [x('a', 'Release 2.4', 1), x('b', 'Plan', 2), x('c', 'release 2.4 ', 3), x('d', 'Release 2.4', 4, 's2')];
    expect(latestByTitle(items).map((i) => i.id)).toEqual(['b', 'c', 'd']);
  });
  it('the viewer steps through one explain, oldest first, the last 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => x(`v${i}`, 'Release 2.4', i));
    const v = versionsOf([...many, x('other', 'Plan', 99)], { sessionId: 's1', title: 'RELEASE 2.4', ts: 0 });
    expect(v).toHaveLength(20);
    expect([v[0].id, v[19].id]).toEqual(['v5', 'v24']);
  });
});
