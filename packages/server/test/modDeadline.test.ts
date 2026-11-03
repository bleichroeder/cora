import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lateModWords, modDeadline, stuckModWords } from '../src/modDeadline';

describe("a new seat's deliveries when its mod hasn't come", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const queue = new Map<string, string[]>();
    const modded = new Set<string>();
    const typed: Array<[string, string]> = [];
    const told: string[] = [];
    const stuck: Array<[string, string]> = [];
    const done: string[] = [];
    const logs: string[] = [];
    /** each typing-in settles when the test says: in, not in (why), or it throws */
    const pending: Array<(how: { sent: true } | { sent: false; why: string } | { throws: string }) => void> = [];
    const d = modDeadline({
      waitMs: 90_000,
      modded: (sid) => modded.has(sid),
      take: (sid) => {
        const q = queue.get(sid) ?? [];
        queue.delete(sid);
        return q;
      },
      putBack: (sid, items) => queue.set(sid, [...items, ...(queue.get(sid) ?? [])]),
      typeIn: (sid, text) =>
        new Promise((res, rej) =>
          pending.push((how) => {
            if ('throws' in how) return rej(new Error(how.throws));
            if (how.sent) typed.push([sid, text]);
            res(how.sent ? { sent: true } : { sent: false, why: how.why });
          }),
        ),
      tell: (sid) => told.push(sid),
      stuck: (sid, why) => stuck.push([sid, why]),
      done: (sid) => done.push(sid),
      log: (m) => logs.push(m),
    });
    const push = (sid: string, text: string) => {
      queue.set(sid, [...(queue.get(sid) ?? []), text]);
      d.arm(sid);
    };
    const settle = async (how: Parameters<(typeof pending)[number]>[0] = { sent: true }) => {
      pending.shift()?.(how);
      await vi.advanceTimersByTimeAsync(0);
    };
    return { d, queue, modded, typed, told, stuck, done, logs, push, settle };
  };

  it('after the wait, what waited is typed in as one prompt, and then the user is told', async () => {
    const s = setup();
    s.push('s1', 'Begin.');
    vi.advanceTimersByTime(30_000);
    s.push('s1', 'New work for Encoders.');
    vi.advanceTimersByTime(60_000);
    expect(s.d.typing('s1')).toBe(true);
    // not said before it's in
    expect(s.told).toEqual([]);
    await s.settle();
    expect(s.typed).toEqual([['s1', 'Begin.\n\nNew work for Encoders.']]);
    expect(s.told).toEqual(['s1']);
    expect(s.queue.has('s1')).toBe(false);
    expect(s.done).toEqual(['s1']);
    expect(s.d.typing('s1')).toBe(false);
  });

  it('what comes while that is typed in waits behind it (never typed into a terminal not ready yet), then goes in', async () => {
    const s = setup();
    s.push('s1', 'Begin.');
    vi.advanceTimersByTime(90_000);
    s.d.add('s1', "Your team change wasn't taken.");
    await s.settle();
    expect(s.typed).toEqual([['s1', 'Begin.']]);
    expect(s.done).toEqual([]);
    await s.settle();
    expect(s.typed).toEqual([['s1', 'Begin.'], ['s1', "Your team change wasn't taken."]]);
    expect(s.done).toEqual(['s1']);
  });

  it("not typed in (a question on its screen): never lost: back for its mod, in order, said once, tried again; its mod takes it when it comes", async () => {
    const s = setup();
    s.push('s1', 'Begin.');
    vi.advanceTimersByTime(90_000);
    s.d.add('s1', 'Then this.');
    await s.settle({ sent: false, why: "it's asking whether to trust the folder" });
    expect(s.queue.get('s1')).toEqual(['Begin.', 'Then this.']);
    expect(s.stuck).toEqual([['s1', "it's asking whether to trust the folder"]]);
    expect(s.told).toEqual([]);
    expect(s.done).toEqual([]);
    expect(s.d.typing('s1')).toBe(false);
    expect(s.d.armed('s1')).toBe(true);
    // tried again, still asking: said once only
    vi.advanceTimersByTime(90_000);
    await s.settle({ sent: false, why: "it's asking whether to trust the folder" });
    expect(s.stuck).toHaveLength(1);
    expect(s.queue.get('s1')).toEqual(['Begin.', 'Then this.']);
    // its mod comes: it takes them from the queue itself; nothing is typed
    s.modded.add('s1');
    vi.advanceTimersByTime(90_000);
    expect(s.typed).toEqual([]);
    expect(s.queue.get('s1')).toEqual(['Begin.', 'Then this.']);
  });

  it('typing in that throws: logged, nothing lost, tried again', async () => {
    const s = setup();
    s.push('s1', 'Begin.');
    vi.advanceTimersByTime(90_000);
    await s.settle({ throws: 'terminal gone' });
    expect(s.logs).toEqual(['team: typing into s1 failed: terminal gone']);
    expect(s.queue.get('s1')).toEqual(['Begin.']);
    expect(s.d.armed('s1')).toBe(true);
  });

  it('its mod came meanwhile (it took them): nothing typed, nothing said', () => {
    const s = setup();
    s.push('s1', 'Begin.');
    s.modded.add('s1');
    vi.advanceTimersByTime(90_000);
    expect(s.typed).toEqual([]);
    expect(s.told).toEqual([]);
  });

  it('nothing left waiting at the deadline: nothing to do', () => {
    const s = setup();
    s.push('s1', 'Begin.');
    s.queue.delete('s1');
    vi.advanceTimersByTime(90_000);
    expect(s.typed).toEqual([]);
    expect(s.told).toEqual([]);
    expect(s.d.armed('s1')).toBe(false);
  });

  it('the words: late, not never; typed in only once it was; why it could not be, and that it is not lost', () => {
    expect(lateModWords('Triage', 90_000)).toBe("Triage's Cora mod hadn't connected after 90 seconds, so what Cora had for it was typed into its terminal instead.");
    expect(stuckModWords('Triage', 90_000, "it's asking whether to trust the folder.")).toBe("Triage's Cora mod hadn't connected after 90 seconds, and what Cora has for it couldn't be typed into its terminal (it's asking whether to trust the folder). It isn't lost: its mod takes it when it connects, or Cora tries typing it in again.");
  });
});
