import { create } from 'zustand';

/**
 * How loud Cora speaks on this device (its sessions' voices, Cora's own, and her soft cues), 0 to 1, apart from the
 * system's volume. Kept per device (a laptop's speakers and an iPad's want different levels), in this browser's
 * storage: it survives a reload, and a missing or broken store just means full volume.
 */
const KEY = 'cora.voice.volume';
export const clampVolume = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, Math.round(n * 100) / 100)) : 1;
};
function stored(): number {
  try {
    return clampVolume(globalThis.localStorage?.getItem(KEY) ?? 1);
  } catch {
    return 1;
  }
}
export const useSpeechVolume = create<{ volume: number }>(() => ({ volume: stored() }));
export function setSpeechVolume(v: number): void {
  const volume = clampVolume(v);
  useSpeechVolume.setState({ volume });
  try {
    globalThis.localStorage?.setItem(KEY, String(volume));
  } catch {
    /* not kept: it still applies until the window closes */
  }
}
/** The level to play at now. */
export const speechVolume = (): number => useSpeechVolume.getState().volume;
