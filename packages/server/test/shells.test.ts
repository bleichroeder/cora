import { describe, expect, it } from 'vitest';
import { detectShells, pickShell, wslDistros } from '../src/shells';

const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', PATH: 'C:\\Windows\\System32' };

describe('shell tabs: which shells there are', () => {
  it('as Windows Terminal finds them: PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, each WSL distro', () => {
    const have = new Set([
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Windows\\System32\\wsl.exe',
    ]);
    const s = detectShells(env, (p) => have.has(p), true, () => ['Ubuntu', 'Debian']);
    expect(s.map((x) => [x.id, x.name])).toEqual([
      ['pwsh', 'PowerShell'],
      ['powershell', 'Windows PowerShell'],
      ['cmd', 'Command Prompt'],
      ['gitbash', 'Git Bash'],
      ['wsl:Ubuntu', 'Ubuntu'],
      ['wsl:Debian', 'Debian'],
    ]);
    expect(s.find((x) => x.id === 'gitbash')!.cmd).toEqual(['C:\\Program Files\\Git\\bin\\bash.exe', '--login', '-i']);
    expect(s.find((x) => x.id === 'wsl:Ubuntu')).toMatchObject({ wsl: true, cmd: ['C:\\Windows\\System32\\wsl.exe', '-d', 'Ubuntu'] });
  });

  it('just Windows PowerShell (called PowerShell) and Command Prompt on a bare machine; $SHELL elsewhere', () => {
    const bare = detectShells(env, (p) => p.endsWith('powershell.exe') || p.endsWith('cmd.exe'), true, () => ['Ubuntu']);
    expect(bare.map((x) => x.name)).toEqual(['PowerShell', 'Command Prompt']);
    expect(detectShells({ SHELL: '/usr/bin/zsh' }, () => false, false).map((x) => [x.name, x.cmd])).toEqual([['zsh', ['/usr/bin/zsh']]]);
  });

  it("WSL's list (UTF-16, Docker's own distros left out); none when WSL isn't there", () => {
    expect(wslDistros(() => Buffer.from('Ubuntu\r\ndocker-desktop\r\nrancher-desktop-data\r\npodman-machine-default\r\nDebian\r\n', 'utf16le'))).toEqual(['Ubuntu', 'Debian']);
    expect(wslDistros(() => { throw new Error('no wsl'); })).toEqual([]);
  });

  it('opens the one asked for, else the default, else the first', () => {
    const s = detectShells(env, () => true, true, () => []);
    expect(pickShell(s, 'cmd').id).toBe('cmd');
    expect(pickShell(s, 'gone', 'gitbash').id).toBe('gitbash');
    expect(pickShell(s, undefined, 'gone').id).toBe('pwsh');
  });
});
