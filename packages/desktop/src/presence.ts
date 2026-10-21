import { powerMonitor } from 'electron';
import { readFileSync } from 'node:fs';

/**
 * Are you at the PC? Every 30 seconds the server hears how long it's been since your last key or mouse move, and
 * whether the screen is locked (Cora's Slack bot messages you while you're away).
 */
export function startPresence(o: { base: string; tokenFile: string }): () => void {
  let locked = false;
  const onLock = () => ((locked = true), void send());
  const onUnlock = () => ((locked = false), void send());
  powerMonitor.on('lock-screen', onLock);
  powerMonitor.on('unlock-screen', onUnlock);
  const send = async () => {
    try {
      const token = readFileSync(o.tokenFile, 'utf8').trim();
      const idle = powerMonitor.getSystemIdleTime();
      const isLocked = locked || powerMonitor.getSystemIdleState(60) === 'locked';
      await fetch(`${o.base}/api/local/presence`, { method: 'POST', headers: { 'x-cora-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ idle, locked: isLocked }), signal: AbortSignal.timeout(5000) });
    } catch {
      /* the server is restarting: next time */
    }
  };
  void send();
  const t = setInterval(() => void send(), 30_000);
  return () => {
    clearInterval(t);
    powerMonitor.off('lock-screen', onLock);
    powerMonitor.off('unlock-screen', onUnlock);
  };
}
