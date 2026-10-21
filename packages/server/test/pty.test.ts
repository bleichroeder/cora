import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { argsFor, cleanEnv, defaultShellCmd, PtyManager, shellEnv, type PtyLike, type SpawnFn } from '../src/pty';

class FakePty implements PtyLike {
  written: string[] = [];
  size = [0, 0];
  killed = false;
  private dataCbs: Array<(d: string) => void> = [];
  private exitCbs: Array<(e: { exitCode: number }) => void> = [];
  onData(cb: (d: string) => void) { this.dataCbs.push(cb); }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCbs.push(cb); }
  write(d: string) { this.written.push(d); }
  resize(c: number, r: number) { this.size = [c, r]; }
  kill() { this.killed = true; }
  emit(d: string) { this.dataCbs.forEach((cb) => cb(d)); }
  exit(code: number) { this.exitCbs.forEach((cb) => cb({ exitCode: code })); }
}

function setup(max = 1000) {
  const spawned: Array<{ file: string; args: string[]; cwd: string; pty: FakePty }> = [];
  const spawn: SpawnFn = (file, args, o) => {
    const pty = new FakePty();
    spawned.push({ file, args, cwd: o.cwd, pty });
    return pty;
  };
  const changes: any[] = [];
  const pm = new PtyManager({ spawn, onChange: (l) => changes.push(l), maxScrollback: max, claudeCmd: ['claude'] });
  return { pm, spawned, changes, cwd: mkdtempSync(join(tmpdir(), 'ab-pty-')) };
}

describe('cleanEnv', () => {
  it('drops variables scoped to the Claude session that launched agent-brain, keeps user config', () => {
    const env = cleanEnv({
      PATH: '/bin', CLAUDECODE: '1', AI_AGENT: 'claude', CLAUDE_PID: '1', CLAUDE_EFFORT: 'high',
      CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_EXECPATH: 'x', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_MESSAGING_SOCKET: 'p', CLAUDE_CODE_MESSAGING_TOKEN: 't',
      CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: 'd',
    });
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR', 'FORCE_COLOR', 'PATH']);
  });

  it("drops Cora's own variables (data dir, splash stage file) but keeps the hooks' env token", () => {
    const env = cleanEnv({ PATH: '/bin', CORA_HOME: 'h', CORA_STAGE_FILE: 's', AGENT_BRAIN_STAGE_FILE: 'a', CORA_CLAUDE_CMD: '[]', CORA_TOKEN: 't' });
    expect(Object.keys(env).sort()).toEqual(['CORA_TOKEN', 'FORCE_COLOR', 'PATH']);
  });
});

describe('shells', () => {
  const W = 'C:\\Windows';
  it('prefers pwsh (on PATH, then Program Files), else Windows PowerShell', () => {
    const has = (...ps: string[]) => (p: string) => ps.includes(p);
    const env = { PATH: 'C:\\bin;C:\\tools', ProgramFiles: 'C:\\Program Files', SystemRoot: W };
    expect(defaultShellCmd(env, has(join('C:\\tools', 'pwsh.exe')), true)).toEqual([join('C:\\tools', 'pwsh.exe'), '-NoLogo']);
    expect(defaultShellCmd(env, has(join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')), true)[0]).toBe(join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'));
    const winPs = join(W, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    expect(defaultShellCmd(env, has(winPs), true)).toEqual([winPs, '-NoLogo']);
    expect(defaultShellCmd(env, has(), true)).toEqual(['powershell.exe', '-NoLogo']);
    expect(defaultShellCmd({ SHELL: '/bin/zsh' }, has(), false)).toEqual(['/bin/zsh']);
    expect(defaultShellCmd({ CORA_SHELL_CMD: '["node","fake.mjs"]' }, has(), true)).toEqual(['node', 'fake.mjs']);
  });
  it("env: no Claude session markers, no forced colour unless it's yours", () => {
    expect(shellEnv({ PATH: 'x', CLAUDECODE: '1', CORA_STAGE_FILE: 'f' })).toEqual({ PATH: 'x' });
    expect(shellEnv({ FORCE_COLOR: '0' })).toEqual({ FORCE_COLOR: '0' });
  });
});

describe('argsFor', () => {
  it('new / resume / fork', () => {
    expect(argsFor('new', undefined, 'N')).toEqual(['--session-id', 'N']);
    expect(argsFor('resume', 'S', 'N')).toEqual(['--resume', 'S']);
    expect(argsFor('fork', 'S', 'N')).toEqual(['--resume', 'S', '--fork-session', '--session-id', 'N']);
  });
});

describe('PtyManager', () => {
  it('launches claude with the right args/cwd and reports the session id', () => {
    const { pm, spawned, changes, cwd } = setup();
    const t = pm.launch({ mode: 'new', cwd });
    expect(t.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(spawned[0]).toMatchObject({ file: 'claude', args: ['--session-id', t.sessionId], cwd });
    expect(changes.at(-1)[0]).toMatchObject({ terminalId: t.terminalId, sessionId: t.sessionId, alive: true, mode: 'new' });
    const r = pm.launch({ mode: 'resume', cwd, sessionId: 'abc' });
    expect(r.sessionId).toBe('abc');
    const f = pm.launch({ mode: 'fork', cwd, sessionId: 'abc' });
    expect(f.sessionId).not.toBe('abc');
  });

  it('resuming a session that already has a live terminal returns that terminal', () => {
    const { pm, spawned, cwd } = setup();
    const a = pm.launch({ mode: 'resume', cwd, sessionId: 'abc' });
    const b = pm.launch({ mode: 'resume', cwd, sessionId: 'abc' });
    expect(b.terminalId).toBe(a.terminalId);
    expect(spawned).toHaveLength(1);
  });

  it('validates input', () => {
    const { pm, cwd } = setup();
    expect(() => pm.launch({ mode: 'resume', cwd })).toThrow(/sessionId/);
    expect(() => pm.launch({ mode: 'new', cwd: join(cwd, 'missing') })).toThrow(/folder/);
  });

  it('attach replays capped scrollback then streams; write/resize reach the pty', () => {
    const { pm, spawned, cwd } = setup(10);
    const t = pm.launch({ mode: 'new', cwd });
    const pty = spawned[0].pty;
    pty.emit('0123456789ABCDEF');
    const got: string[] = [];
    const detach = pm.attach(t.terminalId, { data: (d) => got.push(d), exit: () => {} });
    expect(got).toEqual(['6789ABCDEF']);
    pty.emit('xyz');
    expect(got.at(-1)).toBe('xyz');
    detach();
    pty.emit('more');
    expect(got.at(-1)).toBe('xyz');
    expect(pm.write(t.terminalId, 'hi\r')).toBe(true);
    expect(pty.written).toEqual(['hi\r']);
    pm.resize(t.terminalId, 120, 40);
    expect(pty.size).toEqual([120, 40]);
  });

  it('end quits like you would (Ctrl+C twice), and stops the terminal if it is still up later', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const { pm, spawned, cwd } = setup();
      const t = pm.launch({ mode: 'new', cwd });
      expect(pm.end(t.terminalId)).toBe(true);
      expect(spawned[0].pty.written).toEqual(['\x03']);
      vi.advanceTimersByTime(300);
      expect(spawned[0].pty.written).toEqual(['\x03', '\x03']);
      expect(spawned[0].pty.killed).toBe(false);
      vi.advanceTimersByTime(4000);
      expect(spawned[0].pty.killed).toBe(true);
      // one that quit on its own isn't touched
      const u = pm.launch({ mode: 'new', cwd });
      pm.end(u.terminalId);
      spawned[1].pty.exit(0);
      vi.advanceTimersByTime(5000);
      expect(spawned[1].pty.killed).toBe(false);
      expect(pm.end(u.terminalId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exit marks the terminal dead and notifies attached clients', () => {
    const { pm, spawned, cwd } = setup();
    const t = pm.launch({ mode: 'new', cwd });
    let code: number | null = null;
    pm.attach(t.terminalId, { data: () => {}, exit: (c) => (code = c) });
    spawned[0].pty.exit(0);
    expect(code).toBe(0);
    expect(pm.list()[0]).toMatchObject({ alive: false, exitCode: 0 });
    expect(pm.write(t.terminalId, 'x')).toBe(false);
    // a dead terminal doesn't block resuming again
    const again = pm.launch({ mode: 'resume', cwd, sessionId: t.sessionId });
    expect(again.terminalId).not.toBe(t.terminalId);
  });

  it("mirrors the screen and publishes Claude Code's working indicator", async () => {
    const { pm, spawned, changes, cwd } = setup();
    const t = pm.launch({ mode: 'new', cwd });
    spawned[0].pty.emit('\x1b[1m✻ Cogitating…\x1b[22m (4s · esc to interrupt)');
    await new Promise((r) => setTimeout(r, 60));
    pm.scanStatus();
    expect(pm.list()[0].status).toBe('✻ Cogitating… (4s · esc to interrupt)');
    expect(changes.at(-1)[0].status).toBe('✻ Cogitating… (4s · esc to interrupt)');
    spawned[0].pty.emit('\x1b[2J\x1b[H✻ Baked for 4s');
    await new Promise((r) => setTimeout(r, 60));
    pm.scanStatus();
    expect(pm.list().find((x) => x.terminalId === t.terminalId)?.status).toBeNull();
    pm.disposeAll();
  });

  it('a shell runs beside the session: its own command and env, never taken for its Claude', () => {
    const exited: string[] = [];
    const spawned: Array<{ file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; pty: FakePty }> = [];
    const pm = new PtyManager({ spawn: (file, args, o) => (spawned.push({ file, args, cwd: o.cwd, env: o.env, pty: new FakePty() }), spawned.at(-1)!.pty), claudeCmd: ['claude'], shellCmd: ['pwsh.exe', '-NoLogo'], screen: null, onExit: (t) => exited.push(t.terminalId) });
    const cwd = mkdtempSync(join(tmpdir(), 'ab-pty-'));
    expect(() => pm.launch({ mode: 'shell', cwd })).toThrow(/sessionId/);
    const claude = pm.launch({ mode: 'resume', cwd, sessionId: 's1' });
    const sh = pm.launch({ mode: 'shell', cwd, sessionId: 's1' });
    expect(spawned[1]).toMatchObject({ file: 'pwsh.exe', args: ['-NoLogo'], cwd });
    expect(spawned[1].env.CLAUDECODE).toBeUndefined();
    expect(sh).toMatchObject({ sessionId: 's1', mode: 'shell', alive: true });
    expect(pm.forSession('s1')?.terminalId).toBe(claude.terminalId);
    expect(pm.shellsFor('s1').map((t) => t.terminalId)).toEqual([sh.terminalId]);
    expect([pm.liveCount(), pm.liveShells()]).toEqual([2, 1]);
    // resuming the session again finds its Claude, not the shell
    expect(pm.launch({ mode: 'resume', cwd, sessionId: 's1' }).terminalId).toBe(claude.terminalId);
    // a shell ending doesn't end the session
    spawned[1].pty.exit(0);
    expect(exited).toEqual([]);
    expect(pm.list().map((t) => t.terminalId)).toEqual([claude.terminalId]); // `exit` typed: gone
  });

  it('keeps the newest ended Claude terminals, not every one since Cora started (audit B13)', () => {
    const { pm, spawned, cwd } = setup();
    const ids = Array.from({ length: 15 }, (_, i) => pm.launch({ mode: 'resume', cwd, sessionId: `s${i}` }).terminalId);
    spawned.forEach((x) => x.pty.exit(0));
    expect(pm.list().map((t) => t.terminalId)).toEqual(ids.slice(3));
  });

  it('a failed shell stays to show why; closing ends a live one and forgets it', () => {
    const { pm, spawned, changes, cwd } = setup();
    const a = pm.launch({ mode: 'shell', cwd, sessionId: 's1' });
    spawned[0].pty.exit(3);
    expect(pm.list()).toMatchObject([{ terminalId: a.terminalId, alive: false, exitCode: 3 }]);
    expect(pm.closeShell(a.terminalId)).toBe(true);
    expect(pm.list()).toEqual([]);
    const b = pm.launch({ mode: 'shell', cwd, sessionId: 's1' });
    expect(pm.closeShell(b.terminalId)).toBe(true);
    expect(spawned[1].pty.killed).toBe(true);
    spawned[1].pty.exit(1); // killed: whatever the code, it's gone
    expect(pm.list()).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
    const c = pm.launch({ mode: 'new', cwd });
    expect(pm.closeShell(c.terminalId)).toBe(false);
    expect(pm.closeShell('nope')).toBe(false);
  });

  it('forSession finds the live terminal', () => {
    const { pm, cwd } = setup();
    const t = pm.launch({ mode: 'resume', cwd, sessionId: 's9' });
    expect(pm.forSession('s9')?.terminalId).toBe(t.terminalId);
    expect(pm.forSession('nope')).toBeUndefined();
  });
});
