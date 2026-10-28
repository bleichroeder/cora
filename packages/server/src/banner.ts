import { randomBytes } from 'node:crypto';
import type { SessionInfo } from '@cora/shared';

/**
 * Cora's Slack banner: the GIF on top of a message Cora sends
 * for you. The desktop app makes it (its banner page recorded out of sight); this asks it for one and waits a while.
 * No desktop app, or no answer in time: none, and the message goes without it.
 */
type Sock = { send(d: string): void; close(): void; readyState: number; on(ev: string, fn: (...a: any[]) => void): void };

const WAIT_MS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;

export class Banners {
  private desktop: Sock | null = null;
  private waiting = new Map<string, (gif: Uint8Array | null) => void>();
  constructor(private waitMs = WAIT_MS) {}

  get available(): boolean {
    return !!this.desktop && this.desktop.readyState === 1;
  }

  /** The desktop app's link (one at a time: a new one replaces it). */
  attachDesktop(sock: Sock): void {
    this.desktop?.close();
    this.desktop = sock;
    sock.on('message', (raw: unknown) => {
      try {
        const m = JSON.parse(String(raw)) as { t?: string; id?: string; data?: string };
        if (m.t !== 'gif' || typeof m.id !== 'string') return;
        const done = this.waiting.get(m.id);
        if (!done) return;
        const gif = typeof m.data === 'string' ? Buffer.from(m.data, 'base64') : null;
        done(gif && gif.length > 6 && gif.length <= MAX_BYTES && gif.subarray(0, 6).toString('latin1') === 'GIF89a' ? new Uint8Array(gif) : null);
      } catch {
        /* not one of ours */
      }
    });
    sock.on('close', () => {
      if (this.desktop !== sock) return;
      this.desktop = null;
      for (const done of [...this.waiting.values()]) done(null);
    });
  }

  /** A banner saying these words (see bannerWords), or null. */
  render(q: Record<string, string>): Promise<Uint8Array | null> {
    if (!this.available) return Promise.resolve(null);
    const id = randomBytes(6).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), this.waitMs);
      const done = (gif: Uint8Array | null) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(gif);
      };
      this.waiting.set(id, done);
      this.desktop!.send(JSON.stringify({ t: 'render', id, q }));
    });
  }
}

/**
 * What the banner says, and only what its readers should see (it goes to whoever the message goes to): whose
 * assistant; the session's ticket (key and title), else the message's own first line (they're reading it anyway); under
 * it, a name you gave the session and the repo's folder. Never a name made from a session's prompts (Claude Code's
 * title, Cora's suggestion: they can say anything), and nothing of Cora's own folders (its orchestrator's).
 */
export function bannerWords(o: { name: string; session: SessionInfo | null | undefined; text?: string; privateDir?: string }): Record<string, string> {
  const s = o.session;
  const q: Record<string, string> = {};
  if (o.name) q.name = o.name;
  const t = s?.ticket;
  const line = t?.key ? (t.summary ? `${t.key} · ${t.summary}` : t.key) : headline(o.text ?? '');
  if (line) q.line = line;
  if (!s) return q;
  const mine = !!o.privateDir && !!s.cwd && norm(s.cwd).startsWith(norm(o.privateDir));
  const alias = s.alias?.trim() && !(t?.key && s.alias.trim().startsWith(t.key)) ? s.alias.trim() : '';
  const folder = !mine && s.cwd ? (s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '') : '';
  const from = [mine ? '' : alias, folder].filter(Boolean).join(' · ');
  if (from) q.from = from;
  return q;
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/';

/** A message's first line as a plain headline: no markup, links as their words, no :emoji: codes, cut short. */
export function headline(text: string): string {
  const first = text.split('\n').map((l) => l.trim()).find((l) => /[\p{L}\p{N}]/u.test(l.replace(/:[\w+-]+:/g, ''))) ?? '';
  const plain = first
    .replace(/<[^|>]+\|([^>]+)>/g, '$1')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[@#!][^>]*>/g, '')
    .replace(/:[\w+-]+:/g, '')
    .replace(/^[#>\-*•\s]+/, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 80 ? `${plain.slice(0, 79).trimEnd()}…` : plain;
}
