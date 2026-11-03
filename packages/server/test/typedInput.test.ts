import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TYPED, TYPED_CHUNK, TYPED_GAP_MS, sendTyped, typedInput } from '../src/input';

/**
 * Cora's messages (and other prompts from anyone but the user at the keyboard) arrive as plain prompts: typed as keys,
 * never as a paste, which Claude Code marks as pasted text when it folds a long one (found live: a message from Cora
 * with a numbered list came as pasted text, and the session wouldn't act on it).
 */
describe('typedInput', () => {
  it('one short line: typed as is', () => {
    expect(typedInput('(Cora, for the user:) go ahead')).toEqual({ chunks: ['(Cora, for the user:) go ahead'], paste: false });
  });
  it('several lines: no paste, each line break an Alt+Enter (a new line, not a submit), blank lines kept', () => {
    const r = typedInput('(Cora, for the user:) Do this:\n\n1. review\n2. fix\r\n');
    expect(r).toEqual({ chunks: ['(Cora, for the user:) Do this:\x1b\r\x1b\r1. review\x1b\r2. fix'], paste: false });
    expect(JSON.stringify(r)).not.toContain('[200~');
  });
  it('a long one goes in small pieces, and a piece never splits the ESC from its CR', () => {
    const line = 'x'.repeat(TYPED_CHUNK - 1);
    const r = typedInput(`${line}\n${line}\n${'y'.repeat(500)}`) as { chunks: string[]; paste: boolean };
    expect(r.paste).toBe(false);
    for (const c of r.chunks) {
      expect(c.length).toBeLessThanOrEqual(TYPED_CHUNK + 1);
      expect(c.endsWith('\x1b')).toBe(false);
      expect(c.startsWith('\r')).toBe(false);
    }
    expect(r.chunks.join('')).toBe(`${line}\x1b\r${line}\x1b\r${'y'.repeat(500)}`);
  });
  it('never lets the text send keys of its own; tabs become spaces', () => {
    expect(typedInput('a\tb\x03\x1b[A\x9bc\nd')).toEqual({ chunks: ['a  b[Ac\x1b\rd'], paste: false });
  });
  it('past MAX_TYPED it would take too long to type: a paste', () => {
    const r = typedInput(`a\n${'b'.repeat(MAX_TYPED)}`) as { chunks: string[]; paste: boolean };
    expect(r.paste).toBe(true);
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0].startsWith('\x1b[200~')).toBe(true);
  });
  it('rejects empty text', () => {
    expect(typedInput(' \n\t\x1b ')).toHaveProperty('error');
  });
});

describe('sendTyped', () => {
  const into = (out: string[]) => ({ write: (_id: string, d: string) => out.push(d) });
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it('types the pieces a beat apart, then Enter after the last', () => {
    const out: string[] = [];
    const enter = sendTyped(into(out), 't1', { chunks: ['a', 'b', 'c'], paste: false });
    expect(out).toEqual(['a']);
    vi.advanceTimersByTime(TYPED_GAP_MS);
    expect(out).toEqual(['a', 'b']);
    vi.advanceTimersByTime(TYPED_GAP_MS);
    expect(out).toEqual(['a', 'b', 'c']);
    expect(enter).toBeGreaterThan(2 * TYPED_GAP_MS);
    vi.advanceTimersByTime(enter);
    expect(out).toEqual(['a', 'b', 'c', '\r']);
  });
  it('a second prompt into the same terminal waits for the first, so their pieces never mix', () => {
    const out: string[] = [];
    const ptys = into(out);
    sendTyped(ptys, 't2', { chunks: ['a1', 'a2'], paste: false });
    sendTyped(ptys, 't2', { chunks: ['b1', 'b2'], paste: false });
    vi.advanceTimersByTime(5000);
    expect(out).toEqual(['a1', 'a2', '\r', 'b1', 'b2', '\r']);
  });
  it('another terminal does not wait', () => {
    const out: string[] = [];
    const ptys = { write: (id: string, d: string) => out.push(`${id}:${d}`) };
    sendTyped(ptys, 't3', { chunks: ['a1', 'a2'], paste: false });
    sendTyped(ptys, 't4', { chunks: ['b1'], paste: false });
    expect(out).toEqual(['t3:a1', 't4:b1']);
  });
  it("another set of terminals (another Cora's) does not wait either", () => {
    const a: string[] = [];
    const b: string[] = [];
    sendTyped(into(a), 't5', { chunks: ['a1', 'a2'], paste: false });
    sendTyped(into(b), 't5', { chunks: ['b1'], paste: false });
    expect([a, b]).toEqual([['a1'], ['b1']]);
  });
});
