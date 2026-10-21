import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Installed Cora updates itself: new versions come from the
 * private releases repo (the build carries a read-only token for it in update.json), download in the background, and
 * install when you restart Cora (or the next time it quits). Hosted sessions keep running: their terminal host lives
 * outside the install folder. A dev checkout never updates this way.
 */
export const RELEASES = { owner: 'bleichroeder', repo: 'cora-releases' };
const CHECK_MS = 6 * 3_600_000;

export function startUpdates(o: { root: string; onReady: (version: string) => void; log: (m: string) => void }): { install(): void } | null {
  if (!app.isPackaged) return null;
  let token = '';
  try {
    token = String(JSON.parse(readFileSync(join(o.root, 'update.json'), 'utf8')).token ?? '');
  } catch {
    /* a build without one */
  }
  // (a test of an installed copy can give one for this run instead)
  token ||= process.env.CORA_UPDATE_TOKEN ?? '';
  if (!token) {
    o.log('updates: this build has no token for the releases repo, so it never updates');
    return null;
  }
  let au: any;
  try {
    // only in the installed app (release/app's dependencies)
    au = require('electron-updater').autoUpdater;
  } catch (e) {
    o.log(`updates: ${(e as Error).message}`);
    return null;
  }
  au.setFeedURL({ provider: 'github', ...RELEASES, private: true, token });
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
