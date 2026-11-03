import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '@cora/shared';
import { recentlyActive, resumeStep } from '../src/lib/resumeHere';
import { checkRunning } from '../src/state/ws';

const S = (state: SessionInfo['state'], lastTs: number) => ({ state, lastTs }) as SessionInfo;
const NOW = 10 * 60_000;
const clear = { checked: true, elsewhere: false };

describe("Resume here, for a session Cora doesn't host", () => {
  it('one click only when it is known to have ended and the check found it running nowhere else', () => {
    expect(resumeStep(S('ended', NOW - 60_000), clear)).toBe('go');
  });
  it("asked first when it may still be open: not known to have ended (a plain `claude` idle elsewhere can't be seen), or the check couldn't look", () => {
    expect(resumeStep(S('idle', NOW - 10 * 60_000), clear)).toBe('confirm');
    expect(resumeStep(S('working', NOW - 5 * 60_000), clear)).toBe('confirm');
    expect(resumeStep(S('ended', NOW - 60_000), { checked: false, elsewhere: false })).toBe('confirm');
  });
  it('still running in another terminal: blocked (exit it there, or fork a copy)', () => {
    expect(resumeStep(S('ended', NOW - 60_000), { checked: true, elsewhere: true })).toBe('blocked');
  });
  it('active a moment ago: the warning says so', () => {
    expect(recentlyActive(S('working', NOW - 60_000), NOW)).toBe(true);
    expect(recentlyActive(S('ended', NOW - 60_000), NOW)).toBe(false);
  });
});

describe('the check for it running elsewhere', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (ok: boolean, body: unknown) => vi.stubGlobal('fetch', async () => ({ ok, json: async () => body }));
  it('not running is not the same as not checked', async () => {
    answer(true, { hosted: false, checked: true, elsewhere: false, pids: [] });
    expect(await checkRunning('s1')).toMatchObject({ checked: true, elsewhere: false });
    answer(true, { hosted: false, checked: false, elsewhere: false, pids: [] });
    expect(await checkRunning('s1')).toMatchObject({ checked: false, elsewhere: false });
  });
  it("a refused or failed request couldn't check", async () => {
    answer(false, { error: 'no' });
    expect(await checkRunning('s1')).toMatchObject({ checked: false, elsewhere: false });
    vi.stubGlobal('fetch', async () => {
      throw new Error('Failed to fetch');
    });
    expect(await checkRunning('s1')).toMatchObject({ checked: false, elsewhere: false });
    // an answer without the word: couldn't check
    answer(true, { hosted: false, elsewhere: false });
    expect(await checkRunning('s1')).toMatchObject({ checked: false });
  });
});
