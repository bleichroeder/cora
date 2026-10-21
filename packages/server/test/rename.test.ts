import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataHome, hookToken, legacyDataDirs } from '../src/config';
import { legacySocketPath, socketPath } from '../src/ptyhost/protocol';

describe('agent-brain → Cora', () => {
  it('copies the old data folder to ~/.cora the first time, then uses it', () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-home-'));
    const old = join(home, '.agent-brain');
    mkdirSync(old);
    writeFileSync(join(old, 'token'), 'tok');
    writeFileSync(join(old, 'agent-brain.ico'), 'ico');
    const dir = dataHome(home, {});
    expect(dir).toBe(join(home, '.cora'));
    expect(readFileSync(join(dir, 'token'), 'utf8')).toBe('tok');
    expect(existsSync(join(dir, 'cora.ico'))).toBe(true);
    expect(existsSync(old)).toBe(true);
    writeFileSync(join(old, 'token'), 'changed later');
    expect(readFileSync(join(dataHome(home, {}), 'token'), 'utf8')).toBe('tok');
  });

  it('honours CORA_HOME, then the old AGENT_BRAIN_HOME; a fresh machine just gets ~/.cora', () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-home-'));
    expect(dataHome(home, { CORA_HOME: 'X', AGENT_BRAIN_HOME: 'Y' })).toBe('X');
    expect(dataHome(home, { AGENT_BRAIN_HOME: 'Y' })).toBe('Y');
    expect(dataHome(home, {})).toBe(join(home, '.cora'));
  });

  it('looks for a terminal host still running from the old folder, at its old address', () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-home-'));
    const old = join(home, '.agent-brain');
    expect(legacyDataDirs(join(home, '.cora'), old)).toEqual([]);
    mkdirSync(old);
    expect(legacyDataDirs(join(home, '.cora'), old)).toEqual([old]);
    expect(legacyDataDirs(old, old)).toEqual([]);
    if (process.platform === 'win32') {
      expect(socketPath(old)).toMatch(/\\pipe\\cora-pty-[0-9a-f]{16}$/);
      expect(legacySocketPath(old)).toMatch(/\\pipe\\agent-brain-pty-[0-9a-f]{16}$/);
      expect(legacySocketPath(old).slice(-16)).toBe(socketPath(old).slice(-16));
    }
  });

  it('reads the hook token from either header name', () => {
    expect(hookToken({ headers: { 'x-cora-token': 'a' } })).toBe('a');
    expect(hookToken({ headers: { 'x-agent-brain-token': 'b' } })).toBe('b');
    expect(hookToken({ headers: {} })).toBeUndefined();
  });
});
