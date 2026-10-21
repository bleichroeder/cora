import { describe, expect, it } from 'vitest';
import { finishedSpeaking } from '../src/lib/voice';

describe('click-to-talk: when you have finished speaking', () => {
  const at = (o: Partial<Parameters<typeof finishedSpeaking>[0]>) => finishedSpeaking({ heard: false, lastSpeech: 0, started: 0, now: 0, quietMs: 1200, ...o });
  it('waits for you to start, then for a pause of the chosen length', () => {
    expect(at({ now: 5000 })).toBe(false);
    expect(at({ heard: true, lastSpeech: 4000, now: 5000 })).toBe(false);
    expect(at({ heard: true, lastSpeech: 4000, now: 5200 })).toBe(true);
    expect(at({ heard: true, lastSpeech: 4000, now: 4900, quietMs: 800 })).toBe(true);
  });
  it('gives up when you never start', () => {
    expect(at({ now: 9_999 })).toBe(false);
    expect(at({ now: 10_000 })).toBe(true);
  });
});
