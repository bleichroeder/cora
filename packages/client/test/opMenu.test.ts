import { beforeEach, describe, expect, it, vi } from 'vitest';
import { menuStyle, onField, useOp } from '../src/state/onepassword';

vi.mock('../src/lib/desktop', () => ({ desktop: { opFill: async () => ({}) } }));

const view = { w: 1600, h: 900 };
const page = { left: 700, top: 120, right: 1580 };

describe("1Password's menu: where it opens", () => {
  it('under the field that asked, lined up with it', () => {
    expect(menuStyle({ at: { x: 100, y: 200, w: 300, h: 32 } }, page, view)).toMatchObject({ top: 358, left: 800 });
  });
  it("under the address bar's key, its right edge on the key's", () => {
    expect(menuStyle({ anchor: { left: 1500, top: 80, right: 1522, bottom: 102 } }, page, view)).toMatchObject({ top: 108, left: 1122 });
  });
  it("above a field near the bottom, and never off screen", () => {
    const s = menuStyle({ at: { x: 1000, y: 700, w: 300, h: 32 } }, page, view);
    expect(s).toMatchObject({ top: 'auto', bottom: 900 - 820 + 6, left: 1600 - 400 - 8 });
  });
  it("with nothing to go by: the page's top right; no page: Cora's default place", () => {
    expect(menuStyle({}, page, view)).toMatchObject({ top: 128, left: 1580 - 12 - 400 });
    expect(menuStyle({}, null, view)).toEqual({});
  });
});

describe('the key in a login field', () => {
  beforeEach(() => useOp.setState({ menu: null, field: {}, settings: { on: true, otp: true, tools: true, suggest: true } }));

  it('clicked: the menu opens under that field', () => {
    onField({ from: 7, k: 'open', r: { x: 1, y: 2, w: 3, h: 4 }, unlocked: false }, true);
    expect(useOp.getState().menu).toEqual({ from: 7, at: { x: 1, y: 2, w: 3, h: 4 } });
  });
  it('focused: suggests only while 1Password is unlocked, and only on pages that may be filled', () => {
    onField({ from: 7, k: 'focus', r: { x: 1, y: 2, w: 3, h: 4 }, unlocked: false }, true);
    expect(useOp.getState().menu).toBeNull();
    expect(useOp.getState().field[7]).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    onField({ from: 7, k: 'focus', r: { x: 1, y: 2, w: 3, h: 4 }, unlocked: true }, false);
    expect(useOp.getState().menu).toBeNull();
    onField({ from: 7, k: 'focus', r: { x: 1, y: 2, w: 3, h: 4 }, unlocked: true }, true);
    expect(useOp.getState().menu).toMatchObject({ from: 7, suggest: true });
  });
  it("focused with suggestions off: nothing; a menu you opened isn't replaced by a suggestion", () => {
    useOp.setState({ settings: { on: true, otp: true, tools: true, suggest: false } });
    onField({ from: 7, k: 'focus', unlocked: true }, true);
    expect(useOp.getState().menu).toBeNull();
    useOp.setState({ settings: { on: true, otp: true, tools: true, suggest: true }, menu: { from: 7 } });
    onField({ from: 7, k: 'focus', unlocked: true }, true);
    expect(useOp.getState().menu).toEqual({ from: 7 });
  });
  it('left: a suggestion goes (a moment later), a menu you opened stays', async () => {
    vi.useFakeTimers();
    useOp.setState({ menu: { from: 7, suggest: true } });
    onField({ from: 7, k: 'blur', unlocked: true }, true);
    vi.advanceTimersByTime(250);
    expect(useOp.getState().menu).toBeNull();
    useOp.setState({ menu: { from: 7 } });
    onField({ from: 7, k: 'blur', unlocked: true }, true);
    vi.advanceTimersByTime(250);
    expect(useOp.getState().menu).toEqual({ from: 7 });
    vi.useRealTimers();
  });
});
