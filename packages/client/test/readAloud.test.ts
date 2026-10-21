import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE } from '@cora/shared';
import { setMuted, useVoice } from '../src/lib/voice';

describe("the transcript's speaker: voice updates on or off", () => {
  const posted: any[] = [];
  beforeEach(() => {
    posted.length = 0;
    vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}');
      posted.push(body);
      return { ok: true, json: async () => ({ voice: { ...useVoice.getState().settings, ...body.voice } }) };
    });
    useVoice.setState({ settings: { ...DEFAULT_VOICE, enabled: true, read: 'full' } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('mutes everything said on its own, and keeps what reading you chose for when it comes back', async () => {
    expect(await setMuted(true)).toBeNull();
    expect(posted[0]).toEqual({ voice: { muted: true } });
    expect(useVoice.getState().settings).toMatchObject({ muted: true, read: 'full' });
    await setMuted(false);
    expect(posted[1]).toEqual({ voice: { muted: false } });
    expect(useVoice.getState().settings).toMatchObject({ muted: false, read: 'full' });
  });
});
