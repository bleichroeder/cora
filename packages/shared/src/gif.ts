/**
 * A small animated-GIF encoder: Cora's Slack banner is a
 * couple of seconds of its orb, recorded in the desktop app. One palette for every frame (median cut over the frames'
 * colours, 255 of them; the last index is "see-through"), looping forever. After the first frame only what changed is
 * drawn: a frame is cropped to the pixels that differ and the rest of its box is see-through, so the picture under it
 * stays. Pixels with little alpha are see-through from the start (rounded corners).
 */
export type GifFrame = {
  /** width × height × 4 bytes */
  data: Uint8Array;
  /** the bytes' order: RGBA (a canvas) or BGRA (Electron's bitmaps on Windows and Linux) */
  order?: 'rgba' | 'bgra';
};

const CLEAR = 255;

export function encodeGif(frames: GifFrame[], o: { width: number; height: number; delayCs: number }): Uint8Array {
  const { width: w, height: h } = o;
  if (!frames.length || w < 1 || h < 1 || w > 65535 || h > 65535) throw new Error('nothing to encode');
  for (const f of frames) if (f.data.length < w * h * 4) throw new Error('a frame is smaller than its size');

  // the colours, 5 bits a channel (32768 of them), counted over the frames
  const keyOf = (f: GifFrame) => {
    const bgra = f.order === 'bgra';
    const keys = new Int16Array(w * h);
    const d = f.data;
    for (let i = 0, p = 0; i < keys.length; i++, p += 4) {
      if (d[p + 3] < 128) {
        keys[i] = -1;
        continue;
      }
      const r = bgra ? d[p + 2] : d[p];
      const b = bgra ? d[p] : d[p + 2];
      keys[i] = ((r >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (b >> 3);
    }
    return keys;
  };
  const keyed = frames.map(keyOf);
  const counts = new Float64Array(32768);
  for (const k of keyed) for (let i = 0; i < k.length; i++) if (k[i] >= 0) counts[k[i]]++;
  const palette = medianCut(counts, 255);
  const index = paletteIndex(palette);

  const out = new Bytes();
  out.str('GIF89a');
  out.u16(w);
  out.u16(h);
  out.u8(0xf7); // a global table of 256 colours, 8 bits a channel
  out.u8(CLEAR);
  out.u8(0);
  for (let i = 0; i < 256; i++) {
    const c = palette[i] ?? 0;
    out.u8((c >> 16) & 255);
    out.u8((c >> 8) & 255);
    out.u8(c & 255);
  }
  // NETSCAPE2.0: loop forever
  out.bytes([0x21, 0xff, 0x0b]);
  out.str('NETSCAPE2.0');
  out.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);

  let shown: Uint8Array | null = null;
  for (const keys of keyed) {
    const px = new Uint8Array(w * h);
    for (let i = 0; i < px.length; i++) px[i] = keys[i] < 0 ? CLEAR : index(keys[i]);
    // the box that changed (all of it, the first time)
    let x0 = 0;
    let y0 = 0;
    let x1 = w - 1;
    let y1 = h - 1;
    if (shown) {
      x0 = w;
      y0 = h;
      x1 = -1;
      y1 = -1;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (px[i] === shown[i] || px[i] === CLEAR) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      // nothing changed: one see-through pixel keeps the frame's time
      if (x1 < 0) x0 = x1 = y0 = y1 = 0;
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const box = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++) {
        const i = (y + y0) * w + x + x0;
        box[y * bw + x] = shown && (px[i] === shown[i] || px[i] === CLEAR) ? CLEAR : px[i];
      }
    if (shown) {
      for (let i = 0; i < px.length; i++) if (px[i] !== CLEAR) shown[i] = px[i];
    } else shown = px;
    // the frame's timing; draws over what's there; CLEAR is see-through
    out.bytes([0x21, 0xf9, 0x04, 0x05]);
    out.u16(Math.max(2, Math.round(o.delayCs)));
    out.bytes([CLEAR, 0x00]);
    out.u8(0x2c);
    out.u16(x0);
    out.u16(y0);
    out.u16(bw);
    out.u16(bh);
    out.u8(0);
    out.u8(8);
    lzw(box, 8, out);
  }
  out.u8(0x3b);
  return out.done();
}

/** Up to n colours (0xRRGGBB) for the counted 15-bit colours: the box with the most spread × pixels split at its median. */
function medianCut(counts: Float64Array, n: number): number[] {
  type Box = { keys: number[]; score: number };
  const ch = (k: number, c: number) => (k >> (10 - c * 5)) & 31;
  const make = (keys: number[]): Box => {
    let total = 0;
    let spread = 0;
    for (let c = 0; c < 3; c++) {
      let lo = 31;
      let hi = 0;
      for (const k of keys) {
        const v = ch(k, c);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      spread = Math.max(spread, hi - lo);
    }
    for (const k of keys) total += counts[k];
    return { keys, score: keys.length > 1 ? spread * Math.sqrt(total) : -1 };
  };
  const used: number[] = [];
  for (let k = 0; k < counts.length; k++) if (counts[k] > 0) used.push(k);
  if (!used.length) return [0];
  const boxes = [make(used)];
  while (boxes.length < n) {
    let bi = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].score > 0 && (bi < 0 || boxes[i].score > boxes[bi].score)) bi = i;
    if (bi < 0) break;
    const b = boxes[bi];
    // along its widest channel, at the weighted median
    let axis = 0;
    let best = -1;
    for (let c = 0; c < 3; c++) {
      let lo = 31;
      let hi = 0;
      for (const k of b.keys) {
        const v = ch(k, c);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > best) {
        best = hi - lo;
        axis = c;
      }
    }
    const sorted = b.keys.slice().sort((p, q) => ch(p, axis) - ch(q, axis));
    let total = 0;
    for (const k of sorted) total += counts[k];
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += counts[sorted[i]];
      cut = i + 1;
      if (acc >= total / 2) break;
    }
    boxes.splice(bi, 1, make(sorted.slice(0, cut)), make(sorted.slice(cut)));
  }
  return boxes.map((b) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    let t = 0;
    for (const k of b.keys) {
      const c = counts[k];
      r += ch(k, 0) * c;
      g += ch(k, 1) * c;
      bl += ch(k, 2) * c;
      t += c;
    }
    const to8 = (v: number) => Math.min(255, Math.round((v / t) * 255 / 31));
    return (to8(r) << 16) | (to8(g) << 8) | to8(bl);
  });
}

/** A 15-bit colour's nearest palette entry, worked out once each. */
function paletteIndex(palette: number[]): (key: number) => number {
  const memo = new Int16Array(32768).fill(-1);
  const pr = palette.map((c) => (c >> 16) & 255);
  const pg = palette.map((c) => (c >> 8) & 255);
  const pb = palette.map((c) => c & 255);
  return (key) => {
    const m = memo[key];
    if (m >= 0) return m;
    const r = (((key >> 10) & 31) * 255) / 31;
    const g = (((key >> 5) & 31) * 255) / 31;
    const b = ((key & 31) * 255) / 31;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const d = (pr[i] - r) ** 2 * 3 + (pg[i] - g) ** 2 * 4 + (pb[i] - b) ** 2 * 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    memo[key] = best;
    return best;
  };
}

/** LZW, as GIF wants it: variable-width codes up to 12 bits, packed low bit first, in sub-blocks of up to 255 bytes. */
function lzw(px: Uint8Array, minSize: number, out: Bytes): void {
  const clear = 1 << minSize;
  const eoi = clear + 1;
  const table = new Int16Array(4096 << 8);
  let size = minSize + 1;
  let next = eoi + 1;
  const block: number[] = [];
  let acc = 0;
  let bits = 0;
  const flush = () => {
    if (!block.length) return;
    out.u8(block.length);
    out.bytes(block);
    block.length = 0;
  };
  const emit = (code: number) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      block.push(acc & 255);
      acc >>>= 8;
      bits -= 8;
      if (block.length === 255) flush();
    }
  };
  const reset = () => {
    table.fill(-1);
    size = minSize + 1;
    next = eoi + 1;
  };
  reset();
  emit(clear);
  let prefix = px[0];
  for (let i = 1; i < px.length; i++) {
    const k = px[i];
    const key = (prefix << 8) | k;
    const hit = table[key];
    if (hit >= 0) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      reset();
    } else {
      if (next >= 1 << size) size++;
      table[key] = next++;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) block.push(acc & 255);
  flush();
  out.u8(0);
}

class Bytes {
  private buf = new Uint8Array(1 << 16);
  private n = 0;
  private room(k: number) {
    if (this.n + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  u8(v: number) {
    this.room(1);
    this.buf[this.n++] = v & 255;
  }
  u16(v: number) {
    this.u8(v);
    this.u8(v >> 8);
  }
  bytes(a: ArrayLike<number>) {
    this.room(a.length);
    for (let i = 0; i < a.length; i++) this.buf[this.n++] = a[i];
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}
