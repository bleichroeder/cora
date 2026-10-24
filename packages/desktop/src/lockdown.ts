import { powerMonitor, type BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';

/** The lock screen's page (lockdown): the dashboard's window shows it while Cora is locked. */
export const isLockPage = (url: string): boolean => {
  try {
    return new URL(url).pathname.startsWith('/lock');
  } catch {
    return false;
  }
};

export type LockReason = 'tray' | 'key' | 'windows';

/**
 * Lockdown, on the desktop's side: lock from the tray, Ctrl+Alt+L, or when Windows locks or sleeps (the server says
 * whether you want that); and while the window shows the lock screen, `onChange` hides everything else of Cora's.
 */
export function setupLockdown(o: { base: string; tokenFile: string; win: () => BrowserWindow | null; onChange(locked: boolean): void; askPin(): void }) {
  let locked = false;
  const set = (on: boolean) => {
    if (on === locked) return;
    locked = on;
    o.onChange(on);
  };
  let power = false;
  const watch = (w: BrowserWindow) => {
    // Windows locks (Win+L, the screen saver) or the PC sleeps (powerMonitor: only once the app is ready)
    if (!power) {
      power = true;
      powerMonitor.on('lock-screen', () => void lock('windows'));
      powerMonitor.on('suspend', () => void lock('windows'));
    }
    const follow = (_e: unknown, url: string) => set(isLockPage(url));
    w.webContents.on('did-navigate', follow);
    w.webContents.on('did-navigate-in-page', follow);
  };

  async function lock(reason: LockReason): Promise<void> {
    let r: { locked?: boolean; needsPin?: boolean } = {};
    try {
      const token = readFileSync(o.tokenFile, 'utf8').trim();
      const res = await fetch(`${o.base}/api/local/lock`, { method: 'POST', headers: { 'x-cora-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ reason }), signal: AbortSignal.timeout(5000) });
      r = (await res.json()) as typeof r;
    } catch {
      return;
    }
    const w = o.win();
    if (r.locked) {
      // the dashboard hears it too and goes there; this makes sure (a page that's stuck, or still loading)
      if (w && !isLockPage(w.webContents.getURL())) void w.loadURL(`${o.base}/lock.html`);
      set(true);
    } else if (r.needsPin && reason !== 'windows') o.askPin();
  }

  return { watch, lock, get locked() { return locked; } };
}
