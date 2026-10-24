import { describe, expect, it } from 'vitest';
import { lockedLine, waitLine } from '../src/lock/words';

describe('the lock screen', () => {
  it('says when it locked (the day too, when it was another day)', () => {
    const now = new Date(2026, 9, 24, 15, 0);
    expect(lockedLine(new Date(2026, 9, 24, 14, 5).getTime(), now)).toMatch(/^Locked at \d/);
    expect(lockedLine(new Date(2026, 9, 23, 18, 30).getTime(), now)).toMatch(/^Locked at \w+, .+, \d/);
    expect(lockedLine(null, now)).toMatch(/keeping watch/);
  });
  it('counts down to the next try', () => {
    expect(waitLine(29_100)).toBe('Too many tries. Try again in 30s.');
    expect(waitLine(120_000)).toBe('Too many tries. Try again in 2:00.');
  });
});
