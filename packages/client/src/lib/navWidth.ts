/**
 * The left nav's width: yours to drag, 240 to 440px, 300 to
 * start; kept on this device (a laptop and a big monitor each keep their own). One CSS variable drives it.
 */
export const NAV_MIN = 240;
export const NAV_MAX = 440;
export const NAV_DEFAULT = 300;
const KEY = 'cora.nav.width';

export const clampNavWidth = (w: number) => Math.round(Math.min(NAV_MAX, Math.max(NAV_MIN, w)));

export function savedNavWidth(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v ? clampNavWidth(v) : NAV_DEFAULT;
  } catch {
    return NAV_DEFAULT;
  }
}
export function saveNavWidth(w: number): void {
  try {
    localStorage.setItem(KEY, String(clampNavWidth(w)));
  } catch {
    /* not kept */
  }
}
export function applyNavWidth(w: number): void {
  document.documentElement.style.setProperty('--nav-w', `${clampNavWidth(w)}px`);
}
export const navWidthNow = (): number => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav-w'), 10) || NAV_DEFAULT;

/** While you drag the nav's edge terminals wait (each refit makes Claude Code redraw); this event: refit once now. */
export const NAV_RESIZED = 'cora:nav-resized';
export const navDragging = (): boolean => document.documentElement.dataset.navDrag === '1';
