import { describe, expect, it } from 'vitest';
import { startedToShow } from '../src/state/jiraWatch';

const r = (sessionId: string, at: number, auto = true) => ({ sessionId, key: 'ACME-1', summary: '', cwd: 'C:/x', at, auto });

describe('started cards', () => {
  it('only what Cora started on its own, lately, not dismissed, newest first', () => {
    const now = 10 * 60 * 60_000;
    const list = [r('a', now - 60_000), r('b', now - 31 * 60_000), r('c', now - 1000, false), r('d', now - 5000), r('e', now - 2000)];
    expect(startedToShow(list, { d: true }, now).map((x) => x.sessionId)).toEqual(['e', 'a']);
  });
});
