import { detectShells, pickShell, type Shell } from './shells';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { isSafeId, isShell, type ClaudeMode, type TerminalInfo, type TerminalMode } from '@cora/shared';
import type { Audit } from './audit';
import { headlessScreen, statusLine, type Screen } from './screen';
import { LocalBackend, type PtyBackend } from './ptyhost/backend';
import type { SpawnFn } from './ptyhost/spawn';

export type { TerminalInfo, TerminalMode };

export type { PtyLike, SpawnFn } from './ptyhost/spawn';

type Sink = { data(d: string): void; exit(code: number): void };
type Term = TerminalInfo & { buf: string; sinks: Set<Sink>; screen: Screen | null; dirty: boolean };

export function argsFor(mode: ClaudeMode, sessionId: string | undefined, newId: string): string[] {
  if (mode === 'new') return ['--session-id', newId];
  if (mode === 'resume') return ['--resume', sessionId!];
  return ['--resume', sessionId!, '--fork-session', '--session-id', newId];
}

/**
 * Environment for a hosted `claude`. If Cora was itself started from inside a Claude Code session,
 * that session's markers would leak in and make the child behave like a sub-process (e.g. transcript saving
 * off). Drop session-scoped variables; keep user configuration such as CLAUDE_CODE_USE_BEDROCK.
 */
const SESSION_VARS = new Set(['CLAUDECODE', 'AI_AGENT', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  // installed Cora runs its server as Cora.exe in Node mode: an Electron app started from a session (VS Code, Slack)
  // would start as plain Node too (docs/audit-2026-10-20.md S13)
  'ELECTRON_RUN_AS_NODE']);
// ...and Cora's own (its data dir, the splash's progress file, its dev overrides): a hosted session has no use for them,
// and a `cora start` run inside one would write its startup stages into the desktop app's splash
const SESSION_PREFIXES = ['CLAUDE_CODE_SESSION_', 'CLAUDE_CODE_MESSAGING_', 'CORA_', 'AGENT_BRAIN_'];

export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    // CORA_TOKEN stays: hooks written in the env-token form read their token from it
    if (k !== 'CORA_TOKEN' && (SESSION_VARS.has(k) || SESSION_PREFIXES.some((p) => k.startsWith(p)))) continue;
    out[k] = v;
  }
  out.FORCE_COLOR = '1';
  return out;
}

/** Where Claude Code was found: how it's started, and which install it is. */
export type ClaudeFound = { cmd: string[]; how: 'custom' | 'npm' | 'native' | 'path' | 'shim' | 'unix' | 'missing' };

/**
 * Where Claude Code is. On Windows, a real claude.exe wherever it is (arguments then reach it verbatim): the npm
 * install's, the native installer's (~/.local/bin), or one on PATH. Only an npm .cmd shim (or nothing found) goes
 * through cmd.exe, which can't pass some characters in a prompt.
 */
export function findClaude(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync, win = process.platform === 'win32'): ClaudeFound {
  // development: a stand-in for claude (a JSON array: command and arguments)
  if (env.CORA_CLAUDE_CMD) return { cmd: JSON.parse(env.CORA_CLAUDE_CMD) as string[], how: 'custom' };
  if (!win) return { cmd: ['claude'], how: 'unix' };
  const npm = env.APPDATA ? join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : '';
  if (npm && exists(npm)) return { cmd: [npm], how: 'npm' };
  const home = env.USERPROFILE ?? env.HOME;
  const native = home ? join(home, '.local', 'bin', 'claude.exe') : '';
  if (native && exists(native)) return { cmd: [native], how: 'native' };
  const dirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  const onPath = dirs.map((d) => join(d, 'claude.exe')).find(exists);
  if (onPath) return { cmd: [onPath], how: 'path' };
  const shim = dirs.some((d) => exists(join(d, 'claude.cmd')));
  return { cmd: ['cmd.exe', '/d', '/c', 'claude'], how: shim ? 'shim' : 'missing' };
}

/** How to start `claude` (see findClaude). */
export function defaultClaudeCmd(): string[] {
  return findClaude().cmd;
}

/**
 * How to start a plain shell: PowerShell 7 (pwsh) when installed, else Windows PowerShell; elsewhere the user's
 * $SHELL. Full paths, so the terminal host needn't search PATH.
 */
export function defaultShellCmd(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync, win = process.platform === 'win32'): string[] {
  if (env.CORA_SHELL_CMD) return JSON.parse(env.CORA_SHELL_CMD) as string[];
  if (!win) return [env.SHELL || '/bin/sh'];
  const dirs = (env.PATH ?? env.Path ?? '').split(win ? ';' : delimiter).filter(Boolean);
  const programFiles = [env.ProgramFiles, env.ProgramW6432].filter(Boolean).map((p) => join(p!, 'PowerShell', '7'));
  const pwsh = [...dirs, ...programFiles].map((d) => join(d, 'pwsh.exe')).find(exists);
  if (pwsh) return [pwsh, '-NoLogo'];
  const winPs = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return [exists(winPs) ? winPs : 'powershell.exe', '-NoLogo'];
}

/** A shell's environment: like Claude's (no Claude session markers leak in), minus what only Claude or Cora wants. */
export function shellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = cleanEnv(env);
  // forced colour would colour piped output too; leave colour to the programs (and the user's own setting)
  if (env.FORCE_COLOR === undefined) delete out.FORCE_COLOR;
  else out.FORCE_COLOR = env.FORCE_COLOR;
  delete out.CORA_STAGE_FILE;
  return out;
}

export class PtyManager {
  private terms = new Map<string, Term>();
  private backend: PtyBackend;
  /** Claude Code, found at each launch: one installed (or moved) since Cora started is used straight away (audit B5) */
  private get cmd(): string[] {
    return this.o.claudeCmd ?? defaultClaudeCmd();
  }
  private max: number;
  private makeScreen: ((cols: number, rows: number) => Screen) | null;
  /** shells being closed from the dashboard: forgotten once they exit, whatever their exit code */
  private closing = new Set<string>();

  /** `onExit` is for Claude terminals only (it ends their session); a shell's exit just updates the list. */
  constructor(private o: { spawn?: SpawnFn; backend?: PtyBackend; onChange?: (list: TerminalInfo[]) => void; audit?: Audit; claudeCmd?: string[]; shellCmd?: string[]; maxScrollback?: number; extraArgs?: (sessionId: string) => string[]; onExit?: (t: TerminalInfo) => void; screen?: ((cols: number, rows: number) => Screen) | null } = {}) {
    this.backend = o.backend ?? new LocalBackend(o.spawn);
    this.max = o.maxScrollback ?? 200_000;
    this.makeScreen = o.screen === undefined ? headlessScreen : o.screen;
    this.backend.onData((id, d) => this.onData(id, d));
    this.backend.onExit((id, code) => this.onExited(id, code));
    this.restore();
  }

  /** true when hosted terminals survive the server stopping (they run in the terminal host) */
  get persistent(): boolean {
    return this.backend.persistent;
  }

  list(): TerminalInfo[] {
    return [...this.terms.values()].map(({ buf: _b, sinks: _s, screen: _sc, dirty: _d, ...info }) => info);
  }

  /** The session's live Claude terminal (never one of its shells). */
  forSession(sessionId: string): TerminalInfo | undefined {
    return this.list().find((t) => t.sessionId === sessionId && t.alive && !isShell(t));
  }

  /** The session's live shells. */
  shellsFor(sessionId: string): TerminalInfo[] {
    return this.list().filter((t) => t.sessionId === sessionId && t.alive && isShell(t));
  }

  /** What a live terminal shows now, from its off-screen mirror (null when there's none). */
  screenLines(terminalId: string): string[] | null {
    const t = this.terms.get(terminalId);
    return t?.alive && t.screen ? t.screen.lines() : null;
  }

  /** Live terminals, shells included (they end, or keep running, with the rest when Cora quits). */
  liveCount(): number {
    return [...this.terms.values()].filter((t) => t.alive).length;
  }

  liveShells(): number {
    return [...this.terms.values()].filter((t) => t.alive && isShell(t)).length;
  }

  private newScreen(cols: number, rows: number): Screen | null {
    try {
      return this.makeScreen ? this.makeScreen(cols, rows) : null;
    } catch {
      return null; // status mirroring is best-effort
    }
  }

  /** Terminals that outlived the previous server (they kept running in the terminal host): pick them back up. */
  private restore(): void {
    for (const h of this.backend.restored) {
      const shell = isShell(h.meta);
      if (shell && !h.alive) continue; // a shell that ended while the server was down: nothing to pick up
      const t: Term = { terminalId: h.id, ...h.meta, alive: h.alive, exitCode: h.exitCode, buf: h.buf.slice(-this.max), sinks: new Set(), screen: null, dirty: false, status: null };
      if (h.alive && !shell) {
        // the real size arrives with the UI's next resize; the mirror catches up from there
        t.screen = this.newScreen(100, 30);
        if (t.screen && t.buf) {
          t.screen.write(t.buf);
          t.dirty = true;
        }
      }
      this.terms.set(t.terminalId, t);
      if (!h.alive) this.o.onExit?.(this.list().find((x) => x.terminalId === t.terminalId)!);
    }
    if (this.terms.size) {
      this.ensureStatusTimer();
      this.changed();
    }
  }

  /**
   * `prompt` (a new session only, checked by checkPrompt): Claude Code's positional first prompt. It goes right after
   * the session id, before the options, so a list option (--mcp-config, --allowedTools take several values) can't
   * swallow it.
   */
  /** `newId`: the new session's id (Cora's own agent chooses its own); `bare`: without the hosted sessions' extras (MCP config, prompt) */
  launch(req: { mode: TerminalMode; cwd: string; sessionId?: string; cols?: number; rows?: number; args?: string[]; prompt?: string; newId?: string; bare?: boolean; /** a shell: which kind (its id) */ shell?: string }): TerminalInfo {
    if (!['new', 'resume', 'fork', 'shell'].includes(req.mode)) throw new Error('mode must be new|resume|fork|shell');
    if ((req.mode === 'resume' || req.mode === 'fork' || req.mode === 'shell') && !req.sessionId) throw new Error('sessionId required');
    // it goes on claude's command line (`--resume <id>`): only an id, never something that reads as a flag
    if (req.sessionId != null && !isSafeId(req.sessionId)) throw new Error('not a session id');
    if (!req.cwd || !existsSync(req.cwd) || !statSync(req.cwd).isDirectory()) throw new Error(`folder not found: ${req.cwd}`);
    if (req.mode === 'shell') return this.launchShell(req.sessionId!, req.cwd, req.cols ?? 100, req.rows ?? 30, req.shell);
    if (req.prompt && req.mode !== 'new') throw new Error('a first prompt is for a new session');
    if (req.mode === 'resume') {
      const live = this.forSession(req.sessionId!);
      if (live) return live;
    }
    const newId = req.newId ?? randomUUID();
    const sessionId = req.mode === 'resume' ? req.sessionId! : newId;
    const [file, ...pre] = this.cmd;
    const cols = req.cols ?? 100;
    const rows = req.rows ?? 30;
    const t: Term = { terminalId: randomUUID(), sessionId, cwd: req.cwd, mode: req.mode, alive: true, startedAt: Date.now(), buf: '', sinks: new Set(), screen: this.newScreen(cols, rows), dirty: false, status: null };
    this.ensureStatusTimer();
    this.terms.set(t.terminalId, t);
    const args = [...pre, ...argsFor(req.mode, req.sessionId, newId), ...(req.prompt ? [req.prompt] : []), ...(req.args ?? []), ...(req.bare ? [] : (this.o.extraArgs?.(sessionId) ?? []))];
    this.backend.spawn(t.terminalId, file, args, { cwd: req.cwd, cols, rows, env: cleanEnv(process.env) }, { sessionId, cwd: req.cwd, mode: req.mode, startedAt: t.startedAt });
    this.o.audit?.log({ ts: Date.now(), sessionId, agentId: 'main', kind: 'terminal', tool: `claude ${req.mode}`, input: { cwd: req.cwd, from: req.sessionId, ...(req.prompt ? { prompt: req.prompt } : {}) }, decision: 'launch', edited: false, via: 'dashboard' });
    this.changed();
    return this.list().find((x) => x.terminalId === t.terminalId)!;
  }

  /** The shells a tab can be (found once; again on `fresh`, e.g. after installing Git or a WSL distro). */
  shells(fresh = false): Shell[] {
    if (this.o.shellCmd) return [{ id: 'default', name: 'Shell', cmd: this.o.shellCmd }];
    if (fresh || !this.found) this.found = detectShells();
    return this.found;
  }
  private found: Shell[] | null = null;

  /** A plain shell for a session, in its folder. No screen mirror: there's no Claude indicator to read off it. */
  private launchShell(sessionId: string, cwd: string, cols: number, rows: number, kind?: string): TerminalInfo {
    const sh = pickShell(this.shells(), kind);
    const [file, ...args] = sh.cmd;
    const t: Term = { terminalId: randomUUID(), sessionId, cwd, mode: 'shell', shell: sh.name, alive: true, startedAt: Date.now(), buf: '', sinks: new Set(), screen: null, dirty: false, status: null };
    this.terms.set(t.terminalId, t);
    this.backend.spawn(t.terminalId, file, args, { cwd, cols, rows, env: shellEnv(process.env) }, { sessionId, cwd, mode: 'shell', startedAt: t.startedAt, shell: sh.name });
    this.o.audit?.log({ ts: Date.now(), sessionId, agentId: 'main', kind: 'terminal', tool: 'shell', input: { cwd, file }, decision: 'launch', edited: false, via: 'dashboard' });
    this.changed();
    return this.list().find((x) => x.terminalId === t.terminalId)!;
  }

  /**
   * Close a shell from the dashboard: end its process (and whatever runs in it), then forget it. One that already
   * exited is just forgotten. Claude terminals have their own way out (`end`).
   */
  closeShell(terminalId: string): boolean {
    const t = this.terms.get(terminalId);
    if (!t || !isShell(t)) return false;
    if (!t.alive) {
      this.terms.delete(terminalId);
      this.changed();
      return true;
    }
    this.closing.add(terminalId);
    this.backend.kill(terminalId);
    this.o.audit?.log({ ts: Date.now(), sessionId: t.sessionId, agentId: 'main', kind: 'terminal', tool: 'shell', input: { cwd: t.cwd }, decision: 'close', edited: false, via: 'dashboard' });
    return true;
  }

  private onData(id: string, d: string): void {
    const t = this.terms.get(id);
    if (!t) return;
    t.buf = (t.buf + d).slice(-this.max);
    if (t.screen) {
      t.screen.write(d);
      t.dirty = true;
    }
    for (const s of t.sinks) s.data(d);
  }

  private onExited(id: string, exitCode: number): void {
    const t = this.terms.get(id);
    if (!t || !t.alive) return;
    t.alive = false;
    t.exitCode = exitCode;
    t.status = null;
    t.screen?.dispose();
    t.screen = null;
    for (const s of t.sinks) s.exit(exitCode);
    if (isShell(t)) {
      // closed from the dashboard, or `exit` typed: the tab goes. A shell that failed stays, to show why.
      if (this.closing.delete(id) || exitCode === 0) this.terms.delete(id);
      this.changed();
      return;
    }
    const info = this.list().find((x) => x.terminalId === t.terminalId)!;
    this.forgetOld();
    this.changed();
    this.o.onExit?.(info);
  }

  /** Ended Claude terminals keep their scrollback (resume again, what it last said): the newest few, not every one since Cora started. */
  private forgetOld(keep = 12): void {
    const ended = [...this.terms.values()].filter((x) => !x.alive && !isShell(x));
    for (const x of ended.slice(0, Math.max(0, ended.length - keep))) this.terms.delete(x.terminalId);
  }

  /** Replays scrollback, then streams. Returns a detach function. */
  attach(terminalId: string, sink: Sink): () => void {
    const t = this.terms.get(terminalId);
    if (!t) throw new Error('unknown terminal');
    if (t.buf) sink.data(t.buf);
    if (!t.alive) sink.exit(t.exitCode ?? 0);
    t.sinks.add(sink);
    return () => t.sinks.delete(sink);
  }

  write(terminalId: string, data: string): boolean {
    const t = this.terms.get(terminalId);
    if (!t?.alive) return false;
    this.backend.write(terminalId, data);
    return true;
  }

  /**
   * Quit a hosted session the way you would by hand: Ctrl+C twice (the first interrupts a turn, the second exits).
   * If it's still up a few seconds later, its terminal is stopped.
   */
  end(terminalId: string): boolean {
    const t = this.terms.get(terminalId);
    if (!t?.alive) return false;
    this.backend.write(terminalId, '\x03');
    setTimeout(() => this.write(terminalId, '\x03'), 250);
    setTimeout(() => this.kill(terminalId), 4000).unref?.();
    this.o.audit?.log({ ts: Date.now(), sessionId: t.sessionId, agentId: 'main', kind: 'terminal', tool: 'claude end', input: {}, decision: 'end', edited: false, via: 'dashboard' });
    return true;
  }

  /** End a terminal's process (its exit is reported like any other). */
  kill(terminalId: string): boolean {
    const t = this.terms.get(terminalId);
    if (!t?.alive) return false;
    this.backend.kill(terminalId);
    return true;
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const t = this.terms.get(terminalId);
    if (!t?.alive || cols <= 1 || rows <= 1) return;
    this.backend.resize(terminalId, Math.floor(cols), Math.floor(rows));
    t.screen?.resize(Math.floor(cols), Math.floor(rows));
  }

  private statusTimer?: NodeJS.Timeout;
  private ensureStatusTimer() {
    if (this.statusTimer) return;
    this.statusTimer = setInterval(() => this.scanStatus(), 400);
    this.statusTimer.unref?.();
  }

  /** Read Claude Code's working indicator off each changed screen; publish when it changes. */
  scanStatus(): void {
    let changed = false;
    for (const t of this.terms.values()) {
      if (!t.alive || !t.screen || !t.dirty) continue;
      t.dirty = false;
      const s = statusLine(t.screen.lines());
      if (s !== t.status) {
        t.status = s;
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  /** Server stopping. With the terminal host, terminals keep running unless `endTerminals`; in-process ones always end. */
  async disposeAll(endTerminals = true): Promise<void> {
    if (this.statusTimer) clearInterval(this.statusTimer);
    for (const t of this.terms.values()) t.screen?.dispose();
    await this.backend.close(endTerminals);
  }

  private changed() {
    this.o.onChange?.(this.list());
  }
}
