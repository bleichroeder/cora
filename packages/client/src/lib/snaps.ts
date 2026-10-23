import { create } from 'zustand';
import { useBrain } from '../state/store';
import { desktop } from './desktop';

/**
 * Pictures of sessions as you last saw them (the session switcher's previews): the session area (its header, scene or
 * board, transcript and composer) taken now and then while you're in a session, and the moment the switcher opens.
 * Small JPEGs, kept in memory only (a restart starts afresh). Only in the desktop app.
 */
export const useSnaps = create<{ by: Record<string, { url: string; at: number }> }>(() => ({ by: {} }));

const EVERY_MS = 20_000;
let busy = false;

/** Something is over the session (the switcher, the palette, a dialog): no picture of it then. */
const covered = () => !!document.querySelector('.sw-scrim, .pal-bg, .modal-bg');
/** The switcher is up (or about to be): its own picture is taken as it opens, nothing else meanwhile. */
let paused = false;
export const pauseSnaps = (on: boolean) => void (paused = on);

/** Picture the session you're in now (if the window's in front, it's on screen and nothing covers it). */
export async function snapNow(o: { opening?: boolean } = {}): Promise<void> {
  const st = useBrain.getState();
  const sid = st.focus;
  if (busy || (paused && !o.opening) || covered() || !desktop?.snap || !sid || st.overview || document.visibilityState !== 'visible') return;
  const el = document.querySelector('.main') as HTMLElement | null;
  const r = el?.getBoundingClientRect();
  if (!r || r.width < 50 || r.height < 50) return;
  busy = true;
  try {
    const url = await desktop.snap({ x: r.left, y: r.top, width: r.width, height: r.height });
    if (url && useBrain.getState().focus === sid) useSnaps.setState((s) => ({ by: { ...s.by, [sid]: { url, at: Date.now() } } }));
  } finally {
    busy = false;
  }
}

// now and then while you're in a session; and a moment after you switch to one (once it has drawn)
if (typeof window !== 'undefined' && desktop?.snap) {
  setInterval(() => document.hasFocus() && void snapNow(), EVERY_MS);
  let t: ReturnType<typeof setTimeout> | null = null;
  useBrain.subscribe((st, prev) => {
    if (st.focus === prev.focus) return;
    if (t) clearTimeout(t);
    t = setTimeout(() => void snapNow(), 1500);
  });
}
