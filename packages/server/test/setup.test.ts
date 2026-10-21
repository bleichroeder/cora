import { describe, expect, it } from 'vitest';
import { setupFirstRun, setupStatus } from '@cora/shared';
import { checkSetup, mergePath, setupCommand, windowScript, type SetupDeps } from '../src/setup';

const deps = (o: Partial<SetupDeps> = {}): SetupDeps => ({
  claude: () => ({ found: true, path: 'C:\\npm\\claude.exe', signedIn: true, email: 'dana@example.com' }),
  hooks: () => true,
  which: async (c) => (['git', 'glab', 'kubectl', 'npx'].includes(c) ? `C:\\bin\\${c}.exe` : null),
  glabAuthed: async () => true,
  kubeconfigs: () => 2,
  voiceKey: () => true,
  slack: () => true,
  gmail: () => true,
  jira: () => ({ on: true, site: 'example.atlassian.net' }),
  agent: () => true,
  mcp: () => ['atlassian', 'GitLab'],
  gitlabHost: () => 'gitlab.com',
  skipped: () => [],
  onePassword: async () => ({ app: true, cli: true, connected: true }),
  ...o,
});
const byId = async (o: Partial<SetupDeps> = {}): Promise<Record<string, any>> => Object.fromEntries((await checkSetup(deps(o))).map((i) => [i.id, i]));

describe('setting Cora up', () => {
  it('statuses: ready, partly, needs; skipped only when not ready, and never for a required item', () => {
    expect(setupStatus([{ done: true }, { done: false, optional: true }], false)).toBe('ready');
    expect(setupStatus([{ done: true }, { done: false }], false)).toBe('partial');
    expect(setupStatus([{ done: false }], false)).toBe('needs');
    expect(setupStatus([{ done: false }], true)).toBe('skipped');
    expect(setupStatus([{ done: true }], true)).toBe('ready');
    expect(setupStatus([{ done: false }], true, true)).toBe('needs');
  });

  it('everything there: every item ready, required first', async () => {
    const items = await checkSetup(deps());
    expect(items.slice(0, 2).map((i) => [i.id, i.required])).toEqual([['claude', true], ['hooks', true]]);
    expect(items.filter((i) => i.status !== 'ready').map((i) => i.id)).toEqual([]);
  });

  it('glab installed but signed out: pipelines partly ready, and sign-in comes after the install', async () => {
    const s = await byId({ glabAuthed: async () => false });
    expect(s.pipelines.status).toBe('partial');
    const n = await byId({ which: async (c) => (c === 'git' ? 'git.exe' : null), glabAuthed: async () => false });
    expect(n.pipelines.needs.find((x: any) => x.id === 'glab-login').after).toBe('glab');
    expect(n.pipelines.needs.find((x: any) => x.id === 'glab').command).toBe('winget install --id GLab.GLab -e --accept-package-agreements --accept-source-agreements');
  });

  it("Cora's agent: the MCP servers are extras; skipping works for features, not the hooks", async () => {
    const s = await byId({ mcp: () => [], skipped: () => ['voice', 'hooks'], voiceKey: () => false, hooks: () => false });
    expect(s.agent.status).toBe('ready');
    expect(s.agent.needs.filter((n: any) => n.optional).map((n: any) => n.id)).toEqual(['atlassian', 'gitlab']);
    expect(s.voice.status).toBe('skipped');
    expect(s.hooks.status).toBe('needs');
  });

  it('the first run: while something required is missing, or on a fresh install not yet seen', async () => {
    const items = await checkSetup(deps());
    expect(setupFirstRun({ items, seen: false, fresh: false })).toBe(false);
    expect(setupFirstRun({ items, seen: false, fresh: true })).toBe(true);
    expect(setupFirstRun({ items: await checkSetup(deps({ hooks: () => false })), seen: true, fresh: false })).toBe(true);
  });

  it('commands are fixed on the server, by need (nothing from the client runs)', () => {
    const ctx = { host: 'gitlab.example.com', claude: ['C:\\npm\\claude.exe'] };
    expect(setupCommand('pipelines', 'glab-login', ctx)).toBe('glab auth login --hostname gitlab.example.com');
    expect(setupCommand('agent', 'gitlab', ctx)).toBe("& 'C:\\npm\\claude.exe' mcp add --scope user --transport http GitLab https://gitlab.example.com/api/v4/mcp");
    expect(setupCommand('claude', 'signin', ctx)).toBe("& 'C:\\npm\\claude.exe'");
    expect(setupCommand('voice', 'key', ctx)).toBeNull();
    expect(setupCommand('nope', 'x', ctx)).toBeNull();
  });

  it("a tool installed a moment ago is found: Windows' saved PATH merged in, nothing lost or repeated", () => {
    expect(mergePath('C:\\a;C:\\b', 'C:\\B;C:\\c;;C:\\a\\')).toBe('C:\\a;C:\\b;C:\\c');
  });
});

describe('what counts as started', () => {
  it("what Cora does itself doesn't make a feature look partly ready", () => {
    expect(setupStatus([{ done: false, how: 'ok' }, { done: true, how: 'itself' }], false)).toBe('needs');
    expect(setupStatus([{ done: true, how: 'ok' }, { done: false, how: 'ok' }, { done: true, how: 'itself' }], false)).toBe('partial');
  });

  it("1Password: optional; the app and op install with winget; connecting them is yours, after op", async () => {
    const none = (await byId({ onePassword: async () => ({ app: false, cli: false, connected: false }) }))['1password'];
    expect(none).toMatchObject({ required: false, status: 'needs', page: 'onepassword' });
    expect(none.needs.map((n: any) => [n.id, n.how, n.done])).toEqual([['app', 'ok', false], ['cli', 'ok', false], ['connect', 'you', false]]);
    expect(none.needs[0].command).toMatch(/winget install --id AgileBits\.1Password -e/);
    expect(none.needs[1].command).toMatch(/AgileBits\.1Password\.CLI/);
    expect(none.needs[2].after).toBe('cli');
    expect((await byId({ onePassword: async () => ({ app: true, cli: true, connected: false }) }))['1password'].status).toBe('partial');
    expect((await byId())['1password'].status).toBe('ready');
    // no check at all (an older Cora's deps): nothing ready, nothing breaks
    expect((await byId({ onePassword: undefined }))['1password'].status).toBe('needs');
  });
});

describe("a setup command's window", () => {
  it('names itself, shows the command, runs it, then says it is done', () => {
    const s = windowScript("1password › app", "winget install --id AgileBits.1Password -e");
    expect(s).toContain("$Host.UI.RawUI.WindowTitle = 'Cora: 1password › app'");
    expect(s).toContain("Write-Host '> winget install --id AgileBits.1Password -e' -ForegroundColor Cyan; winget install --id AgileBits.1Password -e; ");
    expect(s).toMatch(/Done\. You can close this window/);
  });
});
