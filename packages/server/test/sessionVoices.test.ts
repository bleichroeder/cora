import { describe, expect, it } from 'vitest';
import { Prefs } from '../src/prefs';

describe("sessions' voices (Settings › Voice)", () => {
  it('each session its own, from a set of ElevenLabs voices (at most 12)', () => {
    const p = new Prefs(null);
    const v = p.update({ voice: { sessionVoices: { each: true, pool: [{ id: 'abcdefgh12', name: 'Aria' }, { id: 'ijklmnop34', name: '' }] } } as never }).voice;
    expect(v.sessionVoices).toEqual({ each: true, pool: [{ id: 'abcdefgh12', name: 'Aria' }, { id: 'ijklmnop34', name: 'Voice' }] });
    expect(() => p.update({ voice: { sessionVoices: { each: true, pool: [{ id: '../x', name: 'x' }] } } as never })).toThrow(/voice IDs/);
    expect(() => p.update({ voice: { sessionVoices: { each: 'yes', pool: [] } } as never })).toThrow(/each, pool/);
    expect(() => p.update({ voice: { sessionVoices: { each: true, pool: Array.from({ length: 13 }, (_, i) => ({ id: `abcdefgh${String(i).padStart(2, '0')}`, name: 'v' })) } } as never })).toThrow(/at most 12/);
  });
});
