import { describe, expect, it } from 'vitest';
import { WakeFeatures } from '../src/lib/wake/features';
import { WakeDetector } from '../src/lib/wake/detector';

describe('the wake detector', () => {
  it('a hit is the threshold twice in a row, then a cooldown', () => {
    const d = new WakeDetector({ threshold: 0.5 });
    expect(d.score(0.6, 0)).toBe(false);
    expect(d.score(0.7, 80)).toBe(true);
    expect(d.score(0.9, 160)).toBe(false);
    expect(d.score(0.9, 240)).toBe(false);
    expect(d.score(0.9, 2300)).toBe(false);
    expect(d.score(0.9, 2380)).toBe(true);
    const e = new WakeDetector({ threshold: 0.5 });
    expect([e.score(0.6, 0), e.score(0.2, 80), e.score(0.6, 160)]).toEqual([false, false, false]);
  });
});

describe('the wake feature pipeline (openWakeWord streaming)', () => {
  it('80 ms chunks with 480 samples of context; 8 mel frames each; one 76-frame embedding per chunk; leftovers carried', async () => {
    const melInputs: number[] = [];
    const embedCalls: number[] = [];
    const mel = async (a: Float32Array) => (melInputs.push(a.length), new Float32Array(8 * 32).fill(10));
    const embed = async (w: Float32Array, n: number) => (embedCalls.push(n), expect(w.length).toBe(n * 76 * 32), new Float32Array(n * 96).fill(1));
    const f = new WakeFeatures(mel, embed);
    const before = f.embeddings;
    expect(await f.push(new Int16Array(1000))).toBe(0);
    expect(await f.push(new Int16Array(1000))).toBe(1);
    // the first chunk has no audio before it to give as context (as openWakeWord: its buffer starts empty)
    expect(melInputs).toEqual([1280]);
    expect(await f.push(new Int16Array(2560 - 720))).toBe(2);
    expect(melInputs.at(-1)).toBe(2560 + 480);
    expect(embedCalls.at(-1)).toBe(2);
    expect(f.embeddings).toBe(Math.min(120, before + 3));
    expect(f.features(16).length).toBe(16 * 96);
  });

  it('applies x/10 + 2 to the mel output', async () => {
    let seen: Float32Array | null = null;
    const f = new WakeFeatures(async () => new Float32Array(8 * 32).fill(10), async (w, n) => ((seen = w.slice(w.length - 32)), new Float32Array(n * 96)));
    await f.push(new Int16Array(1280));
    expect(Array.from(seen!)).toEqual(new Array(32).fill(3));
  });
});
