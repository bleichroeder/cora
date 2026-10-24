import { create } from 'zustand';
import { LOCK_PIN, type LockStatus } from '@cora/shared';

/** Lockdown, from the dashboard: lock now, and your PIN (Settings › Lockdown). */
export const useLock = create<{ status: LockStatus | null; /** choosing a PIN to lock with */ setup: boolean }>(() => ({ status: null, setup: false }));

/** To the lock screen (the server has locked: every page goes there). */
export function toLockScreen(): void {
  if (!location.pathname.startsWith('/lock')) location.replace('/lock.html');
}

export async function loadLock(): Promise<void> {
  const r = await fetch('/api/lock').catch(() => null);
  if (r?.ok) useLock.setState({ status: (await r.json()) as LockStatus });
}

/** Lock Cora now; with no PIN yet, choose one first (then it locks). */
export async function lockNow(): Promise<void> {
  const r = await fetch('/api/lock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
  if (r?.ok) return toLockScreen();
  if (r?.status === 409) useLock.setState({ setup: true });
}

const send = async (method: 'PUT' | 'DELETE', url: string, body: object): Promise<string | null> => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (!r) return "Can't reach Cora's server.";
  const j = (await r.json().catch(() => ({}))) as LockStatus & { error?: string };
  if (!r.ok) return j.error ?? `HTTP ${r.status}`;
  useLock.setState({ status: j });
  return null;
};

/** Set or change your PIN (with the one it had, to change it): an error to show, or null. */
export function savePin(pin: string, confirm: string, current?: string): Promise<string | null> {
  if (!LOCK_PIN.test(pin)) return Promise.resolve('A PIN is 4 to 8 digits.');
  if (pin !== confirm) return Promise.resolve("Those two don't match.");
  return send('PUT', '/api/lock/pin', { pin, ...(current ? { current } : {}) });
}
export const removePin = (current: string) => send('DELETE', '/api/lock/pin', { current });
export const setLockOnWindows = (on: boolean) => send('PUT', '/api/lock/options', { onWindowsLock: on });
