import { describe, expect, it } from 'vitest';
import { encodeGif } from '../src/gif';

/** A plain GIF reader (the spec's way), to read back what the encoder wrote: each frame drawn over the last. */
function decode(g: Uint8Array) {
  let p = 0;
  const u8 = () => g[p++];
  const u16 = () => g[p++] | (g[p++] << 8);
  const sig = String.fromCharCode(...g.subarray(0, 6));
  p = 6;
  const w = u16();
  const h = u16();
  const flags = u8();
  const bg = u8();
  u8();
  const pal: number[][] = [];
  if (flags & 0x80) for (let i = 0; i < 1 << ((flags & 7) + 1); i++) pal.push([u8(), u8(), u8()]);
  const canvas = new Int16Array(w * h).fill(-1);
  const frames: Array<{ rgba: number[]; delay: number }> = [];
  let loops = false;
  let delay = 0;
  let transparent = -1;
  for (;;) {
    const b = u8();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = u8();
      const blocks: number[][] = [];
      for (let n = u8(); n; n = u8()) blocks.push([...g.subarray(p, (p += n))]);
      if (label === 0xf9) {
        delay = blocks[0][1] | (blocks[0][2] << 8);
        transparent = blocks[0][0] & 1 ? blocks[0][3] : -1;
      }
      if (label === 0xff && String.fromCharCode(...blocks[0]) === 'NETSCAPE2.0') loops = true;
      continue;
    }
    expect(b).toBe(0x2c);
    const x0 = u16();
    const y0 = u16();
    const bw = u16();
    const bh = u16();
    u8();
    const min = u8();
    const data: number[] = [];
    for (let n = u8(); n; n = u8()) data.push(...g.subarray(p, (p += n)));
    // LZW
    const clear = 1 << min;
    const eoi = clear + 1;
    let size = min + 1;
    let dict: number[][] = [];
    const resetDict = () => {
      dict = [];
      for (let i = 0; i < clear; i++) dict[i] = [i];
      dict[clear] = [];
      dict[eoi] = [];
      size = min + 1;
    };
    resetDict();
    const out: number[] = [];
    let prev: number[] | null = null;
    let bit = 0;
    const read = () => {
      let c = 0;
      for (let i = 0; i < size; i++, bit++) c |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
      return c;
    };
    for (;;) {
      if (bit + size > data.length * 8) throw new Error('ran out of data');
      const code = read();
      if (code === clear) {
        resetDict();
        prev = null;
        continue;
      }
      if (code === eoi) break;
      let entry: number[];
      if (code < dict.length) entry = dict[code];
      else if (code === dict.length && prev) entry = [...prev, prev[0]];
      else throw new Error(`bad code ${code}`);
      out.push(...entry);
      if (prev && dict.length < 4096) dict.push([...prev, entry[0]]);
      if (dict.length === 1 << size && size < 12) size++;
      prev = entry;
    }
    expect(out.length).toBe(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (out[y * bw + x] !== transparent) canvas[(y + y0) * w + x + x0] = out[y * bw + x];
    const rgba: number[] = [];
    for (const i of canvas) rgba.push(...(i < 0 ? [0, 0, 0, 0] : [...pal[i], 255]));
    frames.push({ rgba, delay });
  }
  return { sig, w, h, bg, loops, frames };
}

const close = (a: number[], b: Uint8Array, tol: number) => {
  let worst = 0;
  for (let i = 0; i < a.length; i++) if (b[i + 0] !== undefined) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst <= tol;
};

describe('encodeGif', () => {
  it('a few colours come back exactly, frame by frame, looping', () => {
    const w = 7;
    const h = 5;
    const colours = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
    ];
    const frames = [0, 1, 2].map((f) => {
      const d = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const c = colours[(i + (i > 20 ? f : 0)) % 4];
        d.set([...c, 255], i * 4);
      }
      return { data: d };
    });
    const g = decode(encodeGif(frames, { width: w, height: h, delayCs: 8 }));
    expect(g).toMatchObject({ sig: 'GIF89a', w, h, loops: true });
    expect(g.frames).toHaveLength(3);
    g.frames.forEach((f, i) => {
      expect(f.delay).toBe(8);
      expect(f.rgba).toEqual([...frames[i].data]);
    });
  });

  it('a gradient over many frames: past the 12-bit table (clears), close in colour, BGRA read the right way round', () => {
    const w = 160;
    const h = 90;
    const frames = Array.from({ length: 6 }, (_, f) => {
      const d = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          // B, G, R, A
          d[i] = (x * 3 + f * 10) & 255;
          d[i + 1] = (y * 2) & 255;
          d[i + 2] = ((x * y) >> 4) & 255;
          d[i + 3] = 255;
        }
      return { data: d, order: 'bgra' as const };
    });
    const bytes = encodeGif(frames, { width: w, height: h, delayCs: 7 });
    const g = decode(bytes);
    expect(g.frames).toHaveLength(6);
    for (let f = 0; f < 6; f++) {
      const rgba = new Uint8Array(w * h * 4);
      const s = frames[f].data;
      for (let i = 0; i < w * h * 4; i += 4) rgba.set([s[i + 2], s[i + 1], s[i], 255], i);
      // 255 colours for a busy gradient: near, not exact
      const err = g.frames[f].rgba.reduce((a, v, i) => a + Math.abs(v - rgba[i]), 0) / rgba.length;
      expect(err).toBeLessThan(10);
    }
  });

  it('only what changed is drawn after the first frame; see-through corners stay see-through', () => {
    const w = 40;
    const h = 20;
    const base = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) base.set(i === 0 ? [0, 0, 0, 0] : [20, 20, 30, 255], i * 4);
    const moved = base.slice();
    moved.set([240, 80, 160, 255], (10 * w + 30) * 4);
    const same = encodeGif([{ data: base }, { data: base }], { width: w, height: h, delayCs: 5 });
    const changed = encodeGif([{ data: base }, { data: moved }], { width: w, height: h, delayCs: 5 });
    const g = decode(changed);
    expect(close(g.frames[1].rgba, moved, 8)).toBe(true);
    expect(g.frames[1].rgba.slice(0, 4)).toEqual([0, 0, 0, 0]);
    // a frame with one changed pixel is a few bytes, not a whole picture
    expect(changed.length - same.length).toBeLessThan(20);
  });
});
