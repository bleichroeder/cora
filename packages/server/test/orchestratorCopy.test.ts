import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Copies, CopyReader, copyArgs, type CopyCost } from '../src/orchestrator/copy';
import { Audit } from '../src/audit';

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

  it("what each run cost goes to the audit log: the session it copied, what it read and wrote, its cost (a failed run's too)", async () => {
    // the result line's usage and cost, read from the stream
    const r = new CopyReader();
    r.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'It is in a.ts.' }] } }) + '\n');
    r.push(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 1.42, usage: { input_tokens: 12, cache_read_input_tokens: 458_000, cache_creation_input_tokens: 3_100, output_tokens: 640 } }) + '\n');
    r.end();
    expect(r.answer()).toEqual({ ok: true, text: 'It is in a.ts.', costUsd: 1.42, usage: { in: 12, cacheRead: 458_000, cacheWrite: 3_100, out: 640 } });

    const costs: CopyCost[] = [];
    let t = 1_000;
    const answers = [
      { ok: true as const, text: 'It is in a.ts.', costUsd: 1.42, usage: { in: 12, cacheRead: 458_000, cacheWrite: 3_100, out: 640 } },
      { ok: false as const, error: 'it gave no answer', costUsd: 0.9 },
    ];
    const c = new Copies({ dir: mkdtempSync(join(tmpdir(), 'cora-copy-')), claudeCmd: () => ['claude'], run: async () => ((t += 4_000), answers.shift()!), cost: (x) => void costs.push(x), now: () => t });
    expect(await c.ask({ sessionId: 'sess-lead', cwd: '.', question: 'where?', model: 'opus' })).toMatchObject({ ok: true, text: 'It is in a.ts.' });
    await c.ask({ sessionId: 'sess-eng', cwd: '.', question: 'why?' });
    expect(costs).toEqual([
      { sessionId: 'sess-lead', model: 'opus', ok: true, ms: 4_000, costUsd: 1.42, usage: { in: 12, cacheRead: 458_000, cacheWrite: 3_100, out: 640 } },
      { sessionId: 'sess-eng', ok: false, ms: 4_000, costUsd: 0.9 },
    ]);

    // written as a line of its own (kind copy), beside the decisions
    const file = join(mkdtempSync(join(tmpdir(), 'cora-audit-')), 'audit.log');
    const audit = new Audit(file);
    audit.copy(costs[0], 5_000);
    expect(readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([{ ts: 5_000, kind: 'copy', sessionId: 'sess-lead', model: 'opus', ok: true, ms: 4_000, costUsd: 1.42, usage: { in: 12, cacheRead: 458_000, cacheWrite: 3_100, out: 640 } }]);
  });
});
