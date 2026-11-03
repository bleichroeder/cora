import { afterEach, describe, expect, it, vi } from 'vitest';

/** Cora's own speech volume (David's notes: "Cora needs its own control for global speech volume"). */
describe('speech volume', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it('is 0 to 1, full by default, and anything odd is full', async () => {
    const { clampVolume } = await import('../src/lib/speechVolume');
    expect(clampVolume(0.4)).toBe(0.4);
    expect(clampVolume('0.25')).toBe(0.25);
    expect(clampVolume(2)).toBe(1);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume('loud')).toBe(1);
    expect(clampVolume(null)).toBe(1);
  });
  it('a level set is kept on this device and read back next time', async () => {
    const store = memory();
    vi.stubGlobal('localStorage', store);
    const a = await import('../src/lib/speechVolume');
    expect(a.speechVolume()).toBe(1);
    a.setSpeechVolume(0.3);
    expect(a.speechVolume()).toBe(0.3);
    expect(store.m.get('cora.voice.volume')).toBe('0.3');
    vi.resetModules();
    const b = await import('../src/lib/speechVolume');
    expect(b.speechVolume()).toBe(0.3);
  });
  it('no storage (a private window): full volume, and setting it still works for now', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const a = await import('../src/lib/speechVolume');
    expect(a.speechVolume()).toBe(1);
    a.setSpeechVolume(0.5);
    expect(a.speechVolume()).toBe(0.5);
  });
});

describe('the Volume row (Settings › Voice)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('shows the level as a percentage on a slider', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    // (a server render shows the store as it starts: full volume, nothing kept here)
    const { VolumeSlider } = await import('../src/components/VoiceSettings');
    const h = renderToStaticMarkup(createElement(VolumeSlider));
    expect(h).toContain('type="range"');
    expect(h).toContain('value="100"');
    expect(h).toContain('100%');
  });
});
