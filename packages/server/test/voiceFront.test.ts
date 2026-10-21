import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { VoiceFront, cleanLine, frontPrompt, FRONT_TIMEOUT_MS } from '../src/voiceFront';

/** A pretend `claude -p --input-format stream-json`: what it was sent, and a way to answer. */
function fakeHaiku() {
  const sent: string[] = [];
  const spawned: string[][] = [];
  let child: any;
  const spawnFn = ((cmd: string, args: string[]) => {
    spawned.push([cmd, ...args]);
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { write: (s: string) => void sent.push(JSON.parse(s).message.content), end() {} });
    child.kill = () => {};
    return child;
  }) as any;
  const reply = (text: string) => {
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', result: text })}\n`));
  };
  return { sent, spawned, spawnFn, reply };
}
const front = (h: ReturnType<typeof fakeHaiku>) => new VoiceFront({ dataDir: mkdtempSync(join(tmpdir(), 'cora-front-')), claudeCmd: ['claude'], spawnFn: h.spawnFn });

describe('the voice front', () => {
  it('one warm Haiku, thinking off: a line for what you said', async () => {
    const h = fakeHaiku();
    const f = front(h);
    const p = f.line("how's webapi on dev?", { toCora: true, looking: 'canvas', working: ['canvas'] });
    expect(h.sent[0]).toContain("They said: how's webapi on dev?");
    h.reply('"Checking the webapi pipeline on dev now."');
    expect(await p).toBe('Checking the webapi pipeline on dev now.');
    const q = f.line('and canvas?', { toCora: true });
    h.reply('Looking at canvas now.');
    expect(await q).toBe('Looking at canvas now.');
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]).toEqual(expect.arrayContaining(['--model', 'haiku', '--input-format', 'stream-json', '--no-session-persistence', '--safe-mode']));
  });

  it("too slow: nothing; a late answer is never given to the next line", async () => {
    vi.useFakeTimers();
    try {
      const h = fakeHaiku();
      const f = front(h);
      const p = f.line('first', { toCora: true });
      await vi.advanceTimersByTimeAsync(FRONT_TIMEOUT_MS + 1);
      expect(await p).toBeNull();
      const q = f.line('second', { toCora: true });
      h.reply('Answer to first.');
      h.reply('Answer to second.');
      expect(await q).toBe('Answer to second.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the prompt and the cleaning', () => {
    expect(frontPrompt('bump it', { toCora: false, looking: 'webapi' })).toBe('They spoke to a Claude Code session named "webapi".\nThey said: bump it');
    expect(cleanLine('**Sure**, on it.\nextra')).toBe('Sure, on it.');
    expect(cleanLine('')).toBeNull();
    // small talk: no line (the answer is quick, a line would only repeat it)
    expect(cleanLine('SKIP')).toBeNull();
    expect(cleanLine('Skip.')).toBeNull();
    expect(cleanLine('Skipping the flaky test, checking the rest.')).toBe('Skipping the flaky test, checking the rest.');
    expect(cleanLine('x'.repeat(200))).toBeNull();
  });
});
