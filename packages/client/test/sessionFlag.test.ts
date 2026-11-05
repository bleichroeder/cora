import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionInfo } from '@cora/shared';
import { flagTitle, flaggedCount, remindChoices, rowSelectors, whenWords, whyKey } from '../src/lib/sessionFlag';
import { ENDED_KEEP_MS, inList } from '../src/lib/sessionOrder';
import { FlagCount, FlagMark } from '../src/components/SessionFlag';

/** A session flagged to come back to: its row's bookmark, its hover words, its reminders, and never out of sight. */

const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe("a session's flag in the nav", () => {
  it("the row's bookmark: a quiet slot until it's flagged, in the accent once it is, brighter when its reminder came; its hover says why", () => {
    const html = (flag: SessionInfo['flag']) => renderToStaticMarkup(createElement(FlagMark, { id: 's1', flag, now: local(2026, 11, 4, 17) }));
    const off = html(null);
    expect(off).toMatch(/class="ses-fl"/);
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('title="Come back to this: flag it (click again to clear)"');
    const on = html({ at: 1, note: 'check the deploy finished', remindAt: local(2026, 11, 5, 9) });
    expect(on).toMatch(/class="ses-fl on"/);
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('title="Come back to this: check the deploy finished · reminds you tomorrow 9:00 · click to clear"');
    expect(on).toContain('fill="currentColor"');
    const due = html({ at: 1, remindAt: local(2026, 11, 4, 16, 30), due: true });
    expect(due).toMatch(/class="ses-fl on due"/);
    expect(due).toContain('lucide-bookmark-check');
    expect(due).toContain('Flagged to come back to · its reminder came (16:30) · click to clear');
  });

  it('a folded group counts its flagged ones', () => {
    expect(flaggedCount([{ flag: { at: 1 } }, { flag: null }, {}, { flag: { at: 2, note: 'x' } }])).toBe(2);
    const html = renderToStaticMarkup(createElement(FlagCount, { n: 2 }));
    expect(html).toContain('class="ses-flags"');
    expect(html).toContain('title="2 flagged to come back to"');
    expect(html).toMatch(/>2<\/span>$/);
  });

  it('reminders offered: later today (three hours on, to the quarter hour) while it is still today, and tomorrow at 9:00', () => {
    expect(remindChoices(local(2026, 11, 4, 10, 5))).toEqual([
      { label: 'Later today, 13:15', at: local(2026, 11, 4, 13, 15) },
      { label: 'Tomorrow 9:00', at: local(2026, 11, 5, 9) },
    ]);
    // late in the evening: only tomorrow
    expect(remindChoices(local(2026, 11, 4, 22)).map((c) => c.label)).toEqual(['Tomorrow 9:00']);
    const now = local(2026, 11, 4, 10);
    expect(whenWords(local(2026, 11, 4, 17, 45), now)).toBe('17:45');
    expect(whenWords(local(2026, 11, 5, 9), now)).toBe('tomorrow 9:00');
    expect(whenWords(local(2026, 11, 7, 9), now)).toMatch(/^Sat 7 Nov 9:00$/);
    expect(flagTitle({ at: 1 }, now)).toBe('Flagged to come back to · click to clear');
  });

  it('a flagged session stays in the list, however long ago it ended (one you removed from the list stays off it)', () => {
    const now = 10 * ENDED_KEEP_MS;
    const old = { id: 'a', state: 'ended', lastTs: 0, dismissedAt: null } as unknown as SessionInfo;
    expect(inList(old, now, null)).toBe(false);
    expect(inList({ ...old, flag: { at: 1 } }, now, null)).toBe(true);
    expect(inList({ ...old, flag: { at: 1 }, dismissedAt: 5 }, now, null)).toBe(false);
  });

  it("in the drawer: Enter (or Esc) in the why field saves and closes, and goes no further, so it doesn't press the row focus goes back to (opening the session, closing the drawer)", () => {
    const key = (k: string) => {
      const e = { key: k, prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } };
      let done = 0;
      whyKey(e, () => done++);
      return { prevented: e.prevented, stopped: e.stopped, done };
    };
    expect(key('Enter')).toEqual({ prevented: 1, stopped: 1, done: 1 });
    expect(key('Escape')).toEqual({ prevented: 1, stopped: 1, done: 1 });
    // typing: its own (and never the drawer's or the app's shortcuts)
    expect(key('a')).toEqual({ prevented: 0, stopped: 1, done: 0 });
  });

  it("focus goes back to the nav's row in the open drawer first (the tablet's icon rail has a tile for it, earlier in the page)", () => {
    expect(rowSelectors('s-1')).toEqual(['.tb-drawer.open .ses[data-ping="ses:s-1"]', '.ses[data-ping="ses:s-1"]']);
    expect(rowSelectors('a"b')[1]).toBe('.ses[data-ping="ses:a\\"b"]');
    const pop = readFileSync(join(__dirname, '../src/components/SessionFlag.tsx'), 'utf8');
    // a beat later: never inside the keystroke or click that closed it
    expect(pop).toMatch(/setTimeout\(\(\) => rowOf\(s\.id\)\?\.focus\(\), 0\)/);
  });
});

