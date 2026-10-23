/**
 * How many columns of cards to lay out in a box so that all of them fit without scrolling, as big as they can be (up to
 * `max` wide). A card is `aspect` (height / width) of its width tall, plus `extra` px (its caption). When even `min`
 * wide cards don't all fit, the columns for `min` wide cards (the box scrolls).
 */
export function fitGrid(n: number, w: number, h: number, o: { gap: number; min: number; max: number; aspect: number; extra: number }): number {
  const { gap, min, max, aspect, extra } = o;
  const width = (cols: number) => (w - gap * (cols + 1)) / cols;
  const most = Math.max(1, Math.floor((w - gap) / (min + gap)));
  // never wider than max: at least this many columns, even with fewer cards
  const least = Math.min(most, Math.max(1, Math.ceil((w - gap) / (max + gap))));
  for (let cols = least; cols <= most; cols++) {
    const rows = Math.ceil(n / cols);
    // a pixel or two spare: fractional sizes must not tip it into scrolling
    if (rows * (width(cols) * aspect + extra) + gap * (rows + 1) <= h - 2) return cols;
  }
  return most;
}
