import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeFor } from '../src/runtime';

describe('where Cora runs from', () => {
  it('a dev checkout: the repo, the system node, electron.exe with Cora\'s folder at login', () => {
    const r = runtimeFor({ packaged: false, execPath: 'C:\\code\\cora\\node_modules\\electron\\dist\\electron.exe', dirname: 'C:\\code\\cora\\packages\\desktop\\dist', resourcesPath: 'x' });
    expect(r.root).toBe(resolve('C:\\code\\cora'));
    expect(r.cli).toBe(join(resolve('C:\\code\\cora'), 'packages', 'server', 'dist', 'cli.js'));
    expect(r.node).toEqual({ file: 'node', env: { ELECTRON_RUN_AS_NODE: undefined } });
    expect(r.hostNode).toBeUndefined();
    expect(r.login.args).toEqual([join(resolve('C:\\code\\cora'), 'packages', 'desktop'), '--hidden']);
    expect(r.serverArgs).toEqual([]);
  });

  it('installed: Cora.exe as Node for the server, the bundled node for the terminal host, no repo', () => {
    const app = 'C:\\Users\\a\\AppData\\Local\\Programs\\Cora';
    const r = runtimeFor({ packaged: true, execPath: `${app}\\Cora.exe`, dirname: `${app}\\resources\\app\\packages\\desktop\\dist`, resourcesPath: `${app}\\resources` });
    expect(r.root).toBe(resolve(`${app}\\resources\\app`));
    expect(r.node).toEqual({ file: `${app}\\Cora.exe`, env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(r.hostNode).toBe(join(`${app}\\resources`, 'node', 'node.exe'));
    expect(r.login).toEqual({ path: `${app}\\Cora.exe`, args: ['--hidden'] });
    expect(r.serverArgs).toEqual(['--no-security-check']);
  });
});
