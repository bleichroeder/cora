/**
 * HTTP sign-in (Basic, Digest, NTLM; a proxy's too) for pages in Cora's browser. Electron shows no form of its own: it
 * raises `login` and cancels the sign-in unless the app answers, so a page behind basic auth just got its 401. Here is
 * what Cora does with a challenge (the Electron wiring is in main.ts; the card that asks is the dashboard's):
 * - a site asks once: its other requests arriving meanwhile (a page's scripts and pictures) wait for the same answer;
 * - an answer you asked Cora to keep is given again for that site, until Cora closes (kept in memory only: never
 *   written anywhere);
 * - a challenge that comes straight back means the answer was wrong: what was kept is dropped and you're asked again,
 *   told that it failed.
 */

/** Who is asking: Electron's authInfo, with the page's address. */
export type Challenge = { host: string; port: number; realm: string; proxy: boolean; scheme: string; url: string };
export type Creds = { username: string; password: string };
/** What the dashboard's card is given (never a password). */
export type AuthAsk = Challenge & { id: string; /** the last answer for this site was refused */ failed: boolean; /** the page's address isn't https (nor this PC): the password crosses the network readable */ plain: boolean };

/** A challenge this soon after an answer is that answer refused (Chromium keeps a good one and doesn't ask again). */
export const REFUSED_MS = 4000;

const LOCAL = /^(localhost|127(?:\.\d+){3}|\[?::1\]?)$/i;
/** Does the password cross the network readable? (Basic over plain http to another machine; a proxy's is its own matter.) */
export function plainText(c: Challenge): boolean {
  if (c.proxy) return false;
  try {
    const u = new URL(c.url);
    return u.protocol === 'http:' && !LOCAL.test(u.hostname);
  } catch {
    return false;
  }
}

export const siteKey = (c: Pick<Challenge, 'host' | 'port' | 'realm' | 'proxy'>) => `${c.proxy ? 'proxy' : 'site'}|${c.host.toLowerCase()}:${c.port}|${c.realm}`;

export class HttpAuth {
  private kept = new Map<string, Creds>();
  /** when each site was last answered (kept or typed) */
  private answered = new Map<string, number>();
  /** the question open for each site, and everyone waiting on it */
  private open = new Map<string, { id: string; waiting: Array<(c: Creds | null) => void> }>();
  private n = 0;

  /** `ask`: put the question to the user (the card); `now`: the clock (a test's). */
  constructor(private o: { ask(a: AuthAsk): void; now?: () => number }) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** A challenge came: `done` gets the sign-in to give, or null to give none (the page gets its 401). */
  challenge(c: Challenge, done: (c: Creds | null) => void): void {
    const key = siteKey(c);
    const q = this.open.get(key);
    if (q) return void q.waiting.push(done);
    const last = this.answered.get(key);
    const failed = last != null && this.now() - last < REFUSED_MS;
    if (failed) this.kept.delete(key);
    const kept = this.kept.get(key);
    if (kept) {
      this.answered.set(key, this.now());
      return done(kept);
    }
    const id = `auth${++this.n}`;
    this.open.set(key, { id, waiting: [done] });
    this.o.ask({ ...c, id, failed, plain: plainText(c) });
  }

  /** The user's answer to a question (null: cancelled, or nobody could be asked). `keep`: for this site until Cora closes. */
  answer(id: string, creds: Creds | null, keep = false): boolean {
    const hit = [...this.open].find(([, q]) => q.id === id);
    if (!hit) return false;
    const [key, q] = hit;
    this.open.delete(key);
    if (creds) {
      this.answered.set(key, this.now());
      if (keep) this.kept.set(key, creds);
      else this.kept.delete(key);
    }
    for (const w of q.waiting) w(creds);
    return true;
  }

  /** Every open question answered with nothing (the window went away). */
  cancelAll(): void {
    for (const [, q] of [...this.open]) this.answer(q.id, null);
  }

  /** The questions still open (their ids). */
  pending(): string[] {
    return [...this.open.values()].map((q) => q.id);
  }
}
