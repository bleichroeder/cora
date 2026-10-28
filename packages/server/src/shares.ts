import { createHash, randomBytes } from 'node:crypto';

/** Your private areas: closed to guests unless you open them mid-share (Secrets and Settings never open). */
export const LIVE_AREAS = ['inbox', 'notes', 'messages', 'console'] as const;
export type LiveArea = (typeof LIVE_AREAS)[number];
export type LiveMode = 'view' | 'interactive' | 'drive';

export type LiveGuest = { id: string; name: string; login?: string; since: number; lastSeen: number };
export type LiveShare = { id: string; mode: LiveMode; followOnly: boolean; open: LiveArea[]; startedAt: number; guests: LiveGuest[] };

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Go live: one share at a time, a link with a secret
 * in it; each guest who opens it gets a key of their own (kept as a hash), named from Tailscale (for showing only:
 * never trusted to let anyone in). Ending the share, or removing a guest, ends their key at once. Nothing is kept past
 * a restart: a share is for now.
 */
export class Shares {
  private share: (LiveShare & { tokenHash: string }) | null = null;
  private keys = new Map<string, string>(); // a guest key's hash → the guest's id
  /** the share changed (the app publishes it to the screens) */
  onChange?: () => void;
  constructor(private o: { now?: () => number; onChange?: () => void } = {}) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }
  private changed(): void {
    this.o.onChange?.();
    this.onChange?.();
  }

  /** The share now (none: not live). */
  current(): LiveShare | null {
    if (!this.share) return null;
    const { tokenHash: _t, ...s } = this.share;
    return { ...s, guests: [...s.guests] };
  }

  /** Go live: a new share (any before it ends), viewing, the private areas closed; its link's secret. */
  start(): { share: LiveShare; token: string } {
    this.end();
    const token = randomBytes(24).toString('hex');
    this.share = { id: randomBytes(6).toString('hex'), mode: 'view', followOnly: false, open: [], startedAt: this.now(), guests: [], tokenHash: hash(token) };
    this.changed();
    return { share: this.current()!, token };
  }

  end(): void {
    if (!this.share) return;
    this.share = null;
    this.keys.clear();
    this.changed();
  }

  /** Is this the link's secret (while the share lasts)? */
  valid(token: string): boolean {
    return !!this.share && !!token && hash(token) === this.share.tokenHash;
  }

  /** Someone opened the link: a guest, with a key of their own (the link's secret must match). */
  join(token: string, who: { name?: string; login?: string }): { guest: LiveGuest; key: string } | null {
    if (!this.share || !token || hash(token) !== this.share.tokenHash) return null;
    const key = randomBytes(32).toString('hex');
    const t = this.now();
    const guest: LiveGuest = { id: randomBytes(5).toString('hex'), name: (who.name || who.login?.split('@')[0] || 'A guest').slice(0, 60), ...(who.login ? { login: who.login.slice(0, 120) } : {}), since: t, lastSeen: t };
    this.share.guests.push(guest);
    this.keys.set(hash(key), guest.id);
    this.changed();
    return { guest, key };
  }

  /** A guest's key: who they are, while the share lasts and they're still in it. */
  check(key: string | undefined): LiveGuest | null {
    if (!key || !this.share || !/^[0-9a-f]{64}$/.test(key)) return null;
    const id = this.keys.get(hash(key));
    const g = id ? this.share.guests.find((x) => x.id === id) : undefined;
    if (!g) return null;
    g.lastSeen = this.now();
    return g;
  }

  remove(guestId: string): boolean {
    if (!this.share?.guests.some((g) => g.id === guestId)) return false;
    this.share.guests = this.share.guests.filter((g) => g.id !== guestId);
    for (const [k, id] of this.keys) if (id === guestId) this.keys.delete(k);
    this.changed();
    return true;
  }

  setOpen(area: LiveArea, open: boolean): void {
    if (!this.share || !LIVE_AREAS.includes(area)) return;
    this.share.open = open ? [...new Set([...this.share.open, area])] : this.share.open.filter((a) => a !== area);
    this.changed();
  }
  isOpen(area: LiveArea): boolean {
    return !!this.share?.open.includes(area);
  }

  /** Follow only (guests stay on your view), or free to look around. */
  setFollowOnly(on: boolean): void {
    if (!this.share) return;
    this.share.followOnly = on;
    this.changed();
  }

  setMode(mode: LiveMode): void {
    if (!this.share) return;
    this.share.mode = mode;
    this.changed();
  }
}
