import { randomBytes } from 'node:crypto';
import { sessionColorOf, type SessionInfo } from '@cora/shared';

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
  private waiting = new Map<string, (gif: Uint8Array | null, why?: string) => void>();
  /** slides being drawn (a debrief video's): each picture as it comes, then done or why not */
  private drawing = new Map<string, { pics: Array<Uint8Array | Uint8Array[]>; done(e?: string): void }>();
  constructor(private waitMs = WAIT_MS, private log: (line: string) => void = (l) => console.error(`[cora] ${l}`)) {}

  get available(): boolean {
    return !!this.desktop && this.desktop.readyState === 1;
  }

  /** The desktop app's link (one at a time: a new one replaces it). */
  attachDesktop(sock: Sock): void {
    this.desktop?.close();
    this.desktop = sock;
    sock.on('message', (raw: unknown) => {
      try {
        const m = JSON.parse(String(raw)) as { t?: string; id?: string; data?: string; i?: number; k?: number; error?: string };
        if (typeof m.id !== 'string') return;
        const d = this.drawing.get(m.id);
        if (d && m.t === 'slide' && typeof m.data === 'string' && typeof m.i === 'number') {
          const pic = new Uint8Array(Buffer.from(m.data, 'base64'));
          // a moving slide's frames, in order
          if (typeof m.k === 'number') ((d.pics[m.i] ??= []) as Uint8Array[])[m.k] = pic;
          else d.pics[m.i] = pic;
        }
        if (d && m.t === 'slides-done') d.done(m.error);
        if (m.t !== 'gif') return;
        const done = this.waiting.get(m.id);
        if (!done) return;
        const gif = typeof m.data === 'string' ? Buffer.from(m.data, 'base64') : null;
        if (!gif) return done(null, `the desktop app couldn't draw it${typeof m.error === 'string' ? ` (${m.error.slice(0, 120)})` : ''}`);
        const ok = gif.length > 6 && gif.length <= MAX_BYTES && gif.subarray(0, 6).toString('latin1') === 'GIF89a';
        done(ok ? new Uint8Array(gif) : null, ok ? undefined : 'what came back was not a GIF');
      } catch {
        /* not one of ours */
      }
    });
    sock.on('close', () => {
      if (this.desktop !== sock) return;
      this.desktop = null;
      for (const done of [...this.waiting.values()]) done(null, 'the desktop app went away');
      for (const d of [...this.drawing.values()]) d.done('the desktop app went away');
    });
  }

  /**
   * A debrief video's slides as pictures (1920×1080 PNGs), drawn by the desktop app out of sight and fitted to the
   * slide. Throws when it can't (no desktop app, too slow, a slide it couldn't draw).
   */
  slides(slides: unknown[], color?: string): Promise<Array<Uint8Array | Uint8Array[]>> {
    if (!this.available) return Promise.reject(new Error("the slides are drawn by Cora's desktop app, which isn't running"));
    const id = randomBytes(6).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => d.done('drawing the slides took too long'), 20_000 + slides.length * 5_000);
      const d = {
        pics: [] as Array<Uint8Array | Uint8Array[]>,
        done: (e?: string) => {
          clearTimeout(timer);
          this.drawing.delete(id);
          if (e) reject(new Error(e));
          else if (d.pics.length !== slides.length || d.pics.some((p) => !p)) reject(new Error("the slides weren't all drawn"));
          else resolve(d.pics);
        },
      };
      this.drawing.set(id, d);
      this.desktop!.send(JSON.stringify({ t: 'slides', id, slides, ...(color ? { color } : {}) }));
    });
  }

  /**
   * A banner saying these words (see bannerWords), or null: the message then goes without it. A banner not made is
   * said in the log, with why; one the desktop app failed to draw (not one it was never asked for) is tried once more.
   */
  async render(q: Record<string, string>): Promise<Uint8Array | null> {
    const first = await this.once(q);
    if (first.gif) return first.gif;
    if (!this.available) {
      this.log(`Slack banner dropped: ${first.why}`);
      return null;
    }
    this.log(`Slack banner failed (${first.why}): trying once more`);
    const again = await this.once(q);
    if (!again.gif) this.log(`Slack banner dropped: ${again.why} (after a retry)`);
    return again.gif;
  }

  private once(q: Record<string, string>): Promise<{ gif: Uint8Array | null; why?: string }> {
    if (!this.available) return Promise.resolve({ gif: null, why: "Cora's desktop app isn't connected (it draws banners)" });
    const id = randomBytes(6).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null, `no banner from the desktop app in ${Math.round(this.waitMs / 1000)} s`), this.waitMs);
      const done = (gif: Uint8Array | null, why?: string) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve({ gif, ...(why ? { why } : {}) });
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

/**
 * A message's banner, by who wrote it. Cora's own (her
 * agent, or no session): her look, as bannerWords says. A session's: its colour and orb, "Cora Session", its icon as a
 * watermark, its name and a small line ("started by Cora", its ticket's key). Never folders, paths, ticket summaries or
 * anything from your prompts. `outside`: it goes beyond your company (a shared channel, another workspace, a guest):
 * no name, no ticket, just who it works for. `reviewed`: you see it on a draft before it goes, so a name it was given
 * from its first prompt may show; otherwise only a name you gave it.
 */
export function bannerFor(o: { name: string; session: SessionInfo | null | undefined; cora: boolean; text?: string; privateDir?: string; outside: boolean; reviewed: boolean }): Record<string, string> {
  const s = o.session;
  if (o.cora || !s) return bannerWords({ name: o.name, session: s, text: o.text, privateDir: o.privateDir });
  const q: Record<string, string> = { kind: 'session', color: sessionColorOf(s) };
  if (o.name) q.name = o.name;
  if (s.icon) q.icon = s.icon;
  if (o.outside) {
    q.sub = `working for ${o.name || 'you'}`;
    return q;
  }
  const title = s.alias?.trim() || (o.reviewed ? s.autoName?.trim() : '') || '';
  if (title) q.line = title.slice(0, 80);
  const sub = [s.startedBy === 'cora' ? 'started by Cora' : '', s.ticket?.key ?? (s.issue ? `#${s.issue.iid}` : '')].filter(Boolean).join(' · ');
  if (sub) q.sub = sub;
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
