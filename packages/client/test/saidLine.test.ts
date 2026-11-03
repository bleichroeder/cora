import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

/** "Say it again" on a spoken line plays it in the session's voice (found live: it played in the default one). */
const spoke = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../src/lib/voice', async (orig) => ({
  ...(await orig<typeof import('../src/lib/voice')>()),
  // voice on, with a key; nothing playing
  useVoice: (sel: (s: unknown) => unknown) => sel({ settings: { enabled: true }, key: { set: true }, reading: null }),
  speak: (...a: unknown[]) => void spoke.calls.push(a),
  stopSpeaking: () => undefined,
}));

import { SaidLine } from '../src/components/ToolRow';

const buttonOf = (el: ReactElement): ReactElement => {
  const kids = ([] as unknown[]).concat((el.props as { children?: unknown }).children ?? []);
  return kids.find((k): k is ReactElement => !!k && typeof k === 'object' && (k as ReactElement).type === 'button') as ReactElement;
};

describe('SaidLine', () => {
  it("hearing it again uses the session's voice: the session goes with it", () => {
    const el = SaidLine({ id: 'said:tu1', text: 'Done with the build.', sessionId: 'sess-1' }) as ReactElement;
    (buttonOf(el).props as { onClick(): void }).onClick();
    expect(spoke.calls).toHaveLength(1);
    expect(spoke.calls[0][0]).toBe('said:tu1');
    expect(spoke.calls[0][4]).toBe('sess-1');
  });
});
