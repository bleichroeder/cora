import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCK_PIN, type LockStatus } from '@cora/shared';
import { writeFileAtomic } from './fsx';

/** Wrong PINs allowed before each further try waits (30 s, doubling, at most 15 minutes). */
const FREE_TRIES = 5;
const WAIT_MS = 30_000;
const WAIT_MAX_MS = 15 * 60_000;

type Saved = {
  pin?: { salt: string; hash: string; digits: number };
  locked?: boolean;
  lockedAt?: number;
  fails?: number;
  waitUntil?: number;
  /** lock when Windows locks or sleeps (default on) */
  onWindowsLock?: boolean;
};

const hashOf = (pin: string, salt: string) => scryptSync(pin, Buffer.from(salt, 'hex'), 32).toString('hex');

/**
 * Lockdown: Cora locked behind your PIN (a scrypt hash, never the PIN), and staying locked over a restart. While it's
 * locked the server gives your pages nothing but the lock screen; sessions carry on.
 */
export class Lock {
  private s: Saved = {};
  private file: string | null;
  /** it locked or unlocked */
  onChange: (locked: boolean) => void = () => {};
  constructor(dataDir: string | null, private now: () => number = Date.now) {
    this.file = dataDir ? join(dataDir, 'lock.json') : null;
    try {
      if (this.file && existsSync(this.file)) this.s = JSON.parse(readFileSync(this.file, 'utf8')) as Saved;
    } catch {
      this.s = {};
    }
    // locked without a PIN to open it (a file edited by hand): not locked
    if (!this.s.pin) this.s.locked = false;
  }

  get locked(): boolean {
    return !!this.s.locked;
  }
  get hasPin(): boolean {
    return !!this.s.pin;
  }
  get onWindowsLock(): boolean {
    return this.s.onWindowsLock !== false;
  }

  status(): LockStatus {
    const wait = Math.max(0, (this.s.waitUntil ?? 0) - this.now());
    return { locked: this.locked, hasPin: this.hasPin, digits: this.s.pin?.digits ?? null, lockedAt: this.locked ? (this.s.lockedAt ?? null) : null, waitMs: this.locked ? wait : 0, onWindowsLock: this.onWindowsLock };
  }

  /** Set (or change: the current one first) the PIN. */
  setPin(pin: unknown, current?: unknown): { ok: true } | { ok: false; error: string } {
    if (typeof pin !== 'string' || !LOCK_PIN.test(pin)) return { ok: false, error: 'A PIN is 4 to 8 digits.' };
    if (this.s.pin && !this.matches(current)) return { ok: false, error: "That isn't your current PIN." };
    const salt = randomBytes(16).toString('hex');
    this.s.pin = { salt, hash: hashOf(pin, salt), digits: pin.length };
    this.save();
    return { ok: true };
  }

  /** Take the PIN away (the current one, to do it): Cora can't lock until there's one again. */
  clearPin(current: unknown): { ok: true } | { ok: false; error: string } {
    if (!this.s.pin) return { ok: true };
    if (!this.matches(current)) return { ok: false, error: "That isn't your current PIN." };
    delete this.s.pin;
    this.s.locked = false;
    this.save();
    return { ok: true };
  }

  setOptions(o: { onWindowsLock?: unknown }): void {
    if (typeof o.onWindowsLock === 'boolean') this.s.onWindowsLock = o.onWindowsLock;
    this.save();
  }

  /** Lock (there must be a PIN to open it again). */
  lock(): boolean {
    if (!this.s.pin) return false;
    if (this.s.locked) return true;
    this.s.locked = true;
    this.s.lockedAt = this.now();
    this.save();
    this.onChange(true);
    return true;
  }

  /** Open with the PIN; after a few wrong ones, each next try waits longer. */
  unlock(pin: unknown): { ok: true } | { ok: false; waitMs: number } {
    if (!this.s.locked) return { ok: true };
    const now = this.now();
    const wait = (this.s.waitUntil ?? 0) - now;
    if (wait > 0) return { ok: false, waitMs: wait };
    if (!this.matches(pin)) {
      const fails = (this.s.fails ?? 0) + 1;
      this.s.fails = fails;
      this.s.waitUntil = fails >= FREE_TRIES ? now + Math.min(WAIT_MAX_MS, WAIT_MS * 2 ** (fails - FREE_TRIES)) : 0;
      this.save();
      return { ok: false, waitMs: Math.max(0, this.s.waitUntil - now) };
    }
    this.s.locked = false;
    this.s.fails = 0;
    this.s.waitUntil = 0;
    this.save();
    this.onChange(false);
    return { ok: true };
  }

  /** Is this the PIN? (Wrong tries count, and wait, as at the lock screen.) For taking Cora back to this PC. */
  verify(pin: unknown): { ok: true } | { ok: false; waitMs: number } {
    const now = this.now();
    const wait = (this.s.waitUntil ?? 0) - now;
    if (wait > 0) return { ok: false, waitMs: wait };
    if (!this.matches(pin)) {
      const fails = (this.s.fails ?? 0) + 1;
      this.s.fails = fails;
      this.s.waitUntil = fails >= FREE_TRIES ? now + Math.min(WAIT_MAX_MS, WAIT_MS * 2 ** (fails - FREE_TRIES)) : 0;
      this.save();
      return { ok: false, waitMs: Math.max(0, this.s.waitUntil - now) };
    }
    this.s.fails = 0;
    this.s.waitUntil = 0;
    this.save();
    return { ok: true };
  }

  private matches(pin: unknown): boolean {
    const p = this.s.pin;
    if (!p || typeof pin !== 'string' || !LOCK_PIN.test(pin)) return false;
    return timingSafeEqual(Buffer.from(hashOf(pin, p.salt), 'hex'), Buffer.from(p.hash, 'hex'));
  }

  private save(): void {
    try {
      if (this.file) writeFileAtomic(this.file, JSON.stringify(this.s), { mode: 0o600 });
    } catch {
      /* kept in memory */
    }
  }
}
