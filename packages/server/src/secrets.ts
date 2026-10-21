import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './fsx';

/**
 * Secrets at rest (Slack, Google and ElevenLabs sign-ins): sealed with AES-256-GCM under a key of Cora's own, kept in
 * secrets.key beside them. On Windows that key is itself protected by Windows for this user (DPAPI), so a copy of
 * Cora's folder (a backup, OneDrive, an upload) is useless anywhere else. It doesn't stop programs running as you:
 * nothing at rest can. Cora's own keys (token, ui-token…) stay as they are: Claude Code reads the hook key.
 * docs/audit-2026-10-20.md S10
 */

const SEALED = 'cora-sealed';
const KEY_FILE = 'secrets.key';

/** Windows' per-user protection, through Windows PowerShell (always there); base64 in, base64 out (never in argv). */
function dpapi(op: 'Protect' | 'Unprotect', b64: string): string {
  const script = `$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());Add-Type -AssemblyName System.Security;[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser'))`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: b64, encoding: 'utf8', windowsHide: true, timeout: 20_000 }).trim();
}
export const protectKey = (key: Buffer) => dpapi('Protect', key.toString('base64'));
export const unprotectKey = (blob: string) => Buffer.from(dpapi('Unprotect', blob), 'base64');

/** Windows protects the key, except under tests (a PowerShell per test folder would crawl). */
const useDpapi = () => process.platform === 'win32' && !process.env.VITEST;

const keys = new Map<string, Buffer | null>();
/** This folder's key: read (and unwrapped), or made; null when it can't be had (secrets then stay as they were). */
function keyFor(dir: string): Buffer | null {
  if (keys.has(dir)) return keys.get(dir)!;
  const file = join(dir, KEY_FILE);
  let key: Buffer | null = null;
  try {
    if (existsSync(file)) {
      const [kind, b64] = readFileSync(file, 'utf8').trim().split(':');
      key = kind === 'dpapi' ? unprotectKey(b64) : kind === 'plain' ? Buffer.from(b64, 'base64') : null;
    } else {
      const k = randomBytes(32);
      writeFileAtomic(file, `${useDpapi() ? `dpapi:${protectKey(k)}` : `plain:${k.toString('base64')}`}\n`, { mode: 0o600 });
      key = k;
    }
  } catch (e) {
    console.warn(`[cora] secrets: no key (${(e as Error).message.split('\n')[0]}); sign-ins stay as they are`);
    key = null;
  }
  if (key && key.length !== 32) key = null;
  keys.set(dir, key);
  return key;
}

const isSealed = (raw: string) => raw.trimStart().startsWith(`{"${SEALED}"`);

function seal(key: Buffer, text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return JSON.stringify({ [SEALED]: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
}
function open(key: Buffer, raw: string): string {
  const j = JSON.parse(raw) as { iv: string; tag: string; data: string };
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(j.iv, 'base64'));
  d.setAuthTag(Buffer.from(j.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(j.data, 'base64')), d.final()]).toString('utf8');
}

/** Write a secret file, sealed (as it was, when there's no key). */
export function writeSecret(file: string, text: string): void {
  const key = keyFor(dirname(file));
  writeFileAtomic(file, key ? seal(key, text) : text, { mode: 0o600 });
}

/**
 * Read a secret file. One written before secrets were sealed is sealed now, and only once it reads back the same (if
 * it doesn't, it's put back as it was). Throws when it can't be read (missing, or sealed under a key that's gone: a
 * new Windows profile), as reading a bad file always did: the caller treats it as not signed in.
 */
export function readSecret(file: string): string {
  const raw = readFileSync(file, 'utf8');
  const key = keyFor(dirname(file));
  if (isSealed(raw)) {
    if (!key) throw new Error('sealed, and the key to open it is gone');
    return open(key, raw);
  }
  if (key && raw.trim()) {
    try {
      writeFileAtomic(file, seal(key, raw), { mode: 0o600 });
      if (open(key, readFileSync(file, 'utf8')) !== raw) throw new Error('read back differently');
    } catch {
      writeFileAtomic(file, raw, { mode: 0o600 });
    }
  }
  return raw;
}
