import { describe, expect, it } from 'vitest';
import { inputBox, inputBoxText } from '../src/screen';

const RULE = '─'.repeat(80);

describe('inputBox', () => {
  it("finds Claude Code's input box, also with a band of its own below it", () => {
    expect(inputBox(['older output', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on'])).toEqual({ top: 1, bottom: 3 });
    expect(inputBox(['x', RULE, '❯ hi', RULE, RULE, ' a band', RULE])).toEqual({ top: 1, bottom: 3 });
  });
  it('none while a screen of its own is up (/mcp, /config): the box is gone', () => {
    expect(inputBox([' Manage MCP servers', '', ' ❯ 1. claude.ai Gmail  ✔ connected', '   2. GitLab  ✔ connected', '', ' Esc to exit'])).toBeNull();
    expect(inputBox([RULE, ' Settings  Status  Config  Usage', RULE, '  Auto-compact  true'])).toBeNull();
  });
});

describe('inputBoxText', () => {
  it("reads the draft in the box, without the prompt mark (several lines too), or '' when it's empty", () => {
    expect(inputBoxText(['x', RULE, '❯ fix the login bug', RULE])).toBe('fix the login bug');
    expect(inputBoxText(['x', RULE, '❯ first line', '  second line', RULE])).toBe('first line\nsecond line');
    expect(inputBoxText(['x', RULE, '❯ ', RULE])).toBe('');
  });
  it('null with no box on screen', () => {
    expect(inputBoxText(['Claude Code v2.1.316', 'loading…'])).toBeNull();
  });
});
