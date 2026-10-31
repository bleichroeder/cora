import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Copies, CopyReader, copyArgs } from '../src/orchestrator/copy';

describe('side questions to a copy of a session', () => {
  it('a fork that keeps nothing, reports nothing and changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-copy-'));
    const a = copyArgs(dir, 'sess-1', 'opus');
    expect(a.slice(0, 6)).toEqual(['-p', '--resume', 'sess-1', '--fork-session', '--no-session-persistence', '--safe-mode']);
    expect(a).toEqual(expect.arrayContaining(['--strict-mcp-config', '--output-format', 'stream-json', '--verbose', '--model', 'opus']));
    expect(a[a.indexOf('--allowedTools') + 1]).toBe('Read,Grep,Glob');
    expect(a[a.indexOf('--disallowedTools') + 1]).toMatch(/^Bash,Edit,Write,NotebookEdit/);
    expect(JSON.parse(readFileSync(a[a.indexOf('--settings') + 1], 'utf8'))).toEqual({ disableAllHooks: true, crossSessionInbound: 'refuse' });
  });

  it('every text it wrote is the answer (not only the last), across split chunks', () => {
    const r = new CopyReader();
    const lines = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'The code word was banana-42.' }, { type: 'tool_use', name: 'Glob' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'a.json' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'The folder has a.json.' }] } },
      { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.03 },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n');
    r.push(lines.slice(0, 50));
    r.push(lines.slice(50));
    r.end();
    expect(r.answer()).toEqual({ ok: true, text: 'The code word was banana-42.\n\nThe folder has a.json.', costUsd: 0.03 });
    const bad = new CopyReader();
    bad.push(JSON.stringify({ type: 'result', is_error: true, result: 'No conversation found with session ID: x' }) + '\n');
    expect(bad.answer()).toEqual({ ok: false, error: 'No conversation found with session ID: x' });
  });

  it('two at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runs: string[][] = [];
    const c = new Copies({ dir: mkdtempSync(join(tmpdir(), 'cora-copy-')), claudeCmd: () => ['claude'], run: async (cmd) => (runs.push(cmd), await gate, { ok: true, text: 'ok' }) });
    const q = (n: number) => c.ask({ sessionId: `s${n}`, cwd: '.', question: 'q' });
    const a = q(1);
    const b = q(2);
    expect(await q(3)).toEqual({ ok: false, error: expect.stringMatching(/two side questions/) });
    release();
    expect(await a).toEqual({ ok: true, text: 'ok' });
    await b;
    expect(runs.map((r) => r[3])).toEqual(['s1', 's2']);
    expect(runs[0][0]).toBe('claude');
  });
});
