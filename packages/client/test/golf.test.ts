import { describe, expect, it } from 'vitest';
import {
  accel, advance, basin, better, clearOf, flight, FRICTION, G, holeName, HOLE_CLEAR, HOLE_R, launch, newCard, NO_BEST, parFor, placeHole, placeTee,
  preview, PULL_MAX, PULL_MIN, seeded, sink, stroke, toParText, VMAX, VSHOT, type Bounds, type Flight, type Outcome, type Well,
} from '../src/scene/golf/physics';

const B: Bounds = { x0: -11, x1: 15.4, y0: -7.6, y1: 7.6 };
const main: Well = { key: 'agent:main', x: -8.5, y: 0, m: 1, r: 0.85 };
const sub = (y: number): Well => ({ key: `agent:s${y}`, x: 1.2, y, m: 0.45, r: 0.52 });

/** flies until something happens (or `max` seconds) */
function fly(f: Flight, wells: Well[], hole: { x: number; y: number } | null = null, max = 30): Outcome {
  for (let t = 0; t < max; t += 1 / 60) {
    const o = advance(f, wells, hole, B, 1 / 60);
    if (o.kind !== 'fly') return o;
  }
  return { kind: 'fly' };
}

describe('gravity golf: the field', () => {
  it('pulls toward a well, harder up close, and softly (finitely) at its centre', () => {
    const near = accel(-6.5, 0, [main], null), far = accel(-2.5, 0, [main], null);
    expect(near.x).toBeLessThan(0);
    expect(Math.abs(near.y)).toBeLessThan(1e-9);
    expect(Math.abs(near.x)).toBeGreaterThan(Math.abs(far.x) * 5);
    expect(Number.isFinite(accel(main.x, main.y, [main], null).x)).toBe(true);
    // roughly inverse-square away from the softening
    expect(Math.abs(near.x)).toBeCloseTo((G * main.m) / 4, -0.5);
  });

  it('a ball out in the open slows to a stop on its own and comes to rest', () => {
    const f = flight(0, 0, 6, 0);
    const o = fly(f, []);
    expect(o.kind).toBe('rest');
    expect(f.ball.x).toBeGreaterThan(2);
    expect(f.ball.x).toBeLessThan(10);
    expect(f.t).toBeLessThan(4);
  });

  it('a resting ball outside a basin stays put; inside one it rolls in and is swallowed', () => {
    const outside = flight(main.x + basin(main) + 0.6, 0, 0, 0);
    expect(fly(outside, [main]).kind).toBe('rest');
    expect(outside.ball.x).toBeCloseTo(main.x + basin(main) + 0.6, 5);
    const inside = flight(main.x + basin(main) - 1.5, 0, 0, 0);
    const o = fly(inside, [main]);
    expect(o).toMatchObject({ kind: 'absorbed', well: { key: 'agent:main' } });
  });

  it('a shot past a well bends toward it', () => {
    const straight = flight(-4, 3, -9, 0);
    fly(straight, []);
    const bent = flight(-4, 3, -9, 0);
    const o = fly(bent, [main]);
    expect(o.kind === 'rest' || o.kind === 'absorbed' || o.kind === 'out').toBe(true);
    // it was pulled down toward main (y = 0) where the straight one held its line
    expect(straight.ball.y).toBeCloseTo(3, 5);
    expect(bent.ball.y).toBeLessThan(2.5);
  });

  it('a fast shot can slingshot around a well without falling in, and energy never grows out of nowhere', () => {
    // tangential shot near main: orbital speed there is about sqrt(G m / r)
    const r = 2.2;
    const f = flight(main.x, r, Math.sqrt((G * main.m) / r) * 1.25, 0);
    const o = fly(f, [main], null, 1.2);
    expect(o.kind).not.toBe('absorbed');
    // with friction and drag, kinetic + potential energy only ever drops (no integrator blow-up)
    const energy = (x: Flight) => 0.5 * (x.ball.vx ** 2 + x.ball.vy ** 2) - (G * main.m) / Math.sqrt((x.ball.x - main.x) ** 2 + x.ball.y ** 2 + 0.45 ** 2);
    const g = flight(main.x, r, 6, 0);
    let e = energy(g);
    for (let i = 0; i < 120; i++) {
      if (advance(g, [main], null, B, 1 / 60).kind !== 'fly') break;
      const e2 = energy(g);
      expect(e2).toBeLessThanOrEqual(e + 1e-3);
      e = e2;
    }
  });

  it('straight at a core is swallowed by that well', () => {
    const o = fly(flight(-3, 0, -10, 0), [main, sub(3.4)]);
    expect(o).toMatchObject({ kind: 'absorbed', well: { key: 'agent:main' } });
  });

  it('leaving the field is out', () => {
    expect(fly(flight(13, 0, 16, 0), []).kind).toBe('out');
    expect(fly(flight(0, 6, 0, 16), []).kind).toBe('out');
  });

  it('never goes faster than the cap, even falling into a well', () => {
    const f = flight(main.x + 4, 0.9, -VMAX, 0);
    for (let i = 0; i < 60; i++) {
      advance(f, [main], null, B, 1 / 60);
      expect(Math.hypot(f.ball.vx, f.ball.vy)).toBeLessThanOrEqual(VMAX + 1e-6);
    }
  });
});

describe('gravity golf: the hole', () => {
  it('a ball rolling through the hole drops in; one skimming over it too fast does not (and says so)', () => {
    const hole = { x: 4, y: 0 };
    expect(fly(flight(0, 0, 6, 0), [], hole).kind).toBe('sunk');
    const fast = flight(0, 0, 12, 0);
    const o = fly(fast, [], hole);
    expect(o.kind).not.toBe('sunk');
    expect(fast.hot).toBe(true);
    expect(fast.ball.x).toBeGreaterThan(hole.x + 1);
  });

  it('a near miss curls in (the wormhole pulls a little)', () => {
    const hole = { x: 4, y: 0 };
    // aimed just wide of the mouth, rolling slowly as it gets there
    const f = flight(0, HOLE_R + 0.15, 5.4, 0);
    expect(fly(f, [], hole).kind).toBe('sunk');
  });

  it('is never placed inside (or hugging) a well, and stays on the field', () => {
    const wells = [main, sub(3.4), sub(-3.4), sub(0), { key: 'anthropic', x: -8.5, y: 5.4, m: 0.3, r: 0.32 }, ...[3.2, 1.6, 0, -1.6, -3.2].map((y, i) => ({ key: `res:${i}`, x: 11, y, m: 0.16, r: 0.36 }))];
    for (let s = 1; s <= 200; s++) {
      const rng = seeded(s);
      const tee = placeTee(rng, wells, B);
      const hole = placeHole(rng, wells, B, tee);
      for (const w of wells) {
        expect(Math.hypot(hole.x - w.x, hole.y - w.y)).toBeGreaterThanOrEqual(w.r + HOLE_CLEAR - 1e-9);
        expect(Math.hypot(tee.x - w.x, tee.y - w.y)).toBeGreaterThan(w.r);
      }
      expect(hole.x).toBeGreaterThan(B.x0);
      expect(hole.x).toBeLessThan(B.x1);
      expect(hole.y).toBeGreaterThan(B.y0);
      expect(hole.y).toBeLessThan(B.y1);
      expect(Math.hypot(hole.x - tee.x, hole.y - tee.y)).toBeGreaterThan(3.9);
    }
  });

  it('tees up out in the open, not on a ridge inside a basin, when there is room', () => {
    const wells = [main, { key: 'anthropic', x: -8.5, y: 5.4, m: 0.3, r: 0.32 }, sub(3.4)];
    for (let s = 1; s <= 100; s++) {
      const tee = placeTee(seeded(s), wells, B);
      for (const w of wells) expect(Math.hypot(tee.x - w.x, tee.y - w.y)).toBeGreaterThanOrEqual(basin(w) * 0.9);
      const a = accel(tee.x, tee.y, wells, null);
      expect(Math.hypot(a.x, a.y)).toBeLessThan(FRICTION);
    }
  });

  it('a field crowded with wells still gets a hole clear of all of them', () => {
    const crowd: Well[] = [];
    for (let x = -10; x <= 14; x += 3) for (let y = -6; y <= 6; y += 3) crowd.push({ key: `w${x},${y}`, x, y, m: 0.2, r: 0.5 });
    const hole = placeHole(seeded(7), crowd, B, { x: 0, y: 0 });
    for (const w of crowd) expect(Math.hypot(hole.x - w.x, hole.y - w.y)).toBeGreaterThan(w.r);
  });

  it('a lie a well has moved onto is pushed back out of it', () => {
    const p = clearOf({ x: main.x + 0.2, y: 0.1 }, [main]);
    expect(Math.hypot(p.x - main.x, p.y - main.y)).toBeGreaterThanOrEqual(main.r + 0.6 - 1e-9);
  });
});

describe('gravity golf: shots', () => {
  it('slings opposite the pull, harder the further you pull, up to a cap; a tiny pull is no shot', () => {
    expect(launch({ x: PULL_MIN / 2, y: 0 })).toBeNull();
    const half = launch({ x: PULL_MAX / 2, y: 0 })!;
    expect(half.x).toBeCloseTo(-VSHOT / 2);
    expect(half.y).toBeCloseTo(0);
    const over = launch({ x: 0, y: -PULL_MAX * 3 })!;
    expect(over.y).toBeCloseTo(VSHOT);
  });

  it('a full shot carries most of the field; a soft one a few units', () => {
    const full = flight(-10, 0, VSHOT, 0);
    expect(fly(full, [], null).kind).toBe('rest');
    expect(full.ball.x - -10).toBeGreaterThan(15);
    expect(full.ball.x - -10).toBeLessThan(26);
    const soft = flight(0, 0, VSHOT / 4, 0);
    fly(soft, []);
    expect(soft.ball.x).toBeGreaterThan(1);
    expect(soft.ball.x).toBeLessThan(6);
  });

  it('the preview shows only the start of the path and follows the field', () => {
    const pts = preview({ x: -4, y: 3 }, { x: -9, y: 0 }, [main], null, B, 0.7, 0.05);
    expect(pts.length).toBe(14);
    expect(pts.at(-1)!.x).toBeGreaterThan(-4 - 9 * 0.7 - 0.5);
    expect(pts.at(-1)!.y).toBeLessThan(3);
    // stops where the ball would be swallowed
    expect(preview({ x: -6, y: 0 }, { x: -12, y: 0 }, [main], null, B, 1).length).toBeLessThan(10);
  });

  it('friction is what settles a ball, so it really stops (not creeping forever)', () => {
    const f = flight(0, 0, 0.5, 0);
    expect(fly(f, [], null, 2).kind).toBe('rest');
    expect(f.ball.x).toBeLessThan(0.5 / FRICTION);
  });
});

describe('gravity golf: score', () => {
  it('names holes against par', () => {
    expect(holeName(1, 3)).toBe('hole in one');
    expect(holeName(2, 4)).toBe('eagle');
    expect(holeName(2, 3)).toBe('birdie');
    expect(holeName(3, 3)).toBe('par');
    expect(holeName(4, 3)).toBe('bogey');
    expect(holeName(5, 3)).toBe('double bogey');
    expect(holeName(7, 3)).toBe('+4');
  });

  it('keeps a running score against par and a streak of holes at par or better', () => {
    let c = newCard(3);
    c = stroke(stroke(c)); // birdie
    let r = sink(c, 4);
    expect(r).toMatchObject({ name: 'birdie', diff: -1 });
    expect(r.card).toEqual({ hole: 2, strokes: 0, par: 4, toPar: -1, streak: 1, tries: 1 });
    c = stroke(stroke(stroke(stroke(r.card))), 2); // 5 on a par 4 (a penalty in there): bogey ends the streak
    r = sink(c, 3);
    expect(r.card).toMatchObject({ hole: 3, toPar: 0, streak: 0 });
    expect(toParText(-3)).toBe('3 under');
    expect(toParText(0)).toBe('even');
    expect(toParText(2)).toBe('2 over');
  });

  it('remembers the best run', () => {
    const b = better(NO_BEST, { hole: 5, strokes: 0, par: 3, toPar: -4, streak: 4, tries: 1 }, true);
    expect(b).toEqual({ under: 4, streak: 4, holes: 1, aces: 1 });
    expect(better(b, { hole: 6, strokes: 0, par: 3, toPar: -2, streak: 0, tries: 1 })).toEqual({ under: 4, streak: 4, holes: 2, aces: 1 });
  });

  it('par follows the hole length', () => {
    expect(parFor({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(2);
    expect(parFor({ x: 0, y: 0 }, { x: 12, y: 0 })).toBe(3);
    expect(parFor({ x: 0, y: 0 }, { x: 20, y: 0 })).toBe(4);
  });
});

describe('retry and the ghost line', () => {
  it('a retry wipes the strokes and counts the try; sinking starts the next hole on its first try', async () => {
    const P = await import('../src/scene/golf/physics');
    const c = P.stroke(P.stroke(P.newCard()));
    const r = P.retry(c);
    expect(r).toMatchObject({ strokes: 0, tries: 2, hole: 1 });
    expect(P.sink(P.stroke(r), 3).card).toMatchObject({ hole: 2, strokes: 0, tries: 1 });
  });

  it('keeps the shot that came nearest the hole, and thins it evenly', async () => {
    const P = await import('../src/scene/golf/physics');
    const hole = { x: 10, y: 0 };
    const a = { pts: [{ x: 0, y: 0 }, { x: 6, y: 0 }], closest: 0 };
    a.closest = P.closestTo(a.pts, hole);
    expect(a.closest).toBe(4);
    const b = { pts: [{ x: 0, y: 0 }, { x: 9, y: 1 }], closest: P.closestTo([{ x: 0, y: 0 }, { x: 9, y: 1 }], hole) };
    expect(P.betterLine(null, a)).toBe(a);
    expect(P.betterLine(a, b)).toBe(b);
    expect(P.betterLine(b, a)).toBe(b);
    const pts = Array.from({ length: 100 }, (_, i) => ({ x: i, y: 0 }));
    const t = P.thin(pts, 5);
    expect(t.map((p) => p.x)).toEqual([0, 25, 50, 74, 99]);
    expect(P.thin(pts.slice(0, 3), 5)).toHaveLength(3);
  });
});
