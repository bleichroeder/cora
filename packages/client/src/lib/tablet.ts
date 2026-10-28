import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { desktop } from './desktop';

/**
 * Cora on the iPad: tablet mode when Cora isn't in the desktop
 * app and the device has touch, or the window is narrow. The device's own choice (Auto / On / Off) lives here, on the
 * device: never synced, and never in the desktop app.
 */
export type TabletChoice = 'auto' | 'on' | 'off';
const KEY = 'cora.tablet';
const read = (): TabletChoice => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'on' || v === 'off' ? v : 'auto';
  } catch {
    return 'auto';
  }
};
export const useTabletChoice = create<{ choice: TabletChoice; set(c: TabletChoice): void }>((set) => ({
  choice: read(),
  set: (choice) => {
    try {
      if (choice === 'auto') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      /* ignore */
    }
    set({ choice });
  },
}));

const touch = () => typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
const size = () => ({ w: typeof window === 'undefined' ? 1440 : window.innerWidth, h: typeof window === 'undefined' ? 900 : window.innerHeight });

/** The window's size, as it changes. */
export function useViewport(): { w: number; h: number } {
  const [v, setV] = useState(size);
  useEffect(() => {
    const on = () => setV(size());
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => (window.removeEventListener('resize', on), window.removeEventListener('orientationchange', on));
  }, []);
  return v;
}

/** Is this screen in tablet mode? Never in the desktop app. */
export function useTablet(): boolean {
  const choice = useTabletChoice((s) => s.choice);
  const { w } = useViewport();
  if (desktop) return false;
  if (choice !== 'auto') return choice === 'on';
  return touch() || w < 1100;
}
/** The same, outside React (read once). */
export const isTablet = () => !desktop && (read() === 'on' || (read() === 'auto' && (touch() || size().w < 1100)));

/** The 3D scene on this tablet (off unless turned on here: the flat board is smoother on a tablet). */
export const tabletScene = () => {
  try {
    return localStorage.getItem('cora.tablet.scene') === 'on';
  } catch {
    return false;
  }
};

/** Tablet mode's own state: the full nav as a drawer, and which of the session's views is on show. */
export const useTabletUi = create<{ drawer: boolean; pane: 'board' | 'session' | 'browser' }>(() => ({ drawer: false, pane: 'session' }));
