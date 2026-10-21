import { describe, expect, it } from 'vitest';
import { ASPECTS, KEEP_OUT_LIGHT, MAX_LUMA, PLANET_TYPES, clearOfKeepOut, clearOfPlanet, discGap, fit, keepOutLight, litOnScreen, luma, makeSystem, shiftPalette, sunDir } from '../src/scene/system/generate';

const seeds = Array.from({ length: 1000 }, (_, i) => (i * 2654435761) >>> 0);

describe('star systems', () => {
  it('the same seed gives the same system; different seeds differ', () => {
    expect(makeSystem(42)).toEqual(makeSystem(42));
    expect(makeSystem(42)).not.toEqual(makeSystem(43));
  });

  it("never lights the agents' area, and moons and the belt stay out of it", () => {
    for (const seed of seeds) {
      const s = makeSystem(seed);
      // (a visible sun lights from the side; the shader dims the agents' area instead)
      if (!s.star.sun) expect(keepOutLight(s), `seed ${seed}`).toBeLessThanOrEqual(KEEP_OUT_LIGHT);
      for (const m of s.moons) expect(clearOfKeepOut(m.anchor, m.radius), `seed ${seed} moon`).toBe(true);
      if (s.belt) expect(Math.abs(s.belt.y) - Math.abs(s.belt.slope) * 1.3, `seed ${seed} belt`).toBeGreaterThan(0.72);
    }
  });

  it('a larger or smaller planet is still kept clear of the agents', () => {
    for (const size of [0.75, 1.2]) for (const seed of seeds.slice(0, 400)) {
      const s = makeSystem(seed, { size });
      if (!s.star.sun) expect(keepOutLight(s), `seed ${seed} size ${size}`).toBeLessThanOrEqual(KEEP_OUT_LIGHT);
      for (const m of s.moons) expect(clearOfKeepOut(m.anchor, m.radius)).toBe(true);
    }
    // same system, other size: the same kind of planet in the same corner
    const a = makeSystem(seeds[7]);
    const b = makeSystem(seeds[7], { size: 0.75 });
    expect(b.planet.type).toBe(a.planet.type);
    expect(Math.sign(b.planet.anchor[0])).toBe(Math.sign(a.planet.anchor[0]));
    // smaller on the whole (one seed can differ: fitting a planet may redraw it)
    const mean = (size: number) => seeds.slice(0, 300).reduce((t, x) => t + makeSystem(x, { size }).planet.radius, 0) / 300;
    expect(mean(0.75)).toBeLessThan(mean(1) * 0.85);
    expect(mean(1.2)).toBeGreaterThan(mean(1));
  });

  it('moons never sit in the planet (or its rings) or in each other, at any view shape', () => {
    let seen = 0;
    for (const seed of seeds) {
      const s = makeSystem(seed);
      for (const [i, m] of s.moons.entries()) {
        seen++;
        expect(clearOfPlanet(s.planet, m.anchor, m.radius), `seed ${seed} moon ${i}`).toBe(true);
        // never by the resources' labels on the right
        expect(m.anchor[0] < 0.72 || Math.abs(m.anchor[1]) > 0.78, `seed ${seed} moon ${i} at the right`).toBe(true);
        // nor beside the main agent at the left middle
        expect(m.anchor[0] > -0.8 || Math.abs(m.anchor[1]) >= 0.45, `seed ${seed} moon ${i} by the main agent`).toBe(true);
        for (const o of s.moons.slice(i + 1)) for (const a of ASPECTS) expect(discGap(m.anchor, fit(m.radius, a), o.anchor, fit(o.radius, a), a)).toBeGreaterThan(0);
      }
    }
    expect(seen).toBeGreaterThan(300);
  });

  it('shifts a palette per system without making it brighter than the cap', () => {
    const p = shiftPalette(['#3a2420', '#5a3226', '#7a4a36', '#a89070'], 17, 1.15);
    expect(p).not.toEqual(['#3a2420', '#5a3226', '#7a4a36', '#a89070']);
    for (const c of p) expect(luma(c)).toBeLessThanOrEqual(MAX_LUMA);
    const looks = new Set(seeds.slice(0, 200).map((x) => makeSystem(x).planet.palette.join()));
    expect(looks.size).toBeGreaterThan(150);
  });

  it('a visible sun: often, clear of the agents, the planet and the moons, lighting the face we see', () => {
    let suns = 0;
    for (const seed of seeds) {
      const s = makeSystem(seed);
      const sun = s.star.sun;
      if (!sun) continue;
      suns++;
      expect(clearOfKeepOut(sun.anchor, sun.radius * 2.5), `seed ${seed}`).toBe(true);
      expect(clearOfPlanet(s.planet, sun.anchor, 0.18), `seed ${seed}`).toBe(true);
      for (const m of s.moons) for (const a of ASPECTS) expect(discGap(m.anchor, fit(m.radius, a), sun.anchor, fit(sun.radius * 2.5, a), a)).toBeGreaterThan(0);
      expect(s.star.dir).toEqual(sunDir(s.planet.anchor, sun.anchor));
      expect(litOnScreen(s)).toBeGreaterThanOrEqual(0.2);
      expect(Math.abs(sun.anchor[1])).toBeGreaterThanOrEqual(0.8);
    }
    expect(suns).toBeGreaterThan(200);
    expect(suns).toBeLessThan(700);
  });

  it('city lights on most ocean worlds, now and then on rocky or desert ones, never elsewhere', () => {
    const all = seeds.map((x) => makeSystem(x));
    const ocean = all.filter((s) => s.planet.type === 'ocean');
    expect(ocean.filter((s) => s.planet.cities > 0).length / ocean.length).toBeGreaterThan(0.55);
    expect(all.some((s) => (s.planet.type === 'rocky' || s.planet.type === 'desert') && s.planet.cities > 0)).toBe(true);
    expect(all.every((s) => s.planet.cities === 0 || ['ocean', 'rocky', 'desert'].includes(s.planet.type))).toBe(true);
  });

  it('keeps every background colour dim enough never to bloom', () => {
    for (const seed of seeds) {
      const s = makeSystem(seed);
      const p = s.planet;
      // lava's seams glow, but only on the night side and at a fraction
      const surface = p.type === 'lava' ? p.palette.slice(0, 3) : p.palette;
      for (const c of surface) expect(luma(c), `seed ${seed} ${c}`).toBeLessThanOrEqual(MAX_LUMA);
      expect(luma(p.atmo) * p.atmoK).toBeLessThanOrEqual(MAX_LUMA);
      for (const m of s.moons) for (const c of m.palette) expect(luma(c)).toBeLessThanOrEqual(MAX_LUMA);
      for (const n of s.nebula) expect(luma(n.color)).toBeLessThanOrEqual(MAX_LUMA);
      if (s.planet.rings) expect(luma(s.planet.rings.color)).toBeLessThanOrEqual(MAX_LUMA);
    }
  });

  it('every planet type, and moons, rings and belts, turn up across seeds', () => {
    const all = seeds.map((s) => makeSystem(s));
    for (const t of PLANET_TYPES) expect(all.some((s) => s.planet.type === t), t).toBe(true);
    expect(all.some((s) => s.moons.length > 0)).toBe(true);
    expect(all.some((s) => s.moons.length === 0)).toBe(true);
    expect(all.some((s) => s.planet.rings)).toBe(true);
    expect(all.some((s) => s.belt)).toBe(true);
    expect(all.some((s) => s.planet.clouds)).toBe(true);
  });

  it('the planet sits in a corner, mostly off the frame', () => {
    for (const seed of seeds.slice(0, 200)) {
      const { anchor } = makeSystem(seed).planet;
      expect(Math.abs(anchor[0])).toBeGreaterThanOrEqual(0.95);
      expect(Math.abs(anchor[1])).toBeGreaterThanOrEqual(0.85);
    }
  });
});
