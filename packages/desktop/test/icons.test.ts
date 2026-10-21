import { describe, expect, it } from 'vitest';
import { coraIco, icoFile, orbPng } from '../src/icons';

describe("Cora's icon file", () => {
  it('is an .ico of PNGs, one per size, each where its entry says', () => {
    const ico = icoFile([16, 256].map((size) => ({ size, png: orbPng(size, '#f472b6') })));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    const entry = (i: number) => ({ w: ico[6 + 16 * i], bytes: ico.readUInt32LE(6 + 16 * i + 8), at: ico.readUInt32LE(6 + 16 * i + 12) });
    expect(entry(0).w).toBe(16);
    expect(entry(1).w).toBe(0);
    for (const i of [0, 1]) expect(ico.subarray(entry(i).at, entry(i).at + 4).toString('latin1')).toBe('\x89PNG');
    expect(entry(1).at + entry(1).bytes).toBe(ico.length);
    // small sizes are bitmaps (a 40-byte header, rows and mask), 256 a PNG
    const c = coraIco('#f472b6');
    expect(c.readUInt16LE(4)).toBe(6);
    const at16 = c.readUInt32LE(6 + 12);
    expect(c.readUInt32LE(at16)).toBe(40);
    expect(c.readInt32LE(at16 + 8)).toBe(32);
    expect(c.readUInt32LE(6 + 8)).toBe(40 + 16 * 16 * 4 + 4 * 16);
    const at256 = c.readUInt32LE(6 + 16 * 5 + 12);
    expect(c.subarray(at256, at256 + 4).toString('latin1')).toBe('\x89PNG');
  });
});
