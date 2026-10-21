import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { namerEnv } from '../namer';

/**
 * Side questions: Cora asks a copy of a session (Claude Code resumes it as a fork, in print mode) instead of the
 * session itself. The copy knows everything the session does and may read files; it changes nothing, its answer is
 * Cora's alone, and nothing of it is kept: no transcript (so no new session in Cora), hooks off twice over (safe mode
 * and the settings file), no MCP servers. The session itself is never interrupted.
 */

const SYSTEM = [
  "Cora, the user's assistant, is asking you a side question about this conversation and the work in it.",
  'Answer from what you know and what you can read (Read, Grep, Glob). Change nothing, start nothing.',
  'Be direct and specific: file paths, names, numbers. Say plainly when you don’t know.',
].join(' ');

export const COPY_TIMEOUT_MS = 4 * 60_000;
const MAX_ANSWER = 16_000;

export function copyArgs(dir: string, sessionId: string, model?: string): string[] {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ disableAllHooks: true }, null, 2) + '\n');
  writeFileSync(join(dir, 'system-prompt.md'), SYSTEM);
  return [
    '-p', '--resume', sessionId, '--fork-session', '--no-session-persistence', '--safe-mode',
    '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--settings', join(dir, 'settings.json'),
    '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Agent',
    '--append-system-prompt-file', join(dir, 'system-prompt.md'),
    ...(model ? ['--model', model] : []),
  ];
}

export type CopyAnswer = { ok: true; text: string; costUsd?: number } | { ok: false; error: string };

/** Pull the copy's answer out of its stream-json lines: every text it wrote (not only the last), and the run's cost. */
export class CopyReader {
  private buf = '';
  private texts: string[] = [];
  private size = 0;
  result: { error?: string; costUsd?: number } | null = null;

  push(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.line(line);
    }
  }

  end(): void {
    if (this.buf.trim()) this.line(this.buf.trim());
    this.buf = '';
  }

  private line(l: string): void {
    let x: any;
    try {
      x = JSON.parse(l);
    } catch {
      return;
    }
    if (x?.type === 'assistant' && Array.isArray(x.message?.content)) {
      for (const b of x.message.content) {
        if (b?.type !== 'text' || typeof b.text !== 'string' || !b.text.trim() || this.size >= MAX_ANSWER) continue;
        this.texts.push(b.text.trim());
        this.size += b.text.length;
      }
    } else if (x?.type === 'result') {
      this.result = { costUsd: typeof x.total_cost_usd === 'number' ? x.total_cost_usd : undefined, ...(x.is_error ? { error: String(x.result ?? x.subtype ?? 'it failed') } : {}) };
    }
  }

  answer(): CopyAnswer {
    const text = this.texts.join('\n\n').slice(0, MAX_ANSWER);
    if (this.result?.error) return { ok: false, error: this.result.error.slice(0, 400) };
    if (!text) return { ok: false, error: this.result ? 'it gave no answer' : 'it stopped without answering' };
    return { ok: true, text, ...(this.result?.costUsd !== undefined ? { costUsd: this.result.costUsd } : {}) };
  }
}

export type CopyRun = (cmd: string[], o: { cwd: string; input: string; timeoutMs: number }) => Promise<CopyAnswer>;

/** Run `claude` for a side question; killed (with its children) on timeout. */
export const runCopy: CopyRun = (cmd, o) =>
  new Promise((resolve) => {
    const reader = new CopyReader();
    let timedOut = false;
    let err = '';
    const child = spawn(cmd[0], cmd.slice(1), { cwd: o.cwd, env: namerEnv(process.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      else child.kill('SIGKILL');
    }, o.timeoutMs);
    child.stdout.on('data', (d: Buffer) => reader.push(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 2000) err += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      reader.end();
      const a = reader.answer();
      if (timedOut) resolve(a.ok ? a : { ok: false, error: `no answer within ${Math.round(o.timeoutMs / 60_000)} minutes` });
      else if (!a.ok && code !== 0 && err.trim()) resolve({ ok: false, error: err.trim().split('\n').pop()!.slice(0, 400) });
      else resolve(a);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(o.input);
  });

/** At most two side questions at a time (each is a full Claude Code run). */
export class Copies {
  private running = 0;
  readonly dir: string;

  constructor(private o: { dir: string; claudeCmd: () => string[]; run?: CopyRun; timeoutMs?: number; max?: number }) {
    this.dir = o.dir;
  }

  async ask(p: { sessionId: string; cwd: string; question: string; model?: string }): Promise<CopyAnswer> {
    if (this.running >= (this.o.max ?? 2)) return { ok: false, error: 'two side questions are already running; ask again when one has answered' };
    this.running++;
    try {
      const cmd = [...this.o.claudeCmd(), ...copyArgs(this.dir, p.sessionId, p.model)];
      return await (this.o.run ?? runCopy)(cmd, { cwd: p.cwd, input: p.question, timeoutMs: this.o.timeoutMs ?? COPY_TIMEOUT_MS });
    } finally {
      this.running--;
    }
  }
}
