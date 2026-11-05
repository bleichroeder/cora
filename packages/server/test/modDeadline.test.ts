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

describe('typed in is not in: in is its prompt arriving', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (land: (sid: string, text: string) => boolean) => {
    const queue = new Map<string, Array<{ text: string; typedAt?: number }>>();
    const modded = new Set<string>();
    const typed: string[] = [];
    const told: string[] = [];
    const stuck: Array<[string, string]> = [];
    const done: string[] = [];
    let clock = 1_000;
    const d = modDeadline({
      waitMs: 90_000,
      now: () => clock,
      modded: (sid) => modded.has(sid),
      take: (sid) => {
        const q = queue.get(sid) ?? [];
        queue.delete(sid);
        return q.map((x) => x.text);
      },
      putBack: (sid, items, typedAt) => queue.set(sid, [...items.map((text) => ({ text, ...(typedAt !== undefined ? { typedAt } : {}) })), ...(queue.get(sid) ?? [])]),
      typeIn: async (sid, text) => (typed.push(`${sid}: ${text}`), { sent: true }),
      landed: async (sid, text) => land(sid, text),
      tell: (sid) => told.push(sid),
      stuck: (sid, why) => stuck.push([sid, why]),
      done: (sid) => done.push(sid),
    });
    const push = (sid: string, text: string) => {
      queue.set(sid, [...(queue.get(sid) ?? []), { text }]);
      d.arm(sid);
    };
    const tick = (ms: number) => ((clock += ms), vi.advanceTimersByTimeAsync(ms));
    return { d, queue, modded, typed, told, stuck, done, push, tick };
  };

  it('its prompt came: in (the user is told, the seat is given things as one without a mod from now on)', async () => {
    const s = setup(() => true);
    s.push('s1', 'Begin.');
    await s.tick(90_000);
    expect(s.typed).toEqual(['s1: Begin.']);
    expect(s.done).toEqual(['s1']);
    expect(s.told).toEqual(['s1']);
    expect(s.queue.get('s1')).toBeUndefined();
  });

  it("no prompt came of it (a terminal still starting took the keys): back for its mod, marked typed; its late hello takes it", async () => {
    const s = setup(() => false);
    s.push('s1', 'Begin.');
    await s.tick(90_000);
    expect(s.typed).toEqual(['s1: Begin.']);
    // not in: nothing done, nothing told as delivered; back at the front of its queue, with when it was typed
    expect(s.done).toEqual([]);
    expect(s.told).toEqual([]);
    expect(s.queue.get('s1')).toEqual([{ text: 'Begin.', typedAt: 1_000 + 90_000 }]);
    expect(s.stuck).toEqual([['s1', 'it was typed into its terminal, but no prompt came of it']]);
    // its mod says hello later (2½ minutes in): what waits is still there for it, and nothing is typed again
    s.modded.add('s1');
    await s.tick(90_000);
    expect(s.typed).toEqual(['s1: Begin.']);
    expect(s.queue.get('s1')?.map((x) => x.text)).toEqual(['Begin.']);
  });

  it('its mod came while it was typed in (and no prompt came of it): it waits for the mod, never typed again', async () => {
    let s: ReturnType<typeof setup>;
    s = setup(() => (s.modded.add('s1'), false));
    s.push('s1', 'Begin.');
    await s.tick(90_000);
    expect(s.queue.get('s1')?.map((x) => x.text)).toEqual(['Begin.']);
    // not told it's stuck: the mod has it
    expect(s.stuck).toEqual([]);
    await s.tick(5 * 90_000);
    expect(s.typed).toEqual(['s1: Begin.']);
  });

  it('several seats starting at once: each is given longer for its mod (a third more for each other waiting, three times at most)', async () => {
    const s = setup(() => true);
    for (const sid of ['a', 'b', 'c', 'd', 'e']) s.push(sid, `Begin ${sid}.`);
    // a: 90s; b: 120s; c: 150s; d: 180s; e: 210s capped at 270s (three times)
    await s.tick(90_000);
    expect(s.typed).toEqual(['a: Begin a.']);
    await s.tick(30_000);
    expect(s.typed).toHaveLength(2);
    await s.tick(30_000);
    expect(s.typed).toHaveLength(3);
    // the mods of d and e come at 2½ minutes, as on the test PC: nothing is typed into them
    s.modded.add('d');
    s.modded.add('e');
    await s.tick(120_000);
    expect(s.typed).toHaveLength(3);
    const many = setup(() => true);
    for (let k = 0; k < 12; k++) many.push(`s${k}`, 'x');
    // 90, 120 … 240 before the cap: six; then the rest at 270 (three times 90)
    await many.tick(269_999);
    expect(many.typed).toHaveLength(6);
    await many.tick(1);
    expect(many.typed).toHaveLength(12);
  });
});
