import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HistoryIndex, askForSession } from '../src/historySearch';
import { listHistory } from '../src/history';

function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'cora-hs-'));
  const write = (slug: string, id: string, lines: object[]) => {
    mkdirSync(join(dir, slug), { recursive: true });
    writeFileSync(join(dir, slug, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  const user = (text: string) => ({ type: 'user', cwd: 'C:/code/app', origin: { kind: 'human' }, message: { role: 'user', content: text } });
  const said = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const tool = (out: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: out }] } });
  write('C--code-app', 'aaaaaaaa-1', [user('The clip share endpoint returns 404 for archived clips'), said('Found it: the archive bucket path changed.'), tool('kubernetes secret zebra')]);
  write('C--code-app', 'bbbbbbbb-2', [user('Add dark mode to settings'), said('Done, using the design tokens.')]);
  write('C--code-web', 'cccccccc-3', [user('<command-name>/clear</command-name>'), user('Why is the CLIP pipeline red?')]);
  return dir;
}

describe('finding an old session', () => {
  it('by words said in it (prompts and replies, any order, any case), not tool output', async () => {
    const idx = new HistoryIndex({ projectsDir: projects() });
    await idx.refresh();
    expect((await idx.search('archive 404')).map((s) => s.sessionId)).toEqual(['aaaaaaaa-1']);
    expect((await idx.search('clip')).map((s) => s.sessionId).sort()).toEqual(['aaaaaaaa-1', 'cccccccc-3']);
    expect((await idx.search('dark mode'))[0]).toMatchObject({ sessionId: 'bbbbbbbb-2', cwd: 'C:/code/app', snippet: expect.stringContaining('dark mode') });
    expect(await idx.search('zebra')).toEqual([]);
    expect(await idx.search('/clear')).toEqual([]);
    expect(await idx.search(' ')).toEqual([]);
  });

  it('by what you remember of it: Claude picks from your sessions, and only ids of yours count', async () => {
    const dir = projects();
    const items = await listHistory(dir, 50);
    let input = '';
    const found = await askForSession({ description: 'the one about clip shares 404ing', items, dataDir: mkdtempSync(join(tmpdir(), 'cora-hs-d-')), run: async (_cmd, o) => ((input = o.input), { code: 0, stdout: 'aaaaaaaa-1\nnot-a-session\n', timedOut: false }) });
    expect(found.map((s) => s.sessionId)).toEqual(['aaaaaaaa-1']);
    expect(input).toContain('the one about clip shares 404ing');
    expect(input).toContain('aaaaaaaa-1 |');
    await expect(askForSession({ description: 'x', items, dataDir: mkdtempSync(join(tmpdir(), 'cora-hs-d-')), run: async () => ({ code: 1, stdout: '', timedOut: false }) })).rejects.toThrow(/couldn't answer/);
  });
});
