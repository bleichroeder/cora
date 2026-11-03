import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverWhenReady, promptReady } from '../src/orchestrator/deliver';

/**
 * A session Cora starts gets its first prompt once it's ready (found live: two sessions, up within seconds, never got
 * theirs, and "never got its first prompt: it wasn't ready for a prompt within a minute" came after three).
 */
const RULE = '─'.repeat(80);
const box = ['older output', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on (shift+tab to cycle)'];

describe('promptReady', () => {
  it('the input box, also with a band of its own below it (another pair of rules)', () => {
    expect(promptReady(box)).toBe(true);
    expect(promptReady([...box, RULE, ' Cora · Native Drill · 2 waiting', RULE])).toBe(true);
    expect(promptReady([...box, RULE, ' a band', ' two lines', RULE, '  status'])).toBe(true);
  });
  it('a multi-line draft in the box is still the box', () => {
    expect(promptReady(['x', RULE, '❯ first line', '  second line', RULE, '  status'])).toBe(true);
  });
  it('not before the box is drawn, and not while a choice is open', () => {
    expect(promptReady(['Claude Code v2.1.316', 'loading…'])).toBe(false);
    expect(promptReady(['● Bash(rm -rf build)', RULE, ' Bash command', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', RULE])).toBe(false);
  });
});

describe('deliverWhenReady', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const term = (screen: string[]) => {
    const typed: string[] = [];
    return { typed, o: { screen: () => screen, type: (t: string) => void typed.push(t), alive: () => true } };
  };

  it('a session that has said it started (its hooks, its mod) and shows no question gets its prompt, even when its screen reads oddly', async () => {
    const { typed, o } = term(['Claude Code v2.1.316', 'something Cora does not recognise']);
    let started = false;
    const job = deliverWhenReady({ ...o, started: () => started }, 'go', 10 * 60_000, 500);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(typed).toEqual([]);
    started = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await job).toEqual({ sent: true });
    expect(typed).toEqual(['go']);
  });
  it('slow: says so once, then keeps waiting (well past three minutes) instead of giving up', async () => {
    const screen: string[] = ['starting'];
    const slow: number[] = [];
    const { typed, o } = term(screen);
    const job = deliverWhenReady({ ...o, onSlow: () => void slow.push(Date.now()) }, 'go', 10 * 60_000, 500);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(slow).toHaveLength(1);
    screen.splice(0, 1, ...box);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await job).toEqual({ sent: true });
    expect(typed).toEqual(['go']);
  });
  it('given up: says how long it waited (not "a minute" when it was ten)', async () => {
    const { o } = term(['starting']);
    const job = deliverWhenReady(o, 'go', 10 * 60_000, 500);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    expect((await job).why).toBe("it wasn't ready for a prompt within 10 minutes");
  });
  it("a question on screen still stops it, whatever the session said (it's the user's to answer)", async () => {
    const { typed, o } = term(['● Bash(rm -rf build)', RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', RULE]);
    const job = deliverWhenReady({ ...o, started: () => true }, 'go', 60_000, 500);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(typed).toEqual([]);
    expect((await job).sent).toBe(false);
  });
});
