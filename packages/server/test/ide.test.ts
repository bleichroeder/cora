import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ide, findCodeCli, IDE_LICENSE_URL } from '../src/ide';

describe("the IDE panel's VS Code", () => {
  it('finds your installed VS Code’s CLI (code-tunnel runs serve-web itself)', () => {
    if (process.platform !== 'win32') return;
    const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', PATH: '' } as NodeJS.ProcessEnv;
    const want = join(env.LOCALAPPDATA!, 'Programs', 'Microsoft VS Code', 'bin', 'code-tunnel.exe');
    expect(findCodeCli(env, (p) => p === want)).toBe(want);
    expect(findCodeCli(env, () => false)).toBeNull();
  });

  it('asks for the licence first; no VS Code: says so; never starts without it accepted', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cora-ide-'));
    expect(new Ide({ dataDir, cli: null }).status()).toEqual({ state: 'missing', license: IDE_LICENSE_URL });
    const ide = new Ide({ dataDir, cli: 'C:\\nope\\code-tunnel.exe' });
    expect(ide.status().state).toBe('needs-ok');
    // not accepted: it doesn't start
    expect((await ide.start(false)).state).toBe('needs-ok');
  });
});
