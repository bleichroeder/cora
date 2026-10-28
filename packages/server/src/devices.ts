import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readSecret, writeSecret } from './secrets';

/** A device you paired (your iPad, a laptop): what it's called, when, when it was last seen. Its key is never kept. */
export type DeviceInfo = { id: string; name: string; pairedAt: number; lastSeen: number };
type Stored = DeviceInfo & { keyHash: string };

const hash = (key: string) => createHash('sha256').update(key).digest('hex');
/** How long a pairing code works, once. */
const PAIR_MS = 5 * 60_000;

/**
 * Your paired devices: one sealed file of names and
 * key hashes. Pairing: the PC makes a one-time code (and the secret its QR code carries); the device that gives it back
 * within 5 minutes gets a key of its own. Tailscale only brings it here; this key is what lets it in.
 */
export class Devices {
  private pairing: { code: string; secret: string; until: number; tries: number } | null = null;
  private cache: Stored[] | null = null;
  constructor(private o: { file: string; now?: () => number; onChange?: (list: DeviceInfo[]) => void }) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }
  private load(): Stored[] {
    if (this.cache) return this.cache;
    if (!existsSync(this.o.file)) return (this.cache = []);
    try {
      const j = JSON.parse(readSecret(this.o.file)) as { devices?: Stored[] };
      return (this.cache = Array.isArray(j.devices) ? j.devices : []);
    } catch {
      return (this.cache = []);
    }
  }
  private save(list: Stored[]): void {
    this.cache = list;
    writeSecret(this.o.file, JSON.stringify({ devices: list }));
    this.o.onChange?.(this.list());
  }

  list(): DeviceInfo[] {
    return this.load().map(({ keyHash: _k, ...d }) => d);
  }

  /** Start pairing (from the PC): a 6-digit code and the secret a QR code carries, for 5 minutes, once. */
  startPairing(): { code: string; secret: string; until: number } {
    const p = { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), secret: randomBytes(24).toString('hex'), until: this.now() + PAIR_MS, tries: 0 };
    this.pairing = p;
    return { code: p.code, secret: p.secret, until: p.until };
  }
  cancelPairing(): void {
    this.pairing = null;
  }
  pairingOpen(): boolean {
    return !!this.pairing && this.pairing.until > this.now();
  }

  /** A device gives back the code (or the QR's secret): its key, once. Five wrong tries end the pairing. */
  pair(o: { code?: string; secret?: string; name: string }): { ok: true; key: string; device: DeviceInfo } | { ok: false; why: string } {
    const p = this.pairing;
    if (!p || p.until < this.now()) return { ok: false, why: 'No pairing is open: start one on your PC (Settings › Devices › Pair a device).' };
    const right = (o.secret && o.secret === p.secret) || (o.code && o.code.replace(/\D/g, '') === p.code);
    if (!right) {
      if (++p.tries >= 5) this.pairing = null;
      return { ok: false, why: "That code doesn't match." };
    }
    this.pairing = null;
    const key = randomBytes(32).toString('hex');
    const t = this.now();
    const device: Stored = { id: randomBytes(6).toString('hex'), name: (o.name || 'A device').slice(0, 60), pairedAt: t, lastSeen: t, keyHash: hash(key) };
    this.save([...this.load(), device]);
    const { keyHash: _k, ...info } = device;
    return { ok: true, key, device: info };
  }

  /** Is this a paired device's key? (Seen now: noted at most once a minute.) */
  check(key: string | undefined): DeviceInfo | null {
    if (!key || !/^[0-9a-f]{64}$/.test(key)) return null;
    const h = hash(key);
    const list = this.load();
    const d = list.find((x) => x.keyHash === h);
    if (!d) return null;
    if (this.now() - d.lastSeen > 60_000) {
      d.lastSeen = this.now();
      this.save(list);
    }
    const { keyHash: _k, ...info } = d;
    return info;
  }

  remove(id: string): boolean {
    const list = this.load();
    if (!list.some((d) => d.id === id)) return false;
    this.save(list.filter((d) => d.id !== id));
    return true;
  }
  rename(id: string, name: string): boolean {
    const list = this.load();
    const d = list.find((x) => x.id === id);
    if (!d) return false;
    d.name = name.trim().slice(0, 60) || d.name;
    this.save(list);
    return true;
  }
}

/** A name for a device from its browser: "iPad", "Mac", "Windows PC"… */
export function deviceName(ua: string | undefined): string {
  const u = ua ?? '';
  if (/iPad/.test(u) || (/Macintosh/.test(u) && /Mobile\//.test(u))) return 'iPad';
  if (/iPhone/.test(u)) return 'iPhone';
  if (/Android/.test(u)) return 'Android';
  if (/Macintosh/.test(u)) return 'Mac';
  if (/Windows/.test(u)) return 'Windows PC';
  if (/Linux/.test(u)) return 'Linux';
  return 'A device';
}
