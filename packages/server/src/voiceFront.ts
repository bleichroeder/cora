import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultClaudeCmd } from './pty';
import { namerEnv } from './namer';

/**
 * The voice front: you speak, and within about a second Cora says one line that shows it heard you ("Checking the
 * webapi pipeline on dev now.") while the real answer is worked out. One Haiku kept running (`claude -p` reading
 * stream-json, so it starts once), thinking off (that alone cost 1.5 to 3 s), with no tools, hooks or saved
 * transcript. It only ever says what's about to happen, never facts: it doesn't know them.
 */

const SYSTEM = `You are the voice of Cora, a desktop assistant for a software engineer's Claude Code sessions. The user just spoke. Cora's main agent (or the session they spoke to) is already working on the real answer, which they'll hear in a moment. You fill the wait, but only when there is a wait worth filling.

First decide: does answering need real work? Real work: checking or looking something up (sessions, pipelines, deploys, code, new Slack messages, Jira, email, the web), running or changing something, or thinking through something substantial.
- No (a greeting, a mic test like "can you hear me", thanks, small talk, a quick question with a short answer): reply with exactly SKIP. The real answer comes fast and saying something first would only repeat it.
- Yes: one short spoken sentence that shows you heard what they asked and says what will be looked at, e.g. "Okay, I'll check where the webapi pipeline is." or "Sure, looking at what canvas is up to." or "One sec, checking your Slack."

Rules for that sentence:
- Never state facts, results, numbers or opinions: you don't know them.
- Never say something is done or happening for certain ("Rolling it out now"): say what will be looked at or tried ("Okay, I'll look at bumping that on dev").
- Under 14 words. Plain words, no markdown, no quotes, no emoji.
- Reply with the sentence (or SKIP) only.`;

/** A line that takes longer than this is too late to be worth saying. */
export const FRONT_TIMEOUT_MS = 2500;
/** Start again after this many lines, so its conversation stays small (and fast). */
const RECYCLE_AFTER = 25;

export type FrontContext = { looking?: string; toCora: boolean; working?: string[] };

/** What Haiku gets: where you are, what's going on, what you said. */
export function frontPrompt(text: string, c: FrontContext): string {
  const lines = [
    c.toCora ? 'They spoke to Cora (the assistant).' : `They spoke to a Claude Code session${c.looking ? ` named "${c.looking}"` : ''}.`,
    ...(c.toCora && c.looking ? [`On screen: ${c.looking}.`] : []),
    ...(c.working?.length ? [`Sessions working now: ${c.working.slice(0, 6).join(', ')}.`] : []),
    `They said: ${text.slice(0, 600)}`,
  ];
  return lines.join('\n');
}

/** Haiku's reply as a spoken line: one line, no markup, not too long (null when there's nothing usable). */
export function cleanLine(s: string): string | null {
  const t = s.replace(/[*_`#>]/g, '').replace(/^["'\s]+|["'\s]+$/g, '').split('\n').find((l) => l.trim())?.trim() ?? '';
  if (!t || t.length > 160 || /^skip\b/i.test(t)) return null;
  return t;
}

/** One line asked for: its words so far; `done` is null once it was answered, timed out or replaced. */
type Turn = { text: string; done: ((line: string | null) => void) | null; timer?: NodeJS.Timeout };

export class VoiceFront {
  readonly dir: string;
  private child: ChildProcess | null = null;
  private buf = '';
  private turns = 0;
  /** lines asked for, in order (Haiku answers them in order) */
  private turnsOut: Turn[] = [];

  constructor(private o: { dataDir: string; claudeCmd?: string[]; spawnFn?: typeof spawn; log?: (m: string) => void }) {
    this.dir = join(o.dataDir, 'namer', 'front');
  }

  /** Start Haiku ahead of the first line (the start-up costs about a second). */
  warm(): void {
    if (!this.child) this.start();
  }

  /** One spoken line for what you said, or null (too slow, or it failed). A newer request replaces an older one. */
  line(text: string, c: FrontContext): Promise<string | null> {
    for (const t of this.turnsOut) this.finish(t, null);
    if (!this.child || this.turns >= RECYCLE_AFTER || this.turnsOut.length > 2) this.restart();
    return new Promise((done) => {
      const t: Turn = { text: '', done };
      t.timer = setTimeout(() => this.finish(t, null), FRONT_TIMEOUT_MS);
      this.turnsOut.push(t);
      this.turns++;
      const msg = { type: 'user', message: { role: 'user', content: frontPrompt(text, c) } };
      this.child?.stdin?.write(JSON.stringify(msg) + '\n');
    });
  }

  stop(): void {
    this.kill();
  }

  private finish(t: Turn, line: string | null): void {
    clearTimeout(t.timer);
    const done = t.done;
    t.done = null;
    done?.(line);
  }

  private restart(): void {
    this.kill();
    this.start();
  }

  private kill(): void {
    const c = this.child;
    this.child = null;
    for (const t of this.turnsOut.splice(0)) this.finish(t, null);
    if (!c) return;
    c.stdin?.end();
    if (process.platform === 'win32' && c.pid) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    else c.kill();
  }

  private start(): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'settings.json'), JSON.stringify({ disableAllHooks: true, alwaysThinkingEnabled: false, crossSessionInbound: 'refuse' }, null, 2) + '\n');
    writeFileSync(join(this.dir, 'system-prompt.md'), SYSTEM);
    const cmd = [
      ...(this.o.claudeCmd ?? defaultClaudeCmd()),
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
      '--tools', '', '--no-session-persistence', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands',
      '--settings', join(this.dir, 'settings.json'), '--system-prompt-file', join(this.dir, 'system-prompt.md'),
    ];
    this.turns = 0;
    this.buf = '';
    const child = (this.o.spawnFn ?? spawn)(cmd[0], cmd.slice(1), { cwd: this.dir, env: { ...namerEnv(process.env), MAX_THINKING_TOKENS: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', (d: Buffer) => this.data(d.toString('utf8')));
    child.on('error', (e) => this.o.log?.(`voice front: ${e.message}`));
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      for (const t of this.turnsOut.splice(0)) this.finish(t, null);
    });
  }

  private data(s: string): void {
    this.buf += s;
    for (let i = this.buf.indexOf('\n'); i >= 0; i = this.buf.indexOf('\n')) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      let j: any;
      try {
        j = JSON.parse(raw);
      } catch {
        continue;
      }
      // the whole message (thinking is off, so it's one short text block)
      const t = this.turnsOut[0];
      if (!t) continue;
      if (j.type === 'assistant') for (const b of j.message?.content ?? []) if (b?.type === 'text') t.text += b.text;
      if (j.type === 'result') {
        this.turnsOut.shift();
        this.finish(t, cleanLine(t.text || String(j.result ?? '')));
      }
    }
  }
}
