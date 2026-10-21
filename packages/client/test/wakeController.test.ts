import { describe, expect, it } from 'vitest';
import { WakeController, useWake, type WakeDeps } from '../src/lib/wake/controller';

function fakes(o: Partial<{ enabled: boolean; why: string | null; busy: boolean; follow: boolean }> = {}) {
  const log: string[] = [];
  let micOpen = false;
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const st = { enabled: o.enabled ?? true, why: o.why ?? null, busy: o.busy ?? false, follow: o.follow ?? true };
  const worker = { post: (m: any) => log.push(`worker:${m.t}`), onMessage: (_cb: (m: any) => void) => {} };
  const d: WakeDeps = {
    enabled: () => st.enabled,
    canRun: () => st.why,
    busy: () => st.busy,
    startMic: async () => ((micOpen = true), log.push('mic:on'), () => ((micOpen = false), log.push('mic:off'))),
    worker: () => worker,
    listen: (f) => log.push(f ? 'listen:followup' : 'listen'),
    stopListen: () => log.push('stop-listen'),
    isCoraLine: (id) => id.startsWith('cora'),
    followUp: () => st.follow,
    chime: () => log.push('chime'),
    threshold: () => 0.5,
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t: any) => void (t.live = false),
  };
  return { d, log, st, timers, mic: () => micOpen };
}

describe('the wake controller', () => {
  it('waits with the mic open; a hit chimes, closes the mic and captures for Cora', async () => {
    const f = fakes();
    const c = new WakeController(f.d);
    c.sync();
    await Promise.resolve();
    expect(useWake.getState().state).toBe('waiting');
    expect(f.mic()).toBe(true);
    c.hit();
    expect(f.log).toEqual(expect.arrayContaining(['chime', 'mic:off', 'listen']));
    expect(useWake.getState().state).toBe('capturing');
  });

  it('after Cora speaks, a follow-up capture opens, and ends quietly after 6 s without speech', async () => {
    const f = fakes();
    const c = new WakeController(f.d);
    c.sync();
    await Promise.resolve();
    c.hit();
    c.captureEnded();
    c.speechEnded('cora:abc');
    expect(f.log.at(-1)).toBe('listen:followup');
    expect(useWake.getState().state).toBe('followup');
    const t = f.timers.at(-1)!;
    expect(t.ms).toBe(6000);
    t.fn();
    expect(f.log).toContain('stop-listen');
    c.speechEnded('session:x');
    expect(f.log.at(-1)).not.toBe('listen:followup');
  });

  it("pauses while something else is listening or speaking, and stays off when it can't run or is muted", async () => {
    const busy = fakes({ busy: true });
    new WakeController(busy.d).sync();
    await Promise.resolve();
    expect(useWake.getState().state).toBe('paused');
    expect(busy.mic()).toBe(false);
    const cant = fakes({ why: 'Cora is off' });
    new WakeController(cant.d).sync();
    expect(useWake.getState()).toMatchObject({ state: 'paused', why: 'Cora is off' });
    const off = fakes({ enabled: false });
    new WakeController(off.d).sync();
    expect(useWake.getState().state).toBe('off');
    useWake.setState({ muted: true });
    const muted = fakes();
    new WakeController(muted.d).sync();
    expect(useWake.getState().state).toBe('muted');
    expect(muted.mic()).toBe(false);
    useWake.setState({ muted: false });
  });
});
