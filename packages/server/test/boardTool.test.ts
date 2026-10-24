import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@cora/shared';
import { Prefs } from '../src/prefs';
import { nudgeFor } from '../src/hosted';

describe('sessions and the Board', () => {
  it('may add (and show) a page laid out for their work unless you turn it off', () => {
    const p = new Prefs(null);
    expect(p.get().board).toEqual({ pages: 'show' });
    expect(p.update({ board: { pages: 'add' } }).board).toEqual({ pages: 'add' });
    expect(() => p.update({ board: { pages: 'always' } })).toThrow(/board.pages/);
  });

  it('are told about it only when it is on', () => {
    expect(nudgeFor(DEFAULT_SETTINGS.explains, undefined, 'off', 'show')).toMatch(/`board` tool once with that kind of work/);
    expect(nudgeFor(DEFAULT_SETTINGS.explains, undefined, 'off', 'off')).not.toMatch(/`board` tool/);
  });
});
