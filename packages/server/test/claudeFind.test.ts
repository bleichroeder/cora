import { describe, expect, it } from 'vitest';
import { findClaude } from '../src/pty';

const env = { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\a', PATH: 'C:\\tools;C:\\Users\\a\\AppData\\Roaming\\npm' };
const npm = 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const native = 'C:\\Users\\a\\.local\\bin\\claude.exe';

describe('Claude Code, wherever it is installed', () => {
  it('the npm install, then the native installer, then claude.exe on PATH: always the real exe', () => {
    expect(findClaude(env, (p) => p === npm || p === native, true)).toEqual({ cmd: [npm], how: 'npm' });
    expect(findClaude(env, (p) => p === native, true)).toEqual({ cmd: [native], how: 'native' });
    expect(findClaude(env, (p) => p === 'C:\\tools\\claude.exe', true)).toEqual({ cmd: ['C:\\tools\\claude.exe'], how: 'path' });
  });
  it('only an npm shim (or nothing) goes through cmd.exe; a stand-in and other systems as before', () => {
    expect(findClaude(env, (p) => p === 'C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd', true)).toEqual({ cmd: ['cmd.exe', '/d', '/c', 'claude'], how: 'shim' });
    expect(findClaude(env, () => false, true).how).toBe('missing');
    expect(findClaude({ ...env, CORA_CLAUDE_CMD: '["node","fake.mjs"]' }, () => true, true)).toEqual({ cmd: ['node', 'fake.mjs'], how: 'custom' });
    expect(findClaude({}, () => false, false)).toEqual({ cmd: ['claude'], how: 'unix' });
  });
});
