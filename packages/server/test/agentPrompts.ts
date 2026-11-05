import type { BrainEvent } from '@cora/shared';

/**
 * Claude Code in a fake terminal, as far as what's typed into it goes: the keys go into its box, and an Enter (a write
 * of a lone CR) sends what's there, which comes back as its session's prompt event (`heard`). A newline inside a prompt
 * is ESC CR; a lone ESC clears the box. `swallow(n)`: its next n Enters do nothing (the words stay in the box), as a
 * terminal that takes the keys and no prompt comes of them; Infinity for every one.
 */
export function promptsOnEnter(heard: (terminalId: string, text: string) => void) {
  const boxes = new Map<string, string>();
  let swallowing = 0;
  return {
    write(terminalId: string, d: string): void {
      if (d === '\x1b') return void boxes.delete(terminalId);
      if (d !== '\r') return void boxes.set(terminalId, (boxes.get(terminalId) ?? '') + d.replace(/\x1b\r/g, '\n').replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
      if (swallowing > 0) return void swallowing--;
      const text = boxes.get(terminalId) ?? '';
      boxes.delete(terminalId);
      if (text.trim()) heard(terminalId, text);
    },
    swallow: (n: number) => (swallowing = n),
    box: (terminalId: string) => boxes.get(terminalId) ?? '',
  };
}

/** A session's prompt, as its UserPromptSubmit hook (or its transcript) reports it. */
export const promptEvent = (sessionId: string, text: string, ts = Date.now()): BrainEvent => ({ id: `p-${Math.random().toString(36).slice(2)}`, seq: 1, sessionId, agentId: 'main', ts, kind: 'prompt', text, icon: { name: 'x' }, source: 'hook' }) as unknown as BrainEvent;
