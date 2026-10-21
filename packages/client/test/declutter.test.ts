import { describe, expect, it } from 'vitest';
import { declutter } from '../src/scene/labels';

describe('declutter', () => {
  it('leaves labels that fit where they are, and moves a colliding one down just clear of the other', () => {
    const out = declutter([
      { key: 'git', x: 100, y: 100, w: 80, h: 18 },
      { key: 'npm', x: 300, y: 100, w: 80, h: 18 }, // same height, far to the right: no clash
      { key: 'ls', x: 104, y: 106, w: 60, h: 18 }, // right on top of git
    ]);
    expect(out.get('git')).toBe(0);
    expect(out.get('npm')).toBe(0);
    // git spans 91..109; ls wants 97..115, so it moves to start at 109 + 3
    expect(out.get('ls')).toBe(112 - 97);
  });

  it('keeps pushing down a stack of clashes', () => {
    const out = declutter([0, 1, 2, 3].map((i) => ({ key: `p${i}`, x: 100 + i, y: 200 + i, w: 70, h: 18 })));
    const tops = [0, 1, 2, 3].map((i) => 200 + i - 9 + out.get(`p${i}`)!);
    for (let i = 1; i < tops.length; i++) expect(tops[i] - tops[i - 1]).toBeGreaterThanOrEqual(21);
  });
});

describe('declutter keeps its order through small movements', () => {
  it("anchors that bob past each other by a few pixels don't trade places; a clear move does", async () => {
    const { declutter, SWAP_PX } = await import('../src/scene/labels');
    const prev = new Map<string, number>();
    const at = (gitY: number, npmY: number) => declutter([{ key: 'git', x: 100, y: gitY, w: 70, h: 18 }, { key: 'npm', x: 104, y: npmY, w: 70, h: 18 }], prev);
    at(100, 104); // git above npm
    expect(at(104, 100).get('git')).toBe(0); // npm is now 4px higher: git stays on top
    expect(at(104, 100).get('npm')).toBeGreaterThan(0);
    at(104 + SWAP_PX + 2, 100); // a clear move: they swap
    expect([...prev.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k)).toEqual(['npm', 'git']);
  });
});
