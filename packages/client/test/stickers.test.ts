import { describe, expect, it } from 'vitest';
import { place } from '../src/components/board/MemePanel';

/** The sticker's tilted outline, from where place() put it. */
function outline(at: { left: number; top: number; width: number }, shape: number, tilt: number) {
  const h = (at.width - 10) * shape + 10;
  const r = (Math.abs(tilt) * Math.PI) / 180;
  const bw = at.width * Math.cos(r) + h * Math.sin(r);
  const bh = at.width * Math.sin(r) + h * Math.cos(r);
  const cx = at.left + at.width / 2;
  const cy = at.top + h / 2;
  return { x0: cx - bw / 2, x1: cx + bw / 2, y0: cy - bh / 2, y1: cy + bh / 2 };
}

describe('stickers', () => {
  it('always fit inside the panel, tilted corners included, whatever their shape, spot or the panel', () => {
    for (const panel of [{ w: 420, h: 300 }, { w: 900, h: 260 }, { w: 260, h: 640 }, { w: 180, h: 140 }])
      for (const shape of [0.4, 0.67, 1, 1.8, 3])
        for (const tilt of [-13, -6, 0, 7, 13])
          for (const spot of [[0, 4], [60, 12], [42, 56], [24, 38]] as Array<[number, number]>)
            for (const j of [0, 0.5, 1])
              for (const share of [0.36, 0.62]) {
                const o = outline(place(panel, share, shape, tilt, spot, j, 1 - j), shape, tilt);
                expect(o.x0).toBeGreaterThanOrEqual(-1);
                expect(o.y0).toBeGreaterThanOrEqual(-1);
                expect(o.x1).toBeLessThanOrEqual(panel.w + 1);
                expect(o.y1).toBeLessThanOrEqual(panel.h + 1);
              }
  });
});
