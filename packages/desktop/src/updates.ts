import { app } from 'electron';

/**
 * Installed Cora updates itself: new versions come from the public repo's releases (no token: anyone can read them),
 * download in the background, and install when you restart Cora (or the next time it quits). Hosted sessions keep
 * running: their terminal host lives outside the install folder. A dev checkout never updates this way.
 * (Before 0.1.3, builds read a private releases repo with a token built in; 0.1.3 was published there too, to bring
 * them across.)
 */
export const RELEASES = { owner: 'bleichroeder', repo: 'cora' };
const CHECK_MS = 6 * 3_600_000;

export function startUpdates(o: { root: string; onReady: (version: string) => void; log: (m: string) => void }): { install(): void } | null {
  if (!app.isPackaged) return null;
  let au: any;
  try {
    // only in the installed app (release/app's dependencies)
    au = require('electron-updater').autoUpdater;
  } catch (e) {
    o.log(`updates: ${(e as Error).message}`);
    return null;
  }
  au.setFeedURL({ provider: 'github', ...RELEASES });
  au.autoDownload = true;
  au.autoInstallOnAppQuit = true;
  au.logger = { info: (m: unknown) => o.log(`updates: ${m}`), warn: (m: unknown) => o.log(`updates: ${m}`), error: (m: unknown) => o.log(`updates: ${m}`), debug: () => {} };
  au.on('update-downloaded', (i: { version: string }) => o.onReady(i.version));
  au.on('error', (e: Error) => o.log(`updates: ${e.message}`));
  const check = () => void Promise.resolve(au.checkForUpdates()).catch((e: Error) => o.log(`updates: ${e.message}`));
  setTimeout(check, 20_000).unref?.();
  setInterval(check, CHECK_MS).unref?.();
  // silently, and Cora opens again
  return { install: () => au.quitAndInstall(true, true) };
}
