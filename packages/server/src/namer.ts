import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_ICONS, titleCase, type BrainEvent, type SessionInfo, type Settings } from '@cora/shared';
import { cleanEnv, defaultClaudeCmd } from './pty';

/**
 * Optional auto-names: after a session's first prompt, a quick `claude -p --model haiku` through the user's own
 * Claude Code login suggests a 3–5 word name. That run happens in its own folder (`<dataDir>/namer`), which the
 * pipeline ignores, so it never shows up as a session of its own.
 */

const MAX_PROMPT = 1500;
const MAX_NAME = 40;
const TIMEOUT_MS = 45_000;
/** Only prompts this fresh start an auto-name (the startup backfill replays old ones). */
const FRESH_MS = 5 * 60_000;
const MAX_QUEUE = 20;

const SYSTEM = [
  "You name coding sessions and pick an icon for each. For the session that begins with the user's message, reply with one line:",
  'a short name (3 to 5 words) in Title Case, then " | ", then one icon name from the list below, written exactly as it is there.',
  'No quotes, no markdown, no punctuation at the end of the name, no explanation.',
  'The icon depicts what the work is about, as specifically as you can (a rocket for a release, a gauge for a load test, a key for a login fix):',
  "not a generic one like Code, Terminal or Bug when a more specific one fits, and not one the user's other sessions already use when another fits as well.",
  'Examples: Fix Hooks Sink | Webhook; Jira 2.9 Prod Audit | ClipboardCheck; Add Dark Mode Toggle | Moon.',
  `Icons: ${SESSION_ICONS.join(' ')}`,
].join(' ');

export const namerDir = (dataDir: string) => join(dataDir, 'namer');

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Is this cwd the namer's own folder (hook payloads, transcript lines)? */
export const isNamerCwd = (cwd: unknown, dir: string): boolean => typeof cwd === 'string' && !!cwd && norm(cwd) === norm(dir);

/** Claude Code's project folder name for a cwd (every non-alphanumeric becomes '-'). */
export const projectSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/** Is this ~/.claude/projects/<slug> the namer folder's? */
export const isNamerSlug = (slug: string, dir: string) => slug.toLowerCase() === projectSlug(dir).toLowerCase();

/** What the model reads: the instruction is the system prompt; this is the message (trimmed). */
export function namePrompt(text: string, inUse: string[] = []): string {
  let t = text.trim();
  if (t.length > MAX_PROMPT) t = t.slice(0, MAX_PROMPT).trimEnd() + '…';
  const used = inUse.length ? `\n\nIcons the user's other open sessions use: ${[...new Set(inUse)].join(', ')}` : '';
  return `Name the session that begins with this message:\n\n<message>\n${t}\n</message>${used}`;
}

const ICON_BY_KEY = new Map(SESSION_ICONS.map((n) => [n.toLowerCase(), n]));
/**
 * The model's reply as a name (Title Case) and an icon: "Fix Hooks Sink | Webhook". The icon is one of the list
 * (any case, dashes or spaces: "key-round" is KeyRound), else none; no "|" at all: just a name.
 */
export function parseNamed(out: string): { name: string; icon: string | null } | null {
  const line = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const bar = line.lastIndexOf('|');
  const name = sanitizeName(bar >= 0 ? line.slice(0, bar) : line);
  if (!name) return null;
  const key = bar >= 0 ? line.slice(bar + 1).replace(/[^a-z0-9]/gi, '').toLowerCase() : '';
  return { name: titleCase(name), icon: (key && ICON_BY_KEY.get(key)) || null };
}

/** A clean name from the model's reply, or null for junk (refusals, rambling, nothing). */
export function sanitizeName(out: string): string | null {
  const line = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  let s = line
    .replace(/\*\*|__|[`*]/g, '')
    .replace(/^(#+|[-•>])\s*/, '')
    .replace(/^(session\s+)?(name|title)\s*:\s*/i, '')
    .trim()
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '')
    .replace(/[\s.!?,;:…]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || /^(i|i'm|i am|sorry|as an ai|here's|here is|sure|certainly)\b/i.test(s)) return null;
  const words = s.split(' ');
  if (words.length > 8) return null;
  if (s.length > MAX_NAME) {
    // whole words that fit
    let cut = '';
    for (const w of words) {
      const next = cut ? `${cut} ${w}` : w;
      if (next.length > MAX_NAME) break;
      cut = next;
    }
    if (cut.split(' ').length < 2) return null;
    s = cut.replace(/[\s.!?,;:…-]+$/, '');
  }
  return /[a-z0-9]/i.test(s) ? s : null;
}

/** Should this stored event start an auto-name? (`earlier`: the session already had a prompt before it.) */
export function wantsAutoName(e: BrainEvent, s: SessionInfo | undefined, settings: Pick<Settings, 'autoName'>, earlier: boolean, now = Date.now()): boolean {
  if (!settings.autoName || !s || s.alias || s.autoName) return false;
  if (e.kind !== 'prompt' || e.agentId !== 'main' || earlier) return false;
  if (now - e.ts > FRESH_MS) return false;
  return (e.text ?? '').trim().length >= 3;
}

/** Environment for the namer's `claude`: no session markers (see cleanEnv), and nothing of Cora's (e.g. CORA_TOKEN for hooks). */
export function namerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = cleanEnv(env);
  delete out.FORCE_COLOR;
  for (const k of Object.keys(out)) if (/^(CORA|AGENT_BRAIN)_/i.test(k)) delete out[k];
  return out;
}

/**
 * The CLI arguments: print mode with Haiku, no tools, no MCP servers, no skills, a system prompt of our own, and
 * nothing that reports back: no transcript saved, hooks off twice over (safe mode skips the user's hooks and
 * plugins; the settings file sets disableAllHooks).
 */
export function namerArgs(dir: string): string[] {
  return [
    '-p', '--model', 'haiku', '--output-format', 'text', '--tools', '', '--no-session-persistence', '--safe-mode',
    '--strict-mcp-config', '--disable-slash-commands', '--settings', join(dir, 'settings.json'), '--system-prompt-file', join(dir, 'system-prompt.md'),
  ];
}

export type RunResult = { code: number | null; stdout: string; timedOut: boolean };
export type RunFn = (cmd: string[], o: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number; maxOut?: number }) => Promise<RunResult>;

/** Run a command with stdin, collecting stdout; killed (with its children) on timeout. */
export const runCommand: RunFn = (cmd, o) =>
  new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;
    const child = spawn(cmd[0], cmd.slice(1), { cwd: o.cwd, env: o.env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      else child.kill('SIGKILL');
    }, o.timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < (o.maxOut ?? 4000)) stdout += d.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(o.input);
  });

/** `iconOnly`: a session named before icons were picked: only its icon is wanted (its name stays). */
type Job = { sessionId: string; text: string; iconOnly?: boolean; done(name: string | null): void };

/** Asks for names one at a time, off the pipeline's path. */
export class Namer {
  readonly dir: string;
  private queue: Job[] = [];
  private busy = false;
  private tried = new Set<string>();
  private run: RunFn;

  constructor(private o: { dataDir: string; onName(sessionId: string, name: string, icon: string | null): void; /** an icon for a session named before icons were picked */ onIcon?(sessionId: string, icon: string): void; /** icons the open sessions use (it picks another when one fits as well) */ iconsInUse?: () => string[]; run?: RunFn; claudeCmd?: string[]; timeoutMs?: number }) {
    this.dir = namerDir(o.dataDir);
    this.run = o.run ?? runCommand;
  }

  /** Automatic: at most once per session (while this server runs); never waits. */
  auto(sessionId: string, text: string): void {
    if (this.tried.has(sessionId) || this.queue.length >= MAX_QUEUE) return;
    this.tried.add(sessionId);
    void this.enqueue(sessionId, text);
  }

  /** An icon for a session named before icons were picked (its name and first prompt say what it's about); never waits. */
  iconFor(sessionId: string, text: string): void {
    void new Promise<string | null>((done) => {
      this.queue.push({ sessionId, text, iconOnly: true, done });
      void this.pump();
    });
  }

  /** On request ("Suggest a name"): resolves with the name, or null when none came back. */
  suggest(sessionId: string, text: string): Promise<string | null> {
    this.tried.add(sessionId);
    return this.enqueue(sessionId, text);
  }

  private enqueue(sessionId: string, text: string): Promise<string | null> {
    return new Promise((done) => {
      this.queue.push({ sessionId, text, done });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        let name: string | null = null;
        try {
          const got = await this.ask(job.text);
          name = got?.name ?? null;
          if (got && job.iconOnly) {
            if (got.icon) this.o.onIcon?.(job.sessionId, got.icon);
          } else if (got) this.o.onName(job.sessionId, got.name, got.icon);
        } catch (e) {
          console.error('[cora] naming failed', (e as Error).message);
        }
        job.done(name);
      }
    } finally {
      this.busy = false;
    }
  }

  private async ask(text: string): Promise<{ name: string; icon: string | null } | null> {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'settings.json'), JSON.stringify({ disableAllHooks: true, crossSessionInbound: 'refuse' }, null, 2) + '\n');
    writeFileSync(join(this.dir, 'system-prompt.md'), SYSTEM);
    const cmd = [...(this.o.claudeCmd ?? defaultClaudeCmd()), ...namerArgs(this.dir)];
    const r = await this.run(cmd, { cwd: this.dir, env: namerEnv(process.env), input: namePrompt(text, this.o.iconsInUse?.() ?? []), timeoutMs: this.o.timeoutMs ?? TIMEOUT_MS });
    if (r.timedOut || r.code !== 0) return null;
    return parseNamed(r.stdout);
  }
}
