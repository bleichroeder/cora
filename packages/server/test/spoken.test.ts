import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, DEFAULT_VOICE } from '@cora/shared';
import { applyPatch } from '../src/prefs';
import { spokenText, Voice, type Fetch } from '../src/voice';
import { speakNudge } from '../src/hosted';
import { agentPrompt } from '../src/orchestrator/files';

const V = { ...DEFAULT_VOICE, enabled: true };

describe("how it's said", () => {
  it('swaps in your pronunciations (whole words, any case)', () => {
    const v = { ...V, pronounce: [{ from: 'Acme', to: 'ack me' }, { from: 'glab', to: 'G lab' }, { from: 'ACME-5234', to: 'I D fifty-two thirty-four' }] };
    expect(spokenText('acme ran glab on ACME-5234, not glabber', v)).toBe('ack me ran G lab on I D fifty-two thirty-four, not glabber');
  });

  it('puts your direction in front on a model that follows tags (Cora its own), and takes tags out on one that would read them', () => {
    const v4 = { ...V, model: 'eleven_v4', delivery: 'relaxed, warm', coraDelivery: '[bright, a little dry]' };
    expect(spokenText('[cheerful] Build passed.', v4)).toBe('[relaxed, warm] [cheerful] Build passed.');
    expect(spokenText('Build passed.', v4, true)).toBe('[bright, a little dry] Build passed.');
    expect(spokenText('Build passed.', { ...v4, coraDelivery: '' }, true)).toBe('[relaxed, warm] Build passed.');
    // a whole description isn't a tag (ElevenLabs would read it aloud): its short cues, as one tag
    const described = { ...v4, coraDelivery: '[Calm, confident, and conversational. Warm but understated, with natural pacing, subtle dry wit, and effortless intelligence. Never theatrical or overly enthusiastic.]' };
    expect(spokenText('Good morning.', described, true)).toBe('[Calm, confident, conversational, Warm but understated] Good morning.');
    expect(spokenText('Hi.', { ...v4, delivery: 'Never theatrical. Do not shout at all, ever, under any circumstances.' })).toBe('Hi.');
    const flash = { ...v4, model: 'eleven_flash_v2_5' };
    expect(spokenText('[cheerful] Build passed, see [image: shot.png].', flash)).toBe('Build passed, see [image: shot.png].');
  });

  it('settings: direction is text, style 0 to 1, pronunciations a short list of swaps', () => {
    const v = applyPatch(DEFAULT_SETTINGS, { voice: { delivery: '  [calm]  ', style: 0.3, pronounce: [{ from: ' Acme ', to: 'ack me' }] } }).voice;
    expect(v).toMatchObject({ delivery: '[calm]', style: 0.3, pronounce: [{ from: 'Acme', to: 'ack me' }] });
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { delivery: 'x'.repeat(201) } })).toThrow(/delivery/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { style: 2 } })).toThrow(/style/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { pronounce: [{ from: '', to: 'x' }] } })).toThrow(/pronounce/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { pronounce: 'Acme' as any } })).toThrow(/pronounce/);
  });

  it('sends style only to models that take it', async () => {
    const bodies: any[] = [];
    const f: Fetch = async (url, init) => {
      if (String(url).includes('/text-to-speech/')) bodies.push(JSON.parse(String(init?.body)));
      return new Response(new Uint8Array([1]), { status: 200 });
    };
    const voice = new Voice(null, f);
    (voice as any).stored = { key: 'k' };
    for (const model of ['eleven_v3', 'eleven_v4', 'eleven_flash_v2_5']) await voice.speech(voice.ticket('hi', { ...V, model, style: 0.3 }));
    expect(bodies.map((b) => b.voice_settings.style)).toEqual([0.3, undefined, undefined]);
  });

  it('lets spoken lines direct themselves only when the voice follows tags', () => {
    expect(speakNudge({ ...V, model: 'eleven_v4' })).toMatch(/audio tags/);
    expect(speakNudge({ ...V, model: 'eleven_flash_v2_5' })).not.toMatch(/audio tags/);
    expect(agentPrompt({ speak: true, tags: true })).toMatch(/audio tags/);
    expect(agentPrompt({ speak: true })).not.toMatch(/audio tags/);
  });
});
