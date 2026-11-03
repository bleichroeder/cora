import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Where a menu opened at (x, y) goes so all of it shows: measured once it's drawn (its real size, not a guess), moved
 * up and left as far as it must, and given a scroll when the window is shorter than it.
 */
export function useOnScreen(box: RefObject<HTMLElement | null>, x: number, y: number, margin = 8): { left: number; top: number; maxHeight: number } {
  const [at, setAt] = useState({ left: x, top: y, maxHeight: window.innerHeight - 2 * margin });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const maxHeight = window.innerHeight - 2 * margin;
    const left = Math.max(margin, Math.min(x, window.innerWidth - width - margin));
    const top = Math.max(margin, Math.min(y, window.innerHeight - Math.min(height, maxHeight) - margin));
    setAt((a) => (a.left === left && a.top === top && a.maxHeight === maxHeight ? a : { left, top, maxHeight }));
  });
  return at;
}
