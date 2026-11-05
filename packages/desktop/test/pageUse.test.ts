import { describe, expect, it } from 'vitest';
import { PING_MS, usedPings } from '../src/pageUse';

describe("a page you're using, told to the dashboard", () => {
  it('scrolling, keys, clicks and touches count, at most once a second; the mouse passing over does not', () => {
    let t = 0;
    const used = usedPings(() => t);
    expect(used('mouseMove')).toBe(false);
    expect(used('mouseEnter')).toBe(false);
    expect(used(undefined)).toBe(false);
    expect(used('mouseWheel')).toBe(true);
    // reading on: the next a second later
    t = 400;
    expect(used('mouseWheel')).toBe(false);
    t = PING_MS;
    expect(used('keyDown')).toBe(true);
    t = PING_MS * 2;
    expect(used('mouseDown')).toBe(true);
    t = PING_MS * 3;
    expect(used('gestureScrollUpdate')).toBe(true);
  });
});
