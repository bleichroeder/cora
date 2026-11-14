/**
 * A page whose certificate Chromium doesn't trust (a dev server's self-signed one, an internal CA this PC doesn't know,
 * an expired one). Electron refuses it and asks nobody; a browser shows a page with "proceed anyway". Here is what Cora
 * does with one (the Electron wiring is in main.ts; the card that asks is the dashboard's):
 * - a site is asked about once: its other requests arriving meanwhile wait for the same answer;
 * - "continue" holds for that site with that very certificate until Cora closes (in memory only): a different
 *   certificate for the same site asks again, since that is what an attack would look like;
 * - no answer, or nobody to ask: refused, as before.
 */

/** What's wrong, and with what: Electron's certificate-error, the parts that matter. */
export type CertProblem = { url: string; error: string; fingerprint: string; subject: string; issuer: string; validFrom: number; validTo: number };
/** What the dashboard's card is given. */
export type CertAsk = CertProblem & { id: string; host: string; /** this PC itself (a local dev server): the usual, harmless case */ local: boolean; /** what the error means, in words */ why: string };

const LOCAL = /^(localhost|127(?:\.\d+){3}|\[?::1\]?|.+\.localhost)$/i;

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}
export const isLocal = (url: string): boolean => {
  try {
    return LOCAL.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** Chromium's error, in words (the ones a person meets; the rest are shown as they are). */
export function whyUntrusted(error: string): string {
  const e = error.replace(/^net::/, '');
  if (e === 'ERR_CERT_AUTHORITY_INVALID') return "It's signed by itself or by an authority this PC doesn't know.";
  if (e === 'ERR_CERT_DATE_INVALID') return 'It has expired, or is not valid yet.';
  if (e === 'ERR_CERT_COMMON_NAME_INVALID') return 'It was issued for a different address than this one.';
  if (e === 'ERR_CERT_REVOKED') return 'It has been revoked by whoever issued it.';
  if (e === 'ERR_CERT_WEAK_SIGNATURE_ALGORITHM' || e === 'ERR_CERT_WEAK_KEY') return 'It uses encryption too weak to trust.';
  return `Chromium says: ${e}`;
}

/** A revoked certificate is never continued past: someone took it back on purpose. */
export const neverAllowed = (error: string): boolean => /ERR_CERT_REVOKED/.test(error);

const key = (p: Pick<CertProblem, 'url' | 'fingerprint'>) => `${hostOf(p.url)}|${p.fingerprint}`;

export class CertTrust {
  private allowed = new Set<string>();
  private open = new Map<string, { id: string; waiting: Array<(ok: boolean) => void> }>();
  private n = 0;

  constructor(private o: { ask(a: CertAsk): void }) {}

  /** A page met a certificate it can't trust: `done(true)` lets it through. */
  problem(p: CertProblem, done: (ok: boolean) => void): void {
    const host = hostOf(p.url);
    if (!host || !p.fingerprint || neverAllowed(p.error)) return done(false);
    const k = key(p);
    if (this.allowed.has(k)) return done(true);
    const q = this.open.get(k);
    if (q) return void q.waiting.push(done);
    const id = `cert${++this.n}`;
    this.open.set(k, { id, waiting: [done] });
    this.o.ask({ ...p, id, host, local: isLocal(p.url), why: whyUntrusted(p.error) });
  }

  /** Your answer: continue (for that site and certificate, until Cora closes) or not. */
  answer(id: string, ok: boolean): boolean {
    const hit = [...this.open].find(([, q]) => q.id === id);
    if (!hit) return false;
    const [k, q] = hit;
    this.open.delete(k);
    if (ok) this.allowed.add(k);
    for (const w of q.waiting) w(ok);
    return true;
  }

  cancelAll(): void {
    for (const [, q] of [...this.open]) this.answer(q.id, false);
  }

  pending(): string[] {
    return [...this.open.values()].map((q) => q.id);
  }
}
