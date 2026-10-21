import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE } from '@cora/shared';
import { setReadAloud, useVoice } from '../src/lib/voice';

describe("the transcript's speaker: automatic reading on or off", () => {
  const posted: any[] = [];
  beforeEach(() => {
    posted.length = 0;
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}');
      posted.push(body);
      return { ok: true, json: async () => ({ voice: { ...useVoice.getState().settings, ...body.voice } }) };
    });
    useVoice.setState({ settings: { ...DEFAULT_VOICE, enabled: true, read: 'full' } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("off is Settings' Only when I click; on brings back what it was (full replies here)", async () => {
    expect(await setReadAloud(false)).toBeNull();
    expect(posted[0]).toEqual({ voice: { read: 'buttons' } });
    expect(useVoice.getState().settings.read).toBe('buttons');
    await setReadAloud(true);
    expect(posted[1]).toEqual({ voice: { read: 'full' } });
    expect(useVoice.getState().settings.read).toBe('full');
  });
});
