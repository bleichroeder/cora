import { describe, expect, it } from 'vitest';
import { coraReading, setCoraSession, useVoice, voiceFor } from '../src/lib/voice';

describe("Cora's own voice", () => {
  it("speaks Cora's lines (its console, its notes, its session) with its voice, and the rest with the sessions'", () => {
    setCoraSession((sid) => sid === 'cora-sid');
    const settings = useVoice.getState().settings;
    expect(voiceFor('cora:abc')).toBeUndefined();
    useVoice.setState({ settings: { ...settings, coraVoiceId: 'EXAVITQu4vr4xnSDxMaL' } });
    expect(voiceFor('cora:abc')).toBe('EXAVITQu4vr4xnSDxMaL');
    expect(voiceFor('cora-notify-1')).toBe('EXAVITQu4vr4xnSDxMaL');
    expect(voiceFor('summary:1', 'cora-sid')).toBe('EXAVITQu4vr4xnSDxMaL');
    expect(voiceFor('summary:1', 'other-session')).toBeUndefined();
    expect(voiceFor('ci:x')).toBeUndefined();
    useVoice.setState({ settings });
  });

  it("Cora's lens moves only to Cora's own voice, not a session's", () => {
    setCoraSession((sid) => sid === 'cora-sid');
    expect(coraReading(null)).toBe(false);
    expect(coraReading({ id: 'cora-jira-1', sentence: '', progress: 0 })).toBe(true);
    expect(coraReading({ id: 'summary:1', sentence: '', progress: 0, sessionId: 'cora-sid' })).toBe(true);
    expect(coraReading({ id: 'summary:1', sentence: '', progress: 0, sessionId: 'other-session' })).toBe(false);
    expect(coraReading({ id: 'step:abc', sentence: '', progress: 0 })).toBe(false);
  });
});
