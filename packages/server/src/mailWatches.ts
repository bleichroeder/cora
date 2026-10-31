import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MAIL_WATCH_DAYS, MAIL_WATCH_MAX_DAYS, MAX_MAIL_WATCHES, addressAllowed, type MailWatch } from '@cora/shared';
import { writeFileAtomic } from './fsx';

/**
 * Email watches: emails the user is waiting for, and what
 * to do when each comes. Set in plain words through an agent (gmail_watch), kept in ~/.cora/mail-watches.json. A watch
 * on `once` ends with its first email; on `thread` it follows that email's thread (a watch on a search becomes a watch
 * on the thread its first email started).
 */

export type WatchInput = {
  id?: string;
  about: string;
  thread?: string;
  query?: string;
  from: string;
  mode?: 'once' | 'thread';
  then: string;
  act?: 'tell' | 'ask' | 'do';
  reply?: 'ask' | 'draft';
  hours?: number;
  sessionId?: string;
  cwd?: string;
  by: string;
};

export class WatchError extends Error {}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

export class MailWatches {
  private all: MailWatch[] = [];

  constructor(private o: { file?: string; now?: () => number; onChange?: () => void } = {}) {
    if (!o.file) return;
    try {
      const j = JSON.parse(readFileSync(o.file, 'utf8'));
      if (Array.isArray(j)) this.all = j;
    } catch {
      this.all = [];
    }
  }

  private now = () => this.o.now?.() ?? Date.now();

  /** The live ones (expired ones go). */
  list(): MailWatch[] {
    const n = this.now();
    const live = this.all.filter((w) => w.until > n);
    if (live.length !== this.all.length) ((this.all = live), this.save());
    return [...live];
  }
  get(id: string): MailWatch | undefined {
    return this.list().find((w) => w.id === id);
  }
  any(): boolean {
    return this.list().length > 0;
  }

  /** A new watch, or (with an id) a change to one: what the user said, checked. */
  set(i: WatchInput): MailWatch {
    const about = oneLine(i.about ?? '').slice(0, 120);
    const from = oneLine(i.from ?? '').toLowerCase();
    const then = (i.then ?? '').trim().slice(0, 2000);
    const thread = i.thread?.trim();
    const query = i.query ? oneLine(i.query).slice(0, 300) : undefined;
    if (!about) throw new WatchError('Say in a few words what the watch is for (about).');
    if (!from || !/^@?[\w.+-]+(@[\w-]+(\.[\w-]+)+)?$/.test(from) || (!from.includes('@') && !from.includes('.'))) throw new WatchError('from must be the sender\'s address (ana@example.com) or domain (@example.com): find it with gmail_search first.');
    if (!then) throw new WatchError('Say what to do when it comes (then), in the user\'s words.');
    if (thread && !/^[\w-]{6,64}$/.test(thread)) throw new WatchError('thread must be a Gmail thread id (from gmail_search or gmail_read).');
    if (!thread && !query) throw new WatchError('Watch a thread (thread: its id), or give a Gmail search for the email (query: e.g. subject:(staging login)).');
    if (!i.sessionId && !i.cwd) throw new WatchError('Where should the work happen? Set from a session it is that session; from Cora, give the folder to start a session in (folder).');
    const hours = Math.min(MAIL_WATCH_MAX_DAYS * 24, Math.max(1, Number(i.hours) || MAIL_WATCH_DAYS * 24));
    const n = this.now();
    const old = i.id ? this.get(i.id) : undefined;
    if (i.id && !old) throw new WatchError(`No watch ${i.id} (gmail_watches lists them).`);
    if (!old && this.list().length >= MAX_MAIL_WATCHES) throw new WatchError(`At most ${MAX_MAIL_WATCHES} watches: stop one first.`);
    const w: MailWatch = {
      id: old?.id ?? randomUUID().slice(0, 8),
      about,
      ...(thread ? { thread } : {}),
      ...(query ? { query } : {}),
      from,
      mode: i.mode === 'thread' ? 'thread' : 'once',
      then,
      act: i.act === 'tell' || i.act === 'do' ? i.act : 'ask',
      reply: i.reply === 'draft' ? 'draft' : 'ask',
      ...(i.sessionId ? { sessionId: i.sessionId } : {}),
      ...(i.cwd ? { cwd: i.cwd } : {}),
      by: oneLine(i.by).slice(0, 80) || 'a session',
      createdAt: old?.createdAt ?? n,
      until: n + hours * 3_600_000,
      hits: old?.hits ?? 0,
      ...(old?.lastHit ? { lastHit: old.lastHit } : {}),
    };
    this.all = [...this.all.filter((x) => x.id !== w.id), w];
    this.save();
    return w;
  }

  remove(id: string): boolean {
    const had = this.all.some((w) => w.id === id);
    this.all = this.all.filter((w) => w.id !== id);
    if (had) this.save();
    return had;
  }

  /** A watch set with Cora got its session (the thread's later replies go there). */
  bind(id: string, sessionId: string): void {
    const w = this.all.find((x) => x.id === id);
    if (!w || w.sessionId === sessionId) return;
    this.all = this.all.map((x) => (x.id === id ? { ...x, sessionId } : x));
    this.save();
  }

  /** A watch had its email: a `once` watch ends; a `thread` watch now follows that thread. */
  hit(id: string, threadId: string): MailWatch | undefined {
    const w = this.all.find((x) => x.id === id);
    if (!w) return undefined;
    const next = { ...w, hits: w.hits + 1, lastHit: this.now(), ...(w.mode === 'thread' ? { thread: threadId } : {}) };
    this.all = w.mode === 'once' ? this.all.filter((x) => x.id !== id) : this.all.map((x) => (x.id === id ? next : x));
    this.save();
    return next;
  }

  private save(): void {
    if (this.o.file) writeFileAtomic(this.o.file, JSON.stringify(this.all, null, 2) + '\n');
    this.o.onChange?.();
  }
}

/** What a watch reads back (to the agent that set it, and so to the user). */
export function watchLine(w: MailWatch): string {
  const what = w.thread ? `the thread ${w.thread}` : `email matching ${w.query}`;
  const act = w.act === 'tell' ? 'tell the user' : w.act === 'ask' ? 'ask the user before starting' : 'start on it';
  const where = w.sessionId ? 'in the session that set it' : `in a new session in ${w.cwd}`;
  const until = new Date(w.until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return `[${w.id}] ${w.about}: ${what}, from ${w.from}, ${w.mode === 'thread' ? 'following its replies' : 'one email'}, until ${until}. When it comes: ${act} ${where} ("${w.then}"); reply: ${w.reply === 'ask' ? 'ask before drafting' : 'draft it'}.`;
}

/** A domain's organisation (its last two labels: alerts.example.com → example.com), as DMARC's relaxed alignment compares them. */
const orgOf = (d: string) => d.toLowerCase().split('.').filter(Boolean).slice(-2).join('.');

/** Gmail's own verdicts on an email (spf, dkim, dmarc), for saying why a check didn't pass. */
export function verdicts(auth: string): string {
  const a = auth.replace(/\([^)]*\)/g, ' ').toLowerCase();
  const one = (k: string) => new RegExp(`\\b${k}=(\\w+)`).exec(a)?.[1] ?? 'none';
  return `spf=${one('spf')}, dkim=${one('dkim')}, dmarc=${one('dmarc')}`;
}

/**
 * Is an email from who a watch waits for, really? Its From address must match, and Gmail's own check must pass for the
 * From domain, aligned as DMARC aligns (the same organisation): DKIM signed by it, DMARC passed for it, or SPF passed
 * for an envelope sender of it. Domains you trust (Settings › Gmail: internal alert senders that neither sign nor
 * align) skip Gmail's check; your own domain's mail without one (inside your Google Workspace) passes too.
 */
export function authentic(fromHeader: string, auth: string, want: string, myDomain: string, trusted: string[] = []): { ok: boolean; why?: string } {
  const addr = (/<([^>]+)>/.exec(fromHeader)?.[1] ?? fromHeader).trim().toLowerCase();
  const domain = addr.split('@')[1] ?? '';
  if (!addressAllowed(addr, [want])) return { ok: false, why: `it's from ${addr}, not ${want}` };
  if (domain && trusted.some((t) => domain === t.toLowerCase().replace(/^@/, '') || domain.endsWith(`.${t.toLowerCase().replace(/^@/, '')}`))) return { ok: true };
  // only Gmail's own verdicts (not what earlier hops reported, in parentheses)
  const a = auth.replace(/\([^)]*\)/g, ' ').toLowerCase();
  if (!a.trim()) return domain && domain === myDomain.toLowerCase() ? { ok: true } : { ok: false, why: `Gmail has no sender check on it; if ${domain} is yours (internal alerts), trust it in Settings › Gmail` };
  const aligned = (d: string) => !!d && orgOf(d.replace(/^.*@/, '')) === orgOf(domain);
  const dkim = [...a.matchAll(/dkim=pass\s+header\.(?:i=@?|d=)([\w.@-]+)/g)].some((m) => aligned(m[1]));
  const dmarc = [...a.matchAll(/dmarc=pass[^;]*?header\.from=([\w.-]+)/g)].some((m) => aligned(m[1]));
  const spf = [...a.matchAll(/spf=pass[^;]*?smtp\.mailfrom=([\w.@+-]+)/g)].some((m) => aligned(m[1]));
  return dkim || dmarc || spf ? { ok: true } : { ok: false, why: `Gmail's sender check didn't pass for ${domain} (${verdicts(auth)}); if ${domain} is yours (internal alerts), trust it in Settings › Gmail` };
}
