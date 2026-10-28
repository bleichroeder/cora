import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS, buildPrompt, stopKey, caretOnEdge, filterCommands, keyAction, mergeCommands, promptHistory, quotePath, runningCommand, RUNNING_FOR_MS, slashQuery, stepHistory, type SlashCommand } from '../src/lib/composer';

const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe('composer keys', () => {
  it('Enter sends and Shift+Enter is a new line, or the other way round; Ctrl+Enter always sends', () => {
    expect(keyAction(key('Enter'), 'enter')).toBe('send');
    expect(keyAction(key('Enter', { shiftKey: true }), 'enter')).toBe('newline');
    expect(keyAction(key('Enter'), 'ctrl-enter')).toBe('newline');
    expect(keyAction(key('Enter', { ctrlKey: true }), 'ctrl-enter')).toBe('send');
    expect(keyAction(key('Enter', { ctrlKey: true }), 'enter')).toBe('send');
    expect(keyAction(key('Enter', { isComposing: true }), 'enter')).toBeNull();
    expect(keyAction(key('a'), 'enter')).toBeNull();
  });
});

describe('slash commands', () => {
  const cmds: SlashCommand[] = [
    { name: 'jira', description: 'Fetch a Jira issue', hint: '<key>', kind: 'skill', source: 'user' },
    { name: 'superpowers:brainstorming', description: 'Ideas first', kind: 'skill', source: 'superpowers' },
    { name: 'compact', description: 'Free up context', kind: 'builtin' },
    { name: 'context', description: 'Show what fills the context window', kind: 'builtin' },
    { name: 'clear', description: 'Start fresh', kind: 'builtin' },
  ];
  it('only a / at the start, on the command word', () => {
    expect(slashQuery('/ji', 3)).toBe('ji');
    expect(slashQuery('/', 1)).toBe('');
    expect(slashQuery('/jira ABC-1', 11)).toBeNull();
    expect(slashQuery('/jira ABC-1', 5)).toBe('jira');
    expect(slashQuery('/jira', 3)).toBeNull(); // in the middle of the word
    expect(slashQuery('see /jira', 9)).toBeNull();
    expect(slashQuery('a\n/jira', 7)).toBeNull();
  });
  it('ranks name prefixes first, then names containing it, then descriptions', () => {
    expect(filterCommands(cmds, 'c').map((c) => c.name)).toEqual(['clear', 'compact', 'context']);
    expect(filterCommands(cmds, 'brain').map((c) => c.name)).toEqual(['superpowers:brainstorming']);
    expect(filterCommands(cmds, 'jira').map((c) => c.name)).toEqual(['jira']);
    expect(filterCommands(cmds, 'context').map((c) => c.name)).toEqual(['context', 'compact']);
    expect(filterCommands(cmds, '').length).toBe(5);
  });
  it("a skill can't hide a built-in", () => {
    const merged = mergeCommands(BUILTIN_COMMANDS, [{ name: 'clear', description: 'mine', kind: 'command', source: 'user' }, cmds[0]]);
    expect(merged.filter((c) => c.name === 'clear')).toHaveLength(1);
    expect(merged.find((c) => c.name === 'clear')?.kind).toBe('builtin');
    expect(merged.some((c) => c.name === 'jira')).toBe(true);
    expect(BUILTIN_COMMANDS.some((c) => c.name === 'resume')).toBe(false);
  });
});

describe('prompt building', () => {
  it('adds attached paths after the text, quoted when they have spaces', () => {
    expect(buildPrompt('look at this  \n', [])).toBe('look at this');
    expect(buildPrompt('what is wrong here?', [{ path: 'C:\\Users\\D\\.cora\\attachments\\s\\shot.png', name: 'shot.png', image: true }, { path: 'C:\\My Files\\log.txt', name: 'log.txt', image: false }])).toBe(
      'what is wrong here?\n\nC:\\Users\\D\\.cora\\attachments\\s\\shot.png\n"C:\\My Files\\log.txt"',
    );
    expect(buildPrompt('  ', [{ path: '/tmp/a.png', name: 'a.png', image: true }])).toBe('/tmp/a.png');
    expect(quotePath('/a b')).toBe('"/a b"');
  });
});

describe('prompt history', () => {
  it('transcript prompts and ones sent from here not in it yet, in time order; repeats in a row collapse', () => {
    const at = (text: string, ts: number) => ({ text, ts });
    expect(promptHistory([at('one', 1), at('two', 2), at('two', 3)], [at('two', 2), at('three', 4)])).toEqual(['one', 'two', 'three']);
    // a prompt sent from here that the transcript hasn't caught up with sits where it was sent
    expect(promptHistory([at('one', 1), at('typed in the terminal', 5)], [at('a\nb', 3)])).toEqual(['one', 'a\nb', 'typed in the terminal']);
    // the transcript's copy (whitespace aside) stands in for it
    expect(promptHistory([at('a b', 4)], [at('a\nb', 3)])).toEqual(['a b']);
    expect(promptHistory([], [])).toEqual([]);
  });
  it('steps back from your text and forward to it again', () => {
    expect(stepHistory(3, null, -1)).toBe(2);
    expect(stepHistory(3, 2, -1)).toBe(1);
    expect(stepHistory(3, 0, -1)).toBeUndefined();
    expect(stepHistory(3, 1, 1)).toBe(2);
    expect(stepHistory(3, 2, 1)).toBeNull();
    expect(stepHistory(3, null, 1)).toBeUndefined();
    expect(stepHistory(0, null, -1)).toBeUndefined();
  });
  it('leaves a multi-line prompt only from its first or last line', () => {
    expect(caretOnEdge('a\nb', 0, 0, -1)).toBe(true);
    expect(caretOnEdge('a\nb', 3, 3, -1)).toBe(false);
    expect(caretOnEdge('a\nb', 3, 3, 1)).toBe(true);
    expect(caretOnEdge('a\nb', 0, 0, 1)).toBe(false);
  });
});

describe("the composer's terminal keys", () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; isComposing: boolean }> = {}) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
  it('Esc stops the work and never throws the draft away', () => {
    expect(stopKey(k('Escape'), { selection: false })).toBe('esc');
    expect(stopKey(k('Escape'), { selection: true })).toBe('esc');
    expect(stopKey(k('Escape', { shiftKey: true }), { selection: false })).toBe(null);
    expect(stopKey(k('Escape', { isComposing: true }), { selection: false })).toBe(null);
  });
  it('Ctrl+C stops the work unless text is selected (then it copies); Ctrl+Shift+C and plain c are left alone', () => {
    expect(stopKey(k('c', { ctrlKey: true }), { selection: false })).toBe('ctrl-c');
    expect(stopKey(k('C', { ctrlKey: true }), { selection: false })).toBe('ctrl-c');
    expect(stopKey(k('c', { ctrlKey: true }), { selection: true })).toBe(null);
    expect(stopKey(k('c', { ctrlKey: true, shiftKey: true }), { selection: false })).toBe(null);
    expect(stopKey(k('c'), { selection: false })).toBe(null);
  });
});

describe('a command sent with !', () => {
  const sent = (text: string, ts: number) => ({ text, ts });
  it('runs until the transcript has a command of yours from then on', () => {
    expect(runningCommand([sent('fix it', 0), sent('! npm test', 1000)], [], 5000)).toEqual({ command: 'npm test', at: 1000 });
    // the transcript writes it when it's done, with the time it started (a little before it was "sent" counts too)
    expect(runningCommand([sent('!npm test', 1000)], [990], 5000)).toBeNull();
    // an earlier command of yours isn't this one
    expect(runningCommand([sent('!npm test', 100_000)], [1000], 105_000)).toEqual({ command: 'npm test', at: 100_000 });
  });
  it('only the last thing sent, one line, for a while', () => {
    expect(runningCommand([sent('!ls', 1000), sent('and then?', 2000)], [], 3000)).toBeNull();
    expect(runningCommand([sent('!ls\nmore', 1000)], [], 3000)).toBeNull();
    expect(runningCommand([sent('!', 1000)], [], 3000)).toBeNull();
    expect(runningCommand([sent('!ls', 1000)], [], 1000 + RUNNING_FOR_MS + 1)).toBeNull();
    expect(runningCommand([], [], 0)).toBeNull();
  });
});
