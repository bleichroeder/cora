import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Debrief } from '@cora/shared';
import { IdeBridge, debriefStepCmd, folderKey, inFolder } from '../src/ideBridge';
import { EXTENSION_CONTRIBUTES, EXTENSION_JS } from '../src/ideExtension';

describe('Cora and the IDE panel talking', () => {
  it('folders as both sides write them', () => {
    expect(folderKey('C:\\code\\Cora\\')).toBe('c:/code/cora');
    expect(inFolder('C:\\code\\cora\\src\\a.ts', 'c:/code/cora')).toBe(true);
    expect(inFolder('C:\\code\\cora2\\a.ts', 'c:/code/cora')).toBe(false);
  });

  it("a window waiting gets what's sent at once; one that isn't open gets nothing", async () => {
    let now = 1000;
    const b = new IdeBridge({ now: () => now });
    // no window open on it yet: not sent
    expect(b.send('C:\\code\\cora', { kind: 'open', path: 'C:\\code\\cora\\a.ts' })).toBe(false);
    const waiting = b.next('c:/code/cora', 5000);
    expect(b.connected('C:\\code\\cora')).toBe(true);
    expect(b.folderFor('C:\\code\\cora\\src\\x.ts')).toBe('c:/code/cora');
    expect(b.send('C:\\code\\cora', { kind: 'open', path: 'C:\\code\\cora\\a.ts', line: 3 })).toBe(true);
    expect(await waiting).toEqual([{ kind: 'open', path: 'C:\\code\\cora\\a.ts', line: 3 }]);
    // between its asks: kept for its next one
    expect(b.send('c:/code/cora', { kind: 'open', path: 'C:\\code\\cora\\b.ts' })).toBe(true);
    expect(await b.next('c:/code/cora')).toEqual([{ kind: 'open', path: 'C:\\code\\cora\\b.ts' }]);
    // gone quiet a while: not open any more
    now += 60_000;
    expect(b.connected('c:/code/cora')).toBe(false);
  });

  it('nothing comes: the wait ends empty', async () => {
    const b = new IdeBridge();
    expect(await b.next('c:/x', 20)).toEqual([]);
  });
});

describe("a debrief's step in the IDE", () => {
  const d: Debrief = {
    id: 'd1', sessionId: 's1', createdAt: 1, title: 'Port retry', task: 'Make it start.', depth: 'quick',
    steps: [
      { title: 'What was asked', kind: 'context', beats: [{ text: 'It stayed down.' }] },
      { title: 'The fix', kind: 'change', path: 'C:/r/server.ts', range: [10, 14], diff: true, beats: [{ text: 'Retries.', range: [12, 12] }, { text: 'A minute.' }], why: 'A held port.' },
    ],
    snaps: { 1: { start: 1, lines: [], before: 'old' } },
  };

  it('a file step: its lines, the beat\'s, the kept before-text, the bubble\'s header and state', () => {
    expect(debriefStepCmd(d, 1, 0, { name: 'Fixer', playing: true, speak: false })).toEqual({
      kind: 'debrief.step', sessionId: 's1', id: 'd1', name: 'Fixer', index: 1, total: 2, header: '2 / 2 · The fix', label: 'change',
      path: 'C:/r/server.ts', range: [10, 14], beatRange: [12, 12], before: true, beats: ['Retries.', 'A minute.'], beat: 0, why: 'A held port.', playing: true, speak: false,
    });
    expect(debriefStepCmd(d, 1, 1, { name: 'Fixer', playing: false, speak: true }).beatRange).toBeUndefined();
  });

  it('a step about no file: a page with the task and the steps, its own line lit', () => {
    const c = debriefStepCmd(d, 0, 0, { name: 'Fixer', playing: false, speak: false });
    expect(c.path).toBeUndefined();
    expect(c.doc!.split('\n')).toEqual(['# Port retry', '', 'Make it start.', '', '1. What was asked', '2. The fix', '']);
    expect(c.range).toEqual([5, 5]);
  });

  it("Teach me's quiz: a last page after the steps, its questions in the bubble", () => {
    const q = { ...d, depth: 'teach' as const, quiz: [{ q: 'Why retry?', options: ['speed', 'a held port'], answer: 1, why: 'Windows.' }] };
    expect(debriefStepCmd(q, 1, 0, { name: 'F', playing: false, speak: false }).header).toBe('2 / 3 · The fix');
    const c = debriefStepCmd(q, 2, 0, { name: 'F', playing: false, speak: false });
    expect(c).toMatchObject({ index: 2, total: 3, header: '3 / 3 · Check your understanding', label: 'quiz', range: [3, 3] });
    expect(c.beats).toEqual(['1. Why retry?  \n   a) speed  \n   b) a held port']);
    expect(JSON.stringify(c)).not.toContain('Windows.');
  });

  it("the extension's code parses", () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-ext-'));
    const f = join(dir, 'extension.js');
    writeFileSync(f, EXTENSION_JS({}));
    expect(() => execFileSync(process.execPath, ['--check', f])).not.toThrow();
    expect(EXTENSION_CONTRIBUTES.keybindings.map((k) => k.key)).toEqual(['alt+right', 'alt+left']);
  });
});
