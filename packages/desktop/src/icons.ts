import { deflateSync } from 'node:zlib';

// Procedural app icons (the glowing orb), encoded as PNG with no image dependencies.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** A 32-bit bitmap for an .ico entry (bottom-up BGRA, then an all-clear AND mask: the alpha does the work). */
export function dibIcon(size: number, rgba: Uint8Array): Buffer {
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(size, 4);
  head.writeInt32LE(size * 2, 8); // the colour rows and the mask's
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = ((size - 1 - y) * size + x) * 4;
      px[d] = rgba[s + 2];
      px[d + 1] = rgba[s + 1];
      px[d + 2] = rgba[s];
      px[d + 3] = rgba[s + 3];
    }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  head.writeUInt32LE(px.length + mask.length, 20);
  return Buffer.concat([head, px, mask]);
}

/** An .ico, one image per size: a bitmap or a PNG (Windows reads both; PNG for the large one). */
export function icoFile(images: Array<{ size: number; png: Buffer }>): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // an icon
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([head, ...entries, ...images.map((i) => i.png)]);
}

/** Cora's icon file (the Start menu's, so the taskbar's): the orb in its colour; bitmaps small, a PNG at 256. */
export const coraIco = (color: string) => icoFile([16, 24, 32, 48, 64, 256].map((size) => ({ size, png: size >= 256 ? orbPng(size, color) : dibIcon(size, orbRgba(size, color)) })));

/** A glowing orb as PNG. */
export const orbPng = (size: number, color = '#38bdf8'): Buffer => encodePng(size, size, orbRgba(size, color));

/** A glowing orb: bright core with a white-hot centre, soft halo (RGBA pixels). */
export function orbRgba(size: number, color = '#38bdf8'): Uint8Array {
  const [cr, cg, cb] = hex(color);
  const px = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const core = 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - c, y - c) / (size / 2);
      let a: number;
      let mix: number;
      if (r <= core) {
        a = 1;
        mix = Math.max(0, 1 - r / core) ** 1.6 * 0.85; // towards white in the centre
      } else {
        const edge = Math.max(0, Math.min(1, (core + 1.5 / (size / 2) - r) / (1.5 / (size / 2)))); // anti-aliased rim
        const halo = Math.max(0, 1 - (r - core) / (1 - core)) ** 2.2 * 0.55;
        a = Math.max(edge, halo);
        mix = 0;
      }
      const i = (y * size + x) * 4;
      px[i] = Math.round(cr + (255 - cr) * mix);
      px[i + 1] = Math.round(cg + (255 - cg) * mix);
      px[i + 2] = Math.round(cb + (255 - cb) * mix);
      px[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  return px;
}
