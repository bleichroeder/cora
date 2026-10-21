/**
 * A star system behind the scene, from a seed: a distant star, one big planet anchored in a corner (partly off the
 * frame), maybe moons, rings and an asteroid belt, and its own nebula. Pure: the same seed gives the same system.
 *
 * Positions are in view terms: x and y from -1 to 1 across the view (NDC), sizes in view heights (a radius of 1 is
 * half the view's height) for a view at least as wide as tall; a narrower (portrait) view shrinks them with its
 * width (`fit`), so they never stretch across it. The agents, resources and labels live in the keep-out box; a body's lit side stays
 * outside it, only its dark night side may reach in. Every colour stays at or under MAX_LUMA so nothing blooms.
 */

export type PlanetType = 'rocky' | 'desert' | 'ice' | 'lava' | 'ocean' | 'gas';
export const PLANET_TYPES: readonly PlanetType[] = ['rocky', 'desert', 'ice', 'lava', 'ocean', 'gas'];

export type V2 = [number, number];
export type SunKind = 'red' | 'orange' | 'yellow' | 'white' | 'blue';
export type V3 = [number, number, number];

export type StarSystem = {
  seed: number;
  /** the star: the direction light comes from (view space, unit, +z toward you) and its colour */
  /**
   * the star: the direction light comes from (view space, unit, +z toward you) and its colour; `sun`: it's on screen
   * there (view coordinates), its size (view heights) and kind; the light then comes from where it's shown
   */
  star: { dir: V3; color: string; sun?: { anchor: V2; radius: number; kind: SunKind } };
  planet: {
    type: PlanetType;
    /** surface colours, darkest to lightest (lava: the last is its glowing seams) */
    palette: [string, string, string, string];
    /** the atmosphere's rim colour and strength */
    atmo: string;
    atmoK: number;
    /** centre (view coordinates, usually just off the frame) and radius (view heights) */
    anchor: V2;
    radius: number;
    /** axial tilt (radians) and spin (radians per second) */
    tilt: number;
    spin: number;
    clouds: boolean;
    /** city lights on the night side (0: none; else how many) */
    cities: number;
    rings: { inner: number; outer: number; tilt: number; color: string } | null;
    /** a seed for its surface */
    surface: number;
  };
  /** moons: clear of the planet (and its rings) and each other; icy around ice worlds and some gas giants */
  moons: Array<{ anchor: V2; radius: number; color: string; type: 'rocky' | 'ice'; palette: [string, string, string, string]; surface: number }>;
  belt: { y: number; slope: number; count: number; color: string } | null;
  nebula: Array<{ x: number; y: number; z: number; color: string; size: number }>;
  stars: { tint: string; density: number };
};

export const KEEP_OUT = { x: 0.78, y: 0.72 };
export const MAX_LUMA = 0.6;
/** a lit point inside the keep-out may be at most this bright (the rest of the lit side is shown dimmed there) */
export const KEEP_OUT_LIGHT = 0.85;
/** the view shapes a system is checked against (width / height): portrait panes to ultrawide */
export const ASPECTS = [0.55, 0.75, 1, 1.3, 1.8];

/** A body's size in view heights, for a view of this shape: narrower views shrink it with their width. */
export const fit = (radius: number, aspect: number) => radius * Math.min(1, aspect);

/** A small seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Relative luminance of a colour as shown (0..1). */
export function luma(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** a colour as hue (degrees), saturation and lightness (0..1) */
function toHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

/** A palette shifted a little (hue, saturation) for one system, with every colour kept at or under MAX_LUMA. */
export function shiftPalette<T extends string[]>(pal: T, dh: number, ks: number): T {
  return pal.map((c) => {
    const [h, s, l] = toHsl(c);
    let out = hsl((h + dh + 360) % 360, Math.min(1, s * ks), l);
    for (let k = l; luma(out) > MAX_LUMA && k > 0; k -= 0.01) out = hsl((h + dh + 360) % 360, Math.min(1, s * ks), k);
    return out;
  }) as T;
}

const hsl = (h: number, s: number, l: number): string => {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

const PALETTES: Record<PlanetType, Array<{ palette: [string, string, string, string]; atmo: string }>> = {
  rocky: [
    { palette: ['#2e2a26', '#46403a', '#6a6156', '#928676'], atmo: '#8fa3b8' },
    { palette: ['#2f2622', '#4c3a2e', '#6e5644', '#94775e'], atmo: '#b8a08a' },
    { palette: ['#3a2420', '#5a3226', '#7a4a36', '#9a6a52'], atmo: '#c49080' },
    { palette: ['#262a30', '#3a414a', '#58616c', '#7c8590'], atmo: '#94a8c0' },
    { palette: ['#2c2a26', '#4a443a', '#7a6a50', '#a08c6e'], atmo: '#b0a090' },
  ],
  desert: [
    { palette: ['#4a3220', '#6b4a2b', '#8a6238', '#a37a4a'], atmo: '#d0995e' },
    { palette: ['#4d2b22', '#6e3d2d', '#8c553c', '#a66d50'], atmo: '#d98c6a' },
    { palette: ['#5a4a34', '#7a6648', '#9a8460', '#a89070'], atmo: '#d8b888' },
  ],
  ice: [
    { palette: ['#3e4c58', '#5a6a78', '#74879a', '#8496a8'], atmo: '#8cc4ef' },
    { palette: ['#3d4a55', '#566b77', '#6f8792', '#7f98a0'], atmo: '#9ad6d6' },
    { palette: ['#3e4a52', '#5c6c74', '#7d8e96', '#8898a0'], atmo: '#b0d4f0' },
  ],
  lava: [
    { palette: ['#140d0b', '#22150f', '#33201a', '#d9531c'], atmo: '#e2653a' },
    { palette: ['#120c10', '#211520', '#332030', '#c9452a'], atmo: '#d4553c' },
    { palette: ['#160c14', '#26141f', '#3a1e2c', '#e0602a'], atmo: '#e07040' },
  ],
  ocean: [
    { palette: ['#0b2440', '#123a60', '#2b5c4c', '#5e5c40'], atmo: '#5fa6ec' },
    { palette: ['#0a2a3a', '#0f4258', '#2f5a3c', '#4f5a3a'], atmo: '#58b8d8' },
    { palette: ['#0c2236', '#173a58', '#4a5a38', '#6a6a48'], atmo: '#6aa8e0' },
  ],
  gas: [
    { palette: ['#4a3f33', '#6b5a46', '#8c7558', '#a48a68'], atmo: '#d6b48a' },
    { palette: ['#2b3a52', '#3b4f6b', '#566f8f', '#728cab'], atmo: '#8eb4e6' },
    { palette: ['#3d2f45', '#57435f', '#735b7c', '#8d7596'], atmo: '#c49ad6' },
    { palette: ['#4a2e22', '#6e4430', '#946048', '#b07e62'], atmo: '#e0a080' },
    { palette: ['#1f3a3e', '#2e5458', '#47767a', '#6a9a9c'], atmo: '#88d0d0' },
  ],
};

/** how much atmosphere each kind of world has (its haze and rim) */
const ATMO_K: Record<PlanetType, number> = { rocky: 0.22, desert: 0.38, ice: 0.28, lava: 0.35, ocean: 0.55, gas: 0.5 };
const STAR_COLORS = ['#fff1dc', '#ffd9a8', '#d6e6ff', '#ffe9c4'];
/** a visible sun's colour by kind, and how big it shows (red dwarfs swell, blue stars are small and fierce) */
export const SUN: Record<SunKind, { color: string; size: number }> = {
  red: { color: '#ff9a6a', size: 1.3 },
  orange: { color: '#ffc58a', size: 1.1 },
  yellow: { color: '#fff0d8', size: 1 },
  white: { color: '#f2f5ff', size: 0.9 },
  blue: { color: '#c8d8ff', size: 0.75 },
};
/** where a visible sun and the planet sit in depth (the sun a little nearer: it lights the face we see, from the side) */
export const PLANET_DEPTH = 120;
export const SUN_DEPTH = 104;
const T = 0.3443; // tan(19°): the camera's half field of view

/** The light's direction (view space) from a planet at `p` to a sun shown at `s`, for a view of this shape. */
export function sunDir(p: V2, s: V2, aspect = 1.3): V3 {
  const P = [PLANET_DEPTH * p[0] * T * aspect, PLANET_DEPTH * p[1] * T, -PLANET_DEPTH];
  const S = [SUN_DEPTH * s[0] * T * aspect, SUN_DEPTH * s[1] * T, -SUN_DEPTH];
  const d = [S[0] - P[0], S[1] - P[1], S[2] - P[2]];
  const n = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / n, d[1] / n, d[2] / n];
}
const STAR_TINTS = ['#475569', '#3f4a5c', '#4b4f63', '#3d5560', '#52506a'];

/** How lit the planet's surface is at a point of the view (0..1), or null off its disc. */
export function planetLight(s: StarSystem, x: number, y: number, aspect: number): number | null {
  const { anchor } = s.planet;
  const radius = fit(s.planet.radius, aspect);
  const dx = ((x - anchor[0]) * aspect) / radius;
  const dy = (y - anchor[1]) / radius;
  const d2 = dx * dx + dy * dy;
  if (d2 > 1) return null;
  const nz = Math.sqrt(1 - d2);
  const [lx, ly, lz] = s.star.dir;
  return Math.max(0, dx * lx + dy * ly + nz * lz);
}

/** How much of the planet's disc that's on screen (in a typical view) is lit, 0..1. */
export function litOnScreen(s: StarSystem, aspect = 1.3): number {
  let lit = 0, all = 0;
  for (let i = 0; i <= 30; i++)
    for (let j = 0; j <= 30; j++) {
      const l = planetLight(s, -1 + (2 * i) / 30, -1 + (2 * j) / 30, aspect);
      if (l == null) continue;
      all++;
      if (l > 0.15) lit++;
    }
  return all ? lit / all : 0;
}

/** The brightest the planet gets inside the keep-out box, over the view shapes we check. */
export function keepOutLight(s: StarSystem): number {
  let worst = 0;
  for (const aspect of ASPECTS)
    for (let i = 0; i <= 24; i++)
      for (let j = 0; j <= 24; j++) {
        const x = -KEEP_OUT.x + (2 * KEEP_OUT.x * i) / 24;
        const y = -KEEP_OUT.y + (2 * KEEP_OUT.y * j) / 24;
        const l = planetLight(s, x, y, aspect);
        if (l != null) worst = Math.max(worst, l);
      }
  return worst;
}

/** Does a small disc (a moon) stay clear of the keep-out box at every view shape we check? */
export function clearOfKeepOut(anchor: V2, radius: number): boolean {
  return ASPECTS.every((aspect) => Math.abs(anchor[0]) - fit(radius, aspect) / aspect > KEEP_OUT.x || Math.abs(anchor[1]) - fit(radius, aspect) > KEEP_OUT.y);
}

/** `size` scales the planet (and moons); the system is otherwise the same, and still kept clear of the agents. */
/** The gap between two discs on screen (view heights; negative: they overlap), for a view of this shape. */
export function discGap(a: V2, ra: number, b: V2, rb: number, aspect: number): number {
  return Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]) - ra - rb;
}

/** Does a moon stay clear of the planet, and of its rings when it has them, at every view shape we check? */
export function clearOfPlanet(planet: StarSystem['planet'], anchor: V2, radius: number): boolean {
  const reach = planet.rings ? Math.min(planet.rings.outer, 1.75) : 1.06;
  return ASPECTS.every((a) => discGap(planet.anchor, fit(planet.radius, a) * reach, anchor, fit(radius, a), a) > 0.04);
}

export function makeSystem(seed: number, o: { size?: number } = {}): StarSystem {
  const sizeK = o.size ?? 1;
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const range = (a: number, b: number) => a + r() * (b - a);

  const type = pick(PLANET_TYPES);
  const base = pick(PALETTES[type]);
  // each system its own shade of its kind
  const dh = range(-18, 18), ks = range(0.85, 1.15);
  const look = { palette: shiftPalette([...base.palette] as [string, string, string, string], dh, ks), atmo: shiftPalette([base.atmo], dh, ks)[0] };
  const sx = r() < 0.5 ? -1 : 1;
  const sy = r() < 0.5 ? -1 : 1;

  // the planet in its corner, lit from a side that keeps the keep-out dark; tighter until it fits
  let planet: StarSystem['planet'] | null = null;
  let star: StarSystem['star'] | null = null;
  for (let attempt = 0; attempt < 40 && !planet; attempt++) {
    const shrink = 1 - attempt * 0.015;
    const radius = range(0.8, 1.15) * shrink * sizeK;
    const anchor: V2 = [sx * range(1.0, 1.25), sy * range(0.9, 1.15)];
    // the light comes from the side (so a lit crescent shows along the frame's edge, outside the agents' area),
    // a little from behind or in front
    const out = Math.atan2(anchor[1], anchor[0] * 1.3);
    // the light comes from the inner side (toward the agents), turned aside, mostly from in front: the lit side faces
    // the part on screen and the terminator crosses it
    const ang = out + Math.PI + (r() < 0.5 ? -1 : 1) * range(0.45, 1.1);
    const lz = range(0.3, 0.65);
    const k = Math.sqrt(1 - lz * lz);
    const dir: V3 = [Math.cos(ang) * k, Math.sin(ang) * k, lz];
    const candidate: StarSystem = {
      seed,
      star: { dir, color: pick(STAR_COLORS) },
      planet: { type, palette: look.palette, atmo: look.atmo, atmoK: ATMO_K[type], anchor, radius, tilt: range(-0.45, 0.45), spin: range(0.004, 0.012) * (r() < 0.5 ? -1 : 1), clouds: false, cities: 0, rings: null, surface: Math.floor(r() * 1e9) },
      moons: [],
      belt: null,
      nebula: [],
      stars: { tint: '#475569', density: 1 },
    };
    if (keepOutLight(candidate) <= KEEP_OUT_LIGHT) {
      planet = candidate.planet;
      star = candidate.star;
    }
  }
  if (!planet || !star) {
    // a safe fallback: small, far in the corner, lit from outside
    planet = { type, palette: look.palette, atmo: look.atmo, atmoK: ATMO_K[type], anchor: [sx * 1.25, sy * 1.15], radius: 0.6, tilt: 0.2, spin: 0.006, clouds: false, cities: 0, rings: null, surface: Math.floor(r() * 1e9) };
    const a = Math.atan2(sy, sx);
    star = { dir: [Math.cos(a) * 0.95, Math.sin(a) * 0.95, 0.31], color: '#fff1dc' };
  }
  planet.clouds = type === 'ocean' || ((type === 'rocky' || type === 'ice') && r() < 0.5);
  // city lights: most ocean worlds; now and then a colony on a rocky or desert one
  planet.cities = type === 'ocean' ? (r() < 0.75 ? range(0.6, 1) : 0) : type === 'rocky' || type === 'desert' ? (r() < 0.2 ? range(0.2, 0.4) : 0) : 0;
  if (type === 'gas' ? r() < 0.75 : type === 'ice' ? r() < 0.25 : false) {
    planet.rings = { inner: range(1.25, 1.45), outer: range(1.8, 2.3), tilt: range(1.15, 1.4) * (r() < 0.5 ? -1 : 1), color: pick(['#8a7a66', '#7a8494', '#8c8070', '#6f7a86']) };
  }

  // moons: along the frame's edges (not the right one), clear of the agents' area, the planet (and its rings) and each other
  const moons: StarSystem['moons'] = [];
  const nMoons = Math.floor(r() * 3);
  const moonType = (): 'rocky' | 'ice' => (type === 'ice' ? 'ice' : type === 'gas' && r() < 0.5 ? 'ice' : 'rocky');
  for (let i = 0; i < nMoons; i++) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const radius = range(0.04, 0.1) * sizeK;
      // top and bottom edges, or the left one away from its middle (the main agent sits there; the resources' labels
      // run past the agents' area on the right)
      const onTop = r() < 0.65;
      const anchor: V2 = onTop ? [range(-0.95, 0.7), (r() < 0.5 ? -1 : 1) * range(0.8, 0.94)] : [-range(0.84, 0.96), (r() < 0.5 ? -1 : 1) * range(0.45, 0.9)];
      if (!clearOfKeepOut(anchor, radius) || !clearOfPlanet(planet, anchor, radius)) continue;
      if (!moons.every((m) => ASPECTS.every((a) => discGap(m.anchor, fit(m.radius, a), anchor, fit(radius, a), a) > 0.04))) continue;
      const mt = moonType();
      const pal = mt === 'ice' ? pick(PALETTES.ice).palette : (['#3a3834', '#504c46', '#6a655c', '#827a6e'] as [string, string, string, string]);
      const shifted = shiftPalette([...pal] as [string, string, string, string], range(-15, 15), range(0.8, 1.1));
      moons.push({ anchor, radius, color: shifted[2], type: mt, palette: shifted, surface: Math.floor(r() * 1e9) });
      break;
    }
  }

  // a visible sun, about half the time: along the top, bottom or left edge, clear of the planet (its rings), the moons
  // and the agents, placed so it lights the part of the planet on screen
  if (r() < 0.5) {
    const kind = pick(['red', 'orange', 'yellow', 'yellow', 'white', 'blue'] as const);
    for (let attempt = 0; attempt < 40; attempt++) {
      const radius = range(0.018, 0.032) * SUN[kind].size;
      // top or bottom edge only (the left one is where the main agent sits)
      const anchor: V2 = [range(-0.92, 0.65), (r() < 0.5 ? -1 : 1) * range(0.8, 0.92)];
      const halo = radius * 2.5; // the corona stays clear of the agents; the faint glare may spill in
      if (!clearOfKeepOut(anchor, halo) || !clearOfPlanet(planet, anchor, 0.18)) continue;
      if (!moons.every((m) => ASPECTS.every((a) => discGap(m.anchor, fit(m.radius, a), anchor, fit(halo, a), a) > 0.04))) continue;
      const dir = sunDir(planet.anchor, anchor);
      const lit: StarSystem = { seed, star: { dir, color: SUN[kind].color }, planet, moons, belt: null, nebula: [], stars: { tint: '#475569', density: 1 } };
      // it must light the planet's face on screen (not just its far side); in the agents' area the shader dims it
      if (litOnScreen(lit) < 0.2) continue;
      star = { dir, color: SUN[kind].color, sun: { anchor, radius, kind } };
      break;
    }
  }

  // an asteroid belt: a sparse strip along the top or bottom edge, outside the keep-out
  const belt: StarSystem['belt'] = r() < 0.4 ? { y: (r() < 0.5 ? -1 : 1) * range(0.8, 0.92), slope: range(-0.04, 0.04), count: Math.floor(range(90, 160)), color: pick(['#4a4640', '#4f4a44', '#45484d']) } : null;

  // the nebula: two or three colours in one family, from the hues real nebulae glow in (hydrogen reds and magentas,
  // purples, oxygen blues and teals, a warm orange), far behind
  const hue = (pick([352, 330, 292, 218, 196, 22]) + range(-12, 12) + 360) % 360;
  const nebula = Array.from({ length: 2 + Math.floor(r() * 2) }, (_, i) => ({
    x: range(-60, 70),
    y: range(-30, 35),
    z: range(-235, -185),
    color: hsl((hue + (i - 1) * range(20, 45) + 360) % 360, range(0.45, 0.7), range(0.22, 0.34)),
    size: range(160, 240),
  }));

  return { seed, star, planet, moons, belt, nebula, stars: { tint: pick(STAR_TINTS), density: range(0.75, 1.3) } };
}
