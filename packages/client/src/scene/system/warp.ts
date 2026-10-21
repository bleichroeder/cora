import { create } from 'zustand';
import { useBrain } from '../../state/store';

/**
 * The hyperspace jump: out (streaks build, the system falls away), a flash (the new system is put in place behind
 * it), then in (the streaks settle, the new system fades in). About 3 s; one at a time; never during a black hole or
 * a big bang.
 */
export type WarpPhase = 'idle' | 'out' | 'flash' | 'in';
export const WARP_MS = { out: 1600, flash: 300, in: 1100 } as const;

type WarpState = {
  phase: WarpPhase;
  /** when the current phase began */
  at: number;
  /** something else holds the scene (the scene sets this: a black hole or a big bang playing) */
  blocked: () => boolean;
  /** start a jump; `onFlash` swaps the system in at the flash. False when one can't start now. */
  jump(onFlash: () => void): boolean;
};

export const useWarp = create<WarpState>((set, get) => ({
  phase: 'idle',
  at: 0,
  blocked: () => false,
  jump(onFlash) {
    if (get().phase !== 'idle' || get().blocked()) return false;
    set({ phase: 'out', at: Date.now() });
    setTimeout(() => {
      set({ phase: 'flash', at: Date.now() });
      onFlash();
    }, WARP_MS.out);
    setTimeout(() => set({ phase: 'in', at: Date.now() }), WARP_MS.out + WARP_MS.flash);
    setTimeout(() => set({ phase: 'idle', at: Date.now() }), WARP_MS.out + WARP_MS.flash + WARP_MS.in);
    return true;
  },
}));

export const newSeed = () => Math.floor(Math.random() * 4294967296) >>> 0;

/** Jump to a new system (the button, the palette). */
export function jumpToHyperspace(): boolean {
  if (useBrain.getState().prefs.space?.mode === 'classic') return false;
  return useWarp.getState().jump(() => useBrain.getState().setPrefs({ starSystem: newSeed() }));
}

/**
 * How far into the jump we are: `warp` 0..1 (the streaks), `away` 0..1 (the old system receding, then the new one
 * arriving: 1 = gone), `flash` 0..1.
 */
export function warpLevels(phase: WarpPhase, sinceMs: number): { warp: number; away: number; flash: number } {
  const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  if (phase === 'out') return { warp: ease(sinceMs / 1000), away: ease((sinceMs - 600) / 1000), flash: 0 };
  if (phase === 'flash') return { warp: 1, away: 1, flash: Math.sin(Math.min(1, sinceMs / WARP_MS.flash) * Math.PI) };
  if (phase === 'in') return { warp: 1 - ease(sinceMs / 700), away: 1 - ease(sinceMs / WARP_MS.in), flash: 0 };
  return { warp: 0, away: 0, flash: 0 };
}
