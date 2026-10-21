/**
 * How space looks behind the agents (Settings → Scene): star systems with hyperspace jumps, or the classic deep
 * space; for star systems, the planet's size and brightness and which extras turn up; for both, the stars, the
 * nebula and the drifting particles. Kept with the dashboard's display preferences.
 */
export type SpaceMode = 'systems' | 'classic';
export type Size = 'small' | 'normal' | 'large';
export type Level = 'dim' | 'normal' | 'bright';
export type Amount = 'off' | 'subtle' | 'normal' | 'vivid';
export type Density = 'fewer' | 'normal' | 'more';

export type SpaceSettings = {
  mode: SpaceMode;
  /** star systems: how big the planet is, how bright the bodies are */
  size: Size;
  brightness: Level;
  moons: boolean;
  rings: boolean;
  belts: boolean;
  clouds: boolean;
  /** city lights on night sides; a visible sun in some systems */
  cities: boolean;
  suns: boolean;
  /** the hyperspace button in the scene's corner (the palette command stays) */
  button: boolean;
  /** both: how many stars, how strong the nebula, the drifting particles */
  stars: Density;
  nebula: Amount;
  motes: boolean;
};

export const DEFAULT_SPACE: SpaceSettings = { mode: 'systems', size: 'normal', brightness: 'normal', moons: true, rings: true, belts: true, clouds: true, cities: true, suns: true, button: true, stars: 'normal', nebula: 'normal', motes: true };

/** The saved settings over the defaults (a missing or partial one is fine). */
export const spaceOf = (saved: Partial<SpaceSettings> | undefined): SpaceSettings => ({ ...DEFAULT_SPACE, ...(saved ?? {}) });

export const SIZE_K: Record<Size, number> = { small: 0.75, normal: 1, large: 1.2 };
export const BRIGHT_K: Record<Level, number> = { dim: 0.6, normal: 1, bright: 1.3 };
export const NEBULA_K: Record<Amount, number> = { off: 0, subtle: 0.55, normal: 1, vivid: 1.6 };
export const STARS_K: Record<Density, number> = { fewer: 0.5, normal: 1, more: 1.7 };
