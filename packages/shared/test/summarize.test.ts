import { describe, expect, it } from 'vitest';
import { summarizeTool } from '../src/summarize';

describe('summarizeTool', () => {
  it('Read: path + line count from the transcript result', () => {
    const s = summarizeTool('Read', { file_path: 'C:\\code\\proj\\src\\app.ts' }, undefined, {
      type: 'text',
      file: { filePath: 'C:\\code\\proj\\src\\app.ts', numLines: 42, totalLines: 42 },
    }, 'C:\\code\\proj');
    expect(s.summary).toBe('src/app.ts');
    expect(s.resultSummary).toBe('42 lines');
    expect(s.resource).toBe('files:src');
  });

  it('Edit: counts added/removed lines from structuredPatch', () => {
    const s = summarizeTool('Edit', { file_path: '/p/lib/a.ts', old_string: 'a', new_string: 'b' }, undefined, {
      structuredPatch: [{ lines: [' ctx', '-old1', '-old2', '+new1'] }],
    }, '/p');
    expect(s.summary).toBe('lib/a.ts');
    expect(s.resultSummary).toBe('+1 −2');
  });

  it('Grep: pattern + match counts', () => {
    const s = summarizeTool('Grep', { pattern: 'agent_id', path: 'src' }, undefined, { numFiles: 3, numLines: 9, mode: 'content' });
    expect(s.summary).toBe('"agent_id" in src');
    expect(s.resultSummary).toBe('9 matches in 3 files');
  });

  it('Glob: pattern + file count', () => {
    const s = summarizeTool('Glob', { pattern: '**/*.ts' }, undefined, { numFiles: 12, filenames: [] });
    expect(s.summary).toBe('**/*.ts');
    expect(s.resultSummary).toBe('12 files');
  });

  it('Bash: command, exit info and failure', () => {
    const ok = summarizeTool('Bash', { command: 'ls' }, undefined, { stdout: 'a\nb\n', stderr: '', interrupted: false });
    expect(ok.summary).toBe('ls');
    expect(ok.resource).toBe('shell');
    expect(ok.failed).toBeFalsy();
    expect(ok.resultSummary).toBe('2 lines');

    const bad = summarizeTool('Bash', { command: 'false' }, 'Exit code 1\nboom', undefined, undefined, true);
    expect(bad.failed).toBe(true);
    expect(bad.resultSummary).toBe('Exit code 1');
  });

  it('WebFetch: url + hostname resource', () => {
    const s = summarizeTool('WebFetch', { url: 'https://code.claude.com/docs/en/hooks', prompt: 'x' }, undefined, { bytes: 20480, code: 200 });
    expect(s.summary).toBe('code.claude.com/docs/en/hooks');
    expect(s.resource).toBe('web:code.claude.com');
    expect(s.resultSummary).toBe('20 KB');
  });

  it('Agent: description', () => {
    expect(summarizeTool('Agent', { description: 'Verify hook facts', prompt: 'long' }).summary).toBe('Verify hook facts');
  });

  it('MCP tools: server · tool and resources', () => {
    const s = summarizeTool('mcp__ops__triage_incident', { incidentId: 7 });
    expect(s.summary).toContain('incidentId');
    expect(s.resource).toBe('mcp:ops');
    expect(summarizeTool('mcp__playwright__browser_click', {}).resource).toBe('browser');
  });

  it("Cora's speak: what was said, and no resource", () => {
    const s = summarizeTool('mcp__cora__speak', { text: 'I fixed the login bug and the tests pass.' });
    expect(s.summary).toBe('I fixed the login bug and the tests pass.');
    expect(s.resource).toBeUndefined();
  });

  it('unknown tool falls back to truncated JSON', () => {
    const s = summarizeTool('Mystery', { a: 'x'.repeat(500) });
    expect(s.summary.length).toBeLessThanOrEqual(121);
  });
});

describe('file changes on tool events', () => {
  const patch = [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' a', '-b', '+B', ' c'] }];
  it('Edit carries the hunks and counts', () => {
    const s = summarizeTool('Edit', { file_path: '/x/a.ts' }, 'ok', { filePath: '/x/a.ts', structuredPatch: patch });
    expect(s.change).toEqual({ path: '/x/a.ts', kind: 'edit', add: 1, del: 1, hunks: patch });
  });
  it('a new file becomes one all-added hunk', () => {
    const s = summarizeTool('Write', { file_path: '/x/n.ts', content: 'one\ntwo\n' }, 'ok', { type: 'create', filePath: '/x/n.ts', content: 'one\ntwo\n', structuredPatch: [] });
    expect(s.change).toMatchObject({ kind: 'create', add: 2, del: 0, hunks: [{ oldStart: 0, newStart: 1, newLines: 2, lines: ['+one', '+two'] }] });
  });
  it('huge changes keep their counts but not their hunks; failures carry nothing', () => {
    const big = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3000, lines: Array.from({ length: 3000 }, (_, i) => `+${i}`) }];
    const s = summarizeTool('Edit', { file_path: '/x/b.ts' }, 'ok', { filePath: '/x/b.ts', structuredPatch: big });
    expect(s.change).toEqual({ path: '/x/b.ts', kind: 'edit', add: 3000, del: 0 });
    expect(summarizeTool('Edit', { file_path: '/x/b.ts' }, 'String not found', undefined, undefined, true).change).toBeUndefined();
  });
});

describe('background shell commands', () => {
  it('only a call that asked for the background is marked, not one whose output mentions it', () => {
    const line = 'Command running in background with ID: b123. Output is being written to: C:/t/b123.output. You will be notified when it completes.';
    expect(summarizeTool('Bash', { command: 'sleep 99', run_in_background: true }, line).background).toEqual({ taskId: 'b123', outputFile: 'C:/t/b123.output' });
    expect(summarizeTool('Bash', { command: 'sleep 99', run_in_background: true }, '', { stdout: '', backgroundTaskId: 'b9' }).background).toEqual({ taskId: 'b9' });
    expect(summarizeTool('Bash', { command: 'grep -r background .' }, `notes.md: ${line}`).background).toBeUndefined();
    expect(summarizeTool('Bash', { command: 'grep -r background .' }, line).background).toBeUndefined();
  });
});

describe('splitSay', () => {
  it("takes a reply's say-line out of it", async () => {
    const { splitSay } = await import('../src/summarize');
    expect(splitSay('Fixed it.\n\n<!-- say: Fixed the login bug and the tests pass. -->')).toEqual({ text: 'Fixed it.', said: 'Fixed the login bug and the tests pass.' });
    // spread over lines; only one that ends the reply counts
    expect(splitSay('A\n<!-- say: first -->\nB\n<!--say:\n  second  one\n-->')).toEqual({ text: 'A\n<!-- say: first -->\nB', said: 'second one' });
    // quoted in a reply about it: just text
    expect(splitSay('End it with `<!-- say: ... -->` and Cora reads it.')).toEqual({ text: 'End it with `<!-- say: ... -->` and Cora reads it.' });
    expect(splitSay('The format is `<!-- say: ... -->`')).toEqual({ text: 'The format is `<!-- say: ... -->`' });
    expect(splitSay('No line here.')).toEqual({ text: 'No line here.' });
    expect(splitSay('<!-- say: only this -->')).toEqual({ text: '', said: 'only this' });
    // other comments are left alone
    expect(splitSay('x <!-- note --> y')).toEqual({ text: 'x <!-- note --> y' });
  });
});

describe('splitExplains', () => {
  it('takes explains written in a reply out of it', async () => {
    const { splitExplains } = await import('../src/summarize');
    const reply = 'Here is the plan.\n\n<!-- cora:explain title="Release plan" format="markdown" -->\n# Plan\n\n```ts\nconst x = 1;\n```\n<!-- /cora:explain -->\n\nSee the viewer.';
    expect(splitExplains(reply)).toEqual({ text: 'Here is the plan.\n\nSee the viewer.', explains: [{ title: 'Release plan', format: 'markdown', content: '# Plan\n\n```ts\nconst x = 1;\n```' }] });
    expect(splitExplains('Nothing here.')).toEqual({ text: 'Nothing here.', explains: [] });
  });

  it('is lenient: no closing line, a fenced document, html by content, no title', async () => {
    const { splitExplains } = await import('../src/summarize');
    const open = splitExplains('Intro\n<!-- cora:explain title="Chart" format="html" -->\n<!doctype html><html><body>x</body></html>');
    expect(open).toEqual({ text: 'Intro', explains: [{ title: 'Chart', format: 'html', content: '<!doctype html><html><body>x</body></html>' }] });
    const fenced = splitExplains('<!-- cora:explain title="T" -->\n```markdown\n| a | b |\n|---|---|\n```\n<!-- /cora:explain -->');
    expect(fenced.explains[0]).toEqual({ title: 'T', format: 'markdown', content: '| a | b |\n|---|---|' });
    expect(splitExplains('<!-- cora:explain -->\n<html><body>y</body></html>\n<!-- /cora:explain -->').explains[0]).toMatchObject({ title: 'Document', format: 'html' });
    const two = splitExplains('<!-- cora:explain title="A" -->a<!-- /cora:explain -->\nmid\n<!-- cora:explain title="B" -->b<!-- /cora:explain -->');
    expect(two.explains.map((x) => x.title)).toEqual(['A', 'B']);
    expect(two.text).toBe('mid');
  });
});

describe('quoted markers are text', () => {
  it('an explain marker quoted mid-line is not an explain', async () => {
    const { splitExplains } = await import('../src/summarize');
    const t = 'Write it between `<!-- cora:explain title="T" -->` and `<!-- /cora:explain -->` lines.';
    expect(splitExplains(t)).toEqual({ text: t, explains: [] });
  });
});
