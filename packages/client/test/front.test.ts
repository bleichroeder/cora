import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE, type BrainEvent } from '@cora/shared';
import { frontLine, isFrontLine, useVoice } from '../src/lib/voice';
import { mergeFetched } from '../src/state/store';

const said: string[] = [];
const asked: any[] = [];
let n = 0;
let onAsk: () => void = () => {};
const ev = (sid: string, kind: BrainEvent['kind'], o: Partial<BrainEvent> = {}) => ({ id: `f${++n}`, sessionId: sid, agentId: 'main', kind, ts: Date.now(), ...o }) as BrainEvent;

describe('the voice front: a quick line when you speak', () => {
  beforeEach(() => {
    said.length = asked.length = 0;
    onAsk = () => {};
    useVoice.setState({ settings: { ...DEFAULT_VOICE, enabled: true }, reading: null });
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}');
      if (url === '/api/voice/front') {
        asked.push(body);
        onAsk();
        return { ok: true, json: async () => ({ line: 'Checking the webapi pipeline now.' }) };
      }
      if (url === '/api/voice/speech') said.push(body.text);
      return { ok: false, json: async () => ({ error: 'test' }) };
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks for a line for what you said, and says it', async () => {
    await frontLine('s1', "how's the webapi pipeline?");
    expect(asked[0]).toMatchObject({ text: "how's the webapi pipeline?", toCora: false });
    await vi.waitFor(() => expect(said).toEqual(['Checking the webapi pipeline now.']));
  });

  it('says nothing when the answer got there first, or the quick line is off', async () => {
    onAsk = () => mergeFetched('s2', [ev('s2', 'say', { text: 'It passed.', said: 'it passed' })]);
    await frontLine('s2', 'did it pass?');
    useVoice.setState({ settings: { ...DEFAULT_VOICE, enabled: true, front: false } });
    await frontLine('s3', 'anything?');
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toHaveLength(1);
    expect(said).toEqual([]);
  });

  it('knows its own lines (Cora waits for them, no follow-up listening after them)', () => {
    expect(isFrontLine('front:3')).toBe(true);
    expect(isFrontLine('cora:front:3')).toBe(true);
    expect(isFrontLine('said:x')).toBe(false);
    expect(isFrontLine(undefined)).toBe(false);
  });
});
