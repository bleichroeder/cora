import { describe, expect, it } from 'vitest';
import { askAnswer, askLine, askSentence, askTarget, formCheck, wantsTo } from '../src/lib/asks';

describe('asks in words', () => {
  it('says what a tool wants to do', () => {
    expect(wantsTo('Bash')).toBe('wants to run a command');
    expect(wantsTo('Edit')).toBe('wants to change a file');
    expect(wantsTo('WebFetch')).toBe('wants to fetch a page');
    expect(wantsTo('mcp__github__create_pr')).toBe('wants to use github');
    expect(wantsTo('Something')).toBe('wants permission');
  });

  it('finds the thing itself, on one line', () => {
    expect(askTarget({ command: 'docker push\n  ghcr.io/x' })).toBe('docker push ghcr.io/x');
    expect(askTarget({ file_path: 'C:\\code\\a.ts', old_string: 'x' })).toBe('C:\\code\\a.ts');
    expect(askTarget({ url: 'https://example.com' })).toBe('https://example.com');
    expect(askTarget(null)).toBe('');
  });

  it('a toast line and a notification sentence', () => {
    const bash = { kind: 'permission' as const, toolName: 'Bash', toolInput: { command: 'npm run build' } };
    expect(askLine(bash)).toBe('Bash · npm run build');
    expect(askSentence(bash)).toBe('Bash wants to run a command: npm run build');
    expect(askSentence({ kind: 'permission', toolName: 'Task', toolInput: {} })).toBe('Task wants permission');
    const q = { kind: 'question' as const, toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Which one?' }] } };
    expect(askLine(q)).toBe('A question: Which one?');
    expect(askSentence(q)).toBe('A question: Which one?');
    expect(askLine({ kind: 'elicitation', toolName: 'mcp__x', toolInput: {}, elicitation: { server: 'x', message: 'Pick a repo', schema: {} } })).toBe('Pick a repo');
  });
});

describe("answering Claude's questions", () => {
  it('one option, several joined, or your own words', () => {
    expect(askAnswer(['Yes'], '', false)).toBe('Yes');
    expect(askAnswer(['Yes'], '  maybe later ', false)).toBe('maybe later');
    expect(askAnswer(['A', 'C'], '', true)).toBe('A, C');
    expect(askAnswer(['A'], 'and D', true)).toBe('A, and D');
    expect(askAnswer([], ' ', true)).toBe('');
  });
  it("an MCP form: what's still required, numbers as numbers", () => {
    const schema = { properties: { name: { type: 'string', title: 'Name' }, n: { type: 'integer' }, ok: { type: 'boolean' } }, required: ['name', 'n', 'ok'] };
    expect(formCheck(schema, {})).toEqual({ missing: ['Name', 'n'], content: {} });
    expect(formCheck(schema, { name: 'x', n: '3.7', ok: false })).toEqual({ missing: [], content: { name: 'x', n: 3, ok: false } });
    expect(formCheck(schema, { name: '', n: 'abc' }).missing).toEqual(['Name', 'n']);
  });
});
