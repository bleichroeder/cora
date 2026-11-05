import { describe, expect, it } from 'vitest';
import { WAKE_LIMIT } from '@cora/shared';
import { WAKE_LIMITS, wakeLimitOf, wakeTitle } from '../src/components/ProjectView';

describe("a project's wake limit (Wake each other, without a team)", () => {
  it('the choices: a few limits and none; the default is kept unset', () => {
    expect(WAKE_LIMITS).toContain(WAKE_LIMIT);
    expect(WAKE_LIMITS.at(-1)).toBe('none');
    expect(wakeLimitOf(String(WAKE_LIMIT))).toBeNull();
    expect(wakeLimitOf('12')).toBe(12);
    expect(wakeLimitOf('none')).toBe('none');
  });

  it('Wake each other says what it does: off, the limit, no limit, or a team whose routes decide', () => {
    expect(wakeTitle({ autoWake: false })).toMatch(/asks you first/);
    expect(wakeTitle({ autoWake: true })).toMatch(new RegExp(`\\(${WAKE_LIMIT} times an hour each at most`));
    expect(wakeTitle({ autoWake: true, wakeLimit: 12 })).toMatch(/\(12 times an hour/);
    expect(wakeTitle({ autoWake: true, wakeLimit: 'none' })).toMatch(/as often as they like/);
    expect(wakeTitle({ autoWake: true, wakeLimit: 3, team: { version: 1 } as never })).toMatch(/the team's routes say/);
  });
});
