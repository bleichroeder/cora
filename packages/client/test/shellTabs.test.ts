import { describe, expect, it } from 'vitest';
import { activeTab, afterClose, atPrompt, commandAt, shellLabel } from '../src/lib/shellTabs';

describe('shellLabel', () => {
  it('is PowerShell for the shell itself or no title yet', () => {
    for (const t of [undefined, '', '  ', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'Windows PowerShell', 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'Administrator: C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'pwsh']) {
      expect(shellLabel(t)).toBe('PowerShell');
    }
  });
  it('names the running program without its folder or extension', () => {
    expect(shellLabel('C:\\Program Files\\nodejs\\node.exe')).toBe('node');
    expect(shellLabel('"C:\\Program Files\\Git\\usr\\bin\\vim.exe" notes.md')).toBe('vim notes.md');
    expect(shellLabel('Administrator: C:\\WINDOWS\\system32\\cmd.exe')).toBe('cmd');
    expect(shellLabel('npm run dev')).toBe('npm run dev');
    expect(shellLabel('git.exe log')).toBe('git log');
    expect(shellLabel('/usr/bin/python3.exe')).toBe('python3');
    expect(shellLabel('david@box: ~/code')).toBe('david@box: ~/code');
  });
  it('keeps long titles short', () => {
    const l = shellLabel('x'.repeat(80));
    expect(l).toHaveLength(40);
    expect(l.endsWith('…')).toBe(true);
  });
});

describe('shellLabel: other kinds of shell', () => {
  it("a shell's own title shows its kind (Git Bash, a WSL distro, Command Prompt); a program still names the tab", () => {
    expect(shellLabel('MINGW64:/c/code/cora', 'Git Bash')).toBe('Git Bash');
    expect(shellLabel('david@PC: /mnt/c/code', 'Ubuntu')).toBe('Ubuntu');
    expect(shellLabel('Ubuntu', 'Ubuntu')).toBe('Ubuntu');
    expect(shellLabel('C:\\WINDOWS\\system32\\cmd.exe', 'Command Prompt')).toBe('Command Prompt');
    expect(shellLabel(undefined, 'Git Bash')).toBe('Git Bash');
    expect(shellLabel('npm run dev', 'Ubuntu')).toBe('npm run dev');
    // no kind known (an older shell): PowerShell, as before
    expect(shellLabel('pwsh')).toBe('PowerShell');
  });
});

describe('atPrompt', () => {
  it('knows PowerShell, cmd and Unix prompts', () => {
    expect(atPrompt('PS C:\\code\\cora>')).toBe(true);
    expect(atPrompt('PS C:\\code\\cora> ')).toBe(true);
    expect(atPrompt('C:\\code>')).toBe(true);
    expect(atPrompt('david@box:~/code$')).toBe(true);
    expect(atPrompt('~/code ❯')).toBe(true);
  });
  it('anything else counts as busy', () => {
    expect(atPrompt('')).toBe(false);
    expect(atPrompt('  VITE v6.0.0  ready in 300 ms')).toBe(false);
    expect(atPrompt('PS C:\\code> npm run dev')).toBe(false);
  });
});

describe('commandAt', () => {
  it('reads the command off a prompt line', () => {
    expect(commandAt('PS C:\\code\\cora> npm run dev')).toBe('npm run dev');
    expect(commandAt('PS C:\\code\\cora>   git status  ')).toBe('git status');
    expect(commandAt('C:\\code>dir')).toBe('dir');
    expect(commandAt('david@box:~/code$ make test')).toBe('make test');
  });
  it('nothing for an empty prompt or a line that is not one', () => {
    expect(commandAt('PS C:\\code\\cora> ')).toBeNull();
    expect(commandAt('Ok to proceed? (y)')).toBeNull();
    expect(commandAt('')).toBeNull();
  });
});

describe('tabs', () => {
  it('shows the remembered shell while it is open, else Claude', () => {
    expect(activeTab('b', ['a', 'b'])).toBe('b');
    expect(activeTab('gone', ['a'])).toBe('claude');
    expect(activeTab(undefined, [])).toBe('claude');
  });
  it('closing a tab moves to its left neighbour', () => {
    expect(afterClose('b', ['a', 'b', 'c'])).toBe('a');
    expect(afterClose('a', ['a', 'b'])).toBe('claude');
  });
});
