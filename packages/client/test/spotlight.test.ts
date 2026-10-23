import { describe, expect, it } from 'vitest';
import { HOLD_MS, candidates, choose, parseKey, spotKey, type SpotSignals } from '../src/lib/spotlight';

const at = (now: number, p: Partial<SpotSignals> = {}): SpotSignals => ({ now, needs: 0, testsRunning: false, deployRolling: false, background: 0, ...p });
const none = new Set<string>();

describe('the Spotlight', () => {
  it('ranks what matters: you being needed, then what Claude asked for, failures, things running, then quieter work', () => {
    const s = at(100_000, { needs: 1, asked: { k: 'pipeline', at: 90_000 }, testsRunning: true, background: 2, editAt: 99_000 });
    expect(candidates(s).map((c) => c.k)).toEqual(['needs', 'pipeline', 'tests', 'changes', 'background']);
    // what Claude asked for stays (until it asks for something else), whatever else happens, and even if it's on the page
    const asked = at(10_000_000, { asked: { k: 'context', at: 0, why: 'Watch this' }, testsRunning: true, deployRolling: true });
    expect(choose(asked, null, new Set(['context']))).toMatchObject({ k: 'context', why: 'Watch this' });
    expect(choose({ ...asked, needs: 1 }, null, none).k).toBe('needs');
  });

  it('with nothing going on: a quiet panel that is not already on the page', () => {
    expect(choose(at(0), null, none).k).toBe('agents');
    expect(choose(at(0), null, new Set(['agents'])).k).toBe('changes');
  });

  it('holds what it shows for a while; only urgent things cut in; what no longer applies goes at once', () => {
    const tests = choose(at(0, { testsRunning: true }), null, none);
    expect(tests.k).toBe('tests');
    const cur = { spot: tests, since: 0 };
    // a pipeline starts too, tests still running: tests stay for now, the pipeline waits its turn
    expect(choose(at(5_000, { testsRunning: true, pipeline: { active: true }, deployRolling: true }), cur, none).k).toBe('tests');
    expect(choose(at(HOLD_MS + 1, { testsRunning: true, deployRolling: true }), cur, none).k).toBe('deploys');
    // you're needed: at once
    expect(choose(at(1_000, { testsRunning: true, needs: 1 }), cur, none).k).toBe('needs');
    // tests done (passed): the next thing, without waiting
    expect(choose(at(1_000, { pipeline: { active: true } }), cur, none).k).toBe('pipeline');
  });

  it('never shows a panel already on the page; a pin wins', () => {
    expect(choose(at(0, { testsRunning: true, background: 1 }), null, new Set(['tests'])).k).toBe('background');
    expect(choose(at(0, { needs: 1 }), null, none, 'explain:Release 2.4')).toMatchObject({ k: 'explain', title: 'Release 2.4' });
    expect(parseKey(spotKey({ k: 'explain', title: 'a:b' }))).toEqual({ k: 'explain', title: 'a:b' });
    expect(parseKey('nope')).toBeNull();
  });
});
