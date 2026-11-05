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
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ disableAllHooks: true, crossSessionInbound: 'refuse' }, null, 2) + '\n');
  writeFileSync(join(dir, 'system-prompt.md'), SYSTEM);
  return [
    '-p', '--resume', sessionId, '--fork-session', '--no-session-persistence', '--safe-mode',
    '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--settings', join(dir, 'settings.json'),
    '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Agent',
    '--append-system-prompt-file', join(dir, 'system-prompt.md'),
    ...(model ? ['--model', model] : []),
  ];
}

/** What a copy's run read and wrote (its result line's usage): fresh input, cache reads, cache writes, output. */
export type CopyUsage = { in: number; cacheRead: number; cacheWrite: number; out: number };
/** What a run cost, when it said (a failed run costs too). */
type Spent = { costUsd?: number; usage?: CopyUsage };
export type CopyAnswer = ({ ok: true; text: string } & Spent) | ({ ok: false; error: string } & Spent);
/**
 * One side question's cost, for the audit log: each copy pays its session's whole context, and leaves no transcript
 * to count it from (--no-session-persistence), so this is the only record of it.
 */
export type CopyCost = { sessionId: string; model?: string; ok: boolean; ms: number } & Spent;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** The result line's usage, when it has one. */
export const usageOf = (u: any): CopyUsage | undefined =>
  u && typeof u === 'object' ? { in: num(u.input_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), out: num(u.output_tokens) } : undefined;

/** Pull the copy's answer out of its stream-json lines: every text it wrote (not only the last), and the run's cost. */
export class CopyReader {
  private buf = '';
  private texts: string[] = [];
  private size = 0;
  result: ({ error?: string } & Spent) | null = null;

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
      const usage = usageOf(x.usage);
      this.result = { costUsd: typeof x.total_cost_usd === 'number' ? x.total_cost_usd : undefined, ...(usage ? { usage } : {}), ...(x.is_error ? { error: String(x.result ?? x.subtype ?? 'it failed') } : {}) };
    }
  }

  answer(): CopyAnswer {
    const text = this.texts.join('\n\n').slice(0, MAX_ANSWER);
    const spent: Spent = { ...(this.result?.costUsd !== undefined ? { costUsd: this.result.costUsd } : {}), ...(this.result?.usage ? { usage: this.result.usage } : {}) };
    if (this.result?.error) return { ok: false, error: this.result.error.slice(0, 400), ...spent };
    if (!text) return { ok: false, error: this.result ? 'it gave no answer' : 'it stopped without answering', ...spent };
    return { ok: true, text, ...spent };
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
      else if (!a.ok && code !== 0 && err.trim()) resolve({ ...a, error: err.trim().split('\n').pop()!.slice(0, 400) });
      else resolve(a);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(o.input);
  });

/** At most two side questions at a time (each is a full Claude Code run). */
export class Copies {
  private running = 0;
  readonly dir: string;

  /** `cost`: told what each run cost (the audit log keeps it) */
  constructor(private o: { dir: string; claudeCmd: () => string[]; run?: CopyRun; timeoutMs?: number; max?: number; cost?: (c: CopyCost) => void; now?: () => number }) {
    this.dir = o.dir;
  }

  async ask(p: { sessionId: string; cwd: string; question: string; model?: string }): Promise<CopyAnswer> {
    if (this.running >= (this.o.max ?? 2)) return { ok: false, error: 'two side questions are already running; ask again when one has answered' };
    this.running++;
    const now = this.o.now ?? Date.now;
    const t0 = now();
    try {
      const cmd = [...this.o.claudeCmd(), ...copyArgs(this.dir, p.sessionId, p.model)];
      const a = await (this.o.run ?? runCopy)(cmd, { cwd: p.cwd, input: p.question, timeoutMs: this.o.timeoutMs ?? COPY_TIMEOUT_MS });
      try {
        this.o.cost?.({ sessionId: p.sessionId, ...(p.model ? { model: p.model } : {}), ok: a.ok, ms: now() - t0, ...(a.costUsd !== undefined ? { costUsd: a.costUsd } : {}), ...(a.usage ? { usage: a.usage } : {}) });
      } catch {
        /* the record never costs the answer */
      }
      return a;
    } finally {
      this.running--;
    }
  }
}
