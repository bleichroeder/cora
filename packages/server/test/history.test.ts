import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listDirs, listHistory } from '../src/history';

const line = (o: object) => JSON.stringify(o) + '\n';

describe('listHistory', () => {
  it('reads cwd, first human prompt and ai-title; newest first; skips subagents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ab-hist-'));
    mkdirSync(join(root, 'C--proj', 's1', 'subagents'), { recursive: true });
    writeFileSync(join(root, 'C--proj', 's1.jsonl'),
      line({ type: 'mode', mode: 'normal', sessionId: 's1' }) +
      line({ type: 'user', isMeta: true, cwd: 'C:\\proj', sessionId: 's1', message: { role: 'user', content: '<command-name>/clear</command-name>' } }) +
      line({ type: 'user', cwd: 'C:\\proj', sessionId: 's1', origin: { kind: 'human' }, message: { role: 'user', content: 'Fix the flaky test please' } }) +
      line({ type: 'ai-title', aiTitle: 'Flaky test fix', sessionId: 's1' }));
    writeFileSync(join(root, 'C--proj', 's1', 'subagents', 'agent-x.jsonl'), line({ type: 'user' }));
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(root, 'C--proj', 's2.jsonl'), line({ type: 'user', cwd: 'C:\\other', sessionId: 's2', promptSource: 'typed', message: { role: 'user', content: 'hello' } }));
    const h = await listHistory(root, 10);
    expect(h.map((x) => x.sessionId)).toEqual(['s2', 's1']);
    expect(h[1]).toMatchObject({ sessionId: 's1', cwd: 'C:\\proj', title: 'Flaky test fix', firstPrompt: 'Fix the flaky test please', projectSlug: 'C--proj' });
    expect(h[0].title).toBe('');
  });
});

describe('listDirs', () => {
  it('lists subdirectories, skipping dot dirs and node_modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ab-dirs-'));
    for (const d of ['b', 'a', '.git', 'node_modules']) mkdirSync(join(root, d));
    writeFileSync(join(root, 'file.txt'), 'x');
    const r = await listDirs(root);
    expect(r.dirs).toEqual(['a', 'b']);
    expect(r.path).toBe(root);
  });
  it('returns an error for missing paths', async () => {
    expect((await listDirs(join(tmpdir(), 'definitely-missing-xyz'))).error).toBeTruthy();
  });
});
