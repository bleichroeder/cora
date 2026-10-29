import { describe, expect, it } from 'vitest';
import { SESSION_ICONS, sessionIcon, titleCase } from '@cora/shared';
import { folderLabel, rowState, shortAge } from '../src/lib/navRow';
import { NAV_DEFAULT, NAV_MAX, NAV_MIN, clampNavWidth } from '../src/lib/navWidth';

describe("a session's row in the nav", () => {
  it('names its folder as you would: the repo, and the worktree it works in; the full path as the title', () => {
    expect(folderLabel(String.raw`C:\GitLab\orion-services`)).toEqual({ text: 'orion-services', title: String.raw`C:\GitLab\orion-services` });
    expect(folderLabel('C:/code/orion-api', 'C:/code/orion-api/.claude/worktrees/fix-login')).toEqual({ text: 'orion-api › fix-login', title: 'C:/code/orion-api/.claude/worktrees/fix-login' });
    expect(folderLabel('C:/code/orion-api/.claude/worktrees/fix-login/src').text).toBe('orion-api › fix-login');
    expect(folderLabel('/home/me').text).toBe('me');
  });

  it('says its state in a word only when something is happening, with how long', () => {
    const now = 1_000_000_000;
    const o = { now, fresh: false, speaking: false };
    expect(rowState({ state: 'working', turnAt: now - 9 * 60_000, lastTs: now }, o)).toEqual({ word: 'working', cls: 'w', time: '9m' });
    expect(rowState({ state: 'thinking', turnAt: null, lastTs: now }, o)).toEqual({ word: 'working', cls: 'w' });
    expect(rowState({ state: 'needs-you', lastTs: now }, { ...o, waitingSince: now - 45_000 })).toEqual({ word: 'needs you', cls: 'n', time: '45s' });
    expect(rowState({ state: 'idle', lastTs: now }, { ...o, fresh: true })).toEqual({ word: 'done', cls: 'd' });
    expect(rowState({ state: 'idle', lastTs: now }, { ...o, speaking: true })).toEqual({ word: 'speaking', cls: 's' });
    expect(rowState({ state: 'idle', lastTs: now }, o)).toBeNull();
    expect(rowState({ state: 'ended', lastTs: now }, { ...o, fresh: true })).toBeNull();
    expect([30_000, 9 * 60_000, 3 * 3_600_000, 2 * 86_400_000].map(shortAge)).toEqual(['30s', '9m', '3h', '2d']);
  });

  it('keeps the nav between 240 and 440px, 300 to start', () => {
    expect([100, 300, 333.6, 900].map(clampNavWidth)).toEqual([NAV_MIN, 300, 334, NAV_MAX]);
    expect(NAV_DEFAULT).toBe(300);
  });
});

describe('session icons and names', () => {
  it('only takes icons from the list', () => {
    expect(SESSION_ICONS.length).toBeGreaterThan(300);
    expect(sessionIcon('Rocket')).toBe('Rocket');
    expect(sessionIcon('ChevronDown')).toBeNull();
    expect(sessionIcon(42)).toBeNull();
  });

  it('puts names in Title Case, leaving acronyms, versions, keys and file names alone', () => {
    expect(titleCase('port the export job to the queue')).toBe('Port the Export Job to the Queue');
    expect(titleCase('debug iOS build in CI')).toBe('Debug iOS Build in CI');
    expect(titleCase('review ACME-5310 login fix')).toBe('Review ACME-5310 Login Fix');
    expect(titleCase('jira 2.9 prod audit')).toBe('Jira 2.9 Prod Audit');
    expect(titleCase('what to work on')).toBe('What to Work On');
  });
});

describe('the session icons', () => {
  it('are all in the bundled icon set', async () => {
    const { icons } = await import('lucide-react');
    expect(SESSION_ICONS.filter((n) => !(n in icons))).toEqual([]);
  });
});
