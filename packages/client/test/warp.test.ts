import { afterEach, describe, expect, it, vi } from 'vitest';
import { WARP_MS, useWarp, warpLevels } from '../src/scene/system/warp';

afterEach(() => {
  vi.useRealTimers();
  useWarp.setState({ phase: 'idle', at: 0, blocked: () => false });
});

describe('the hyperspace jump', () => {
  it('runs out → flash → in → idle, swapping the system at the flash', () => {
    vi.useFakeTimers();
    const swapped: string[] = [];
    expect(useWarp.getState().jump(() => swapped.push(useWarp.getState().phase))).toBe(true);
    expect(useWarp.getState().phase).toBe('out');
    vi.advanceTimersByTime(WARP_MS.out);
    expect(useWarp.getState().phase).toBe('flash');
    expect(swapped).toEqual(['flash']);
    vi.advanceTimersByTime(WARP_MS.flash);
    expect(useWarp.getState().phase).toBe('in');
    vi.advanceTimersByTime(WARP_MS.in);
    expect(useWarp.getState().phase).toBe('idle');
  });

  it('ignores a second jump while one runs, and any jump while the scene is held', () => {
    vi.useFakeTimers();
    const swaps: number[] = [];
    useWarp.getState().jump(() => swaps.push(1));
    expect(useWarp.getState().jump(() => swaps.push(2))).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(swaps).toEqual([1]);
    useWarp.setState({ blocked: () => true });
    expect(useWarp.getState().jump(() => swaps.push(3))).toBe(false);
    expect(useWarp.getState().phase).toBe('idle');
  });

  it('builds the streaks, recedes the old system, flashes, then settles', () => {
    expect(warpLevels('idle', 0)).toEqual({ warp: 0, away: 0, flash: 0 });
    expect(warpLevels('out', 1000).warp).toBe(1);
    expect(warpLevels('out', 500).away).toBe(0);
    expect(warpLevels('out', 1600).away).toBe(1);
    expect(warpLevels('flash', WARP_MS.flash / 2).flash).toBeCloseTo(1);
    expect(warpLevels('in', WARP_MS.in)).toEqual({ warp: 0, away: 0, flash: 0 });
  });
});
