import { describe, expect, it } from 'vitest';
import { headOf, whereOf } from '../src/components/EndSession';

describe('ending a session: where it runs', () => {
  it("a check that failed is \"couldn't tell\", never \"not running\" (so nothing is ended or removed on a guess)", () => {
    expect(whereOf({ hosted: true, checked: true, elsewhere: false })).toBe('hosted');
    expect(whereOf({ hosted: false, checked: true, elsewhere: true })).toBe('elsewhere');
    expect(whereOf({ hosted: false, checked: true, elsewhere: false })).toBe('none');
    // the scan failed, timed out, can't run here, or the request itself failed
    expect(whereOf({ hosted: false, checked: false, elsewhere: false })).toBe('unknown');
    // hosted here needs no scan
    expect(whereOf({ hosted: true, checked: false, elsewhere: false })).toBe('hosted');
  });

  it('its title: what it found; while Check again looks, still what it found last (never a flicker to "End this session?")', () => {
    expect(headOf('unknown', null)).toEqual({ title: 'Is it still running?', icon: 'CircleHelp' });
    expect(headOf('checking', 'unknown')).toEqual({ title: 'Is it still running?', icon: 'CircleHelp' });
    expect(headOf('checking', 'none')).toEqual({ title: 'Remove it from the list?', icon: 'EyeOff' });
    expect(headOf('none', 'unknown').title).toBe('Remove it from the list?');
    // its first look: as before
    expect(headOf('checking', null).title).toBe('End this session?');
    expect(headOf('hosted', null).title).toBe('End this session?');
  });
});
