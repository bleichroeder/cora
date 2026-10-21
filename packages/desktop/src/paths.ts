import { app, shell } from 'electron';
import { copyFileSync, cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** Windows app identity: notifications, taskbar grouping, the Start-menu shortcut. */
export const APP_ID = 'com.cora.desktop';
/**
 * Cora's toast activator (fixed, so it's the same every run). Electron looks for a Start-menu shortcut with this and
 * APP_ID to send notifications through; without one it makes its own ("Electron", no icon), and Windows then shows
 * Cora as "Electron" in the taskbar and Start.
 */
export const TOAST_CLSID = '{5B8F3C2A-7D41-4E9A-9C3B-2A6E1F0D4C77}';

/**
 * Cora's data folder (same rule as the server's): $CORA_HOME (or the old $AGENT_BRAIN_HOME), else ~/.cora, copied
 * from ~/.agent-brain the first time; the old folder is used as is if the copy fails. The server is started with
 * CORA_HOME set to this, so both always agree.
 */
export function dataHome(): string {
  const set = process.env.CORA_HOME ?? process.env.AGENT_BRAIN_HOME;
  if (set) return set;
  const dir = join(homedir(), '.cora');
  const old = join(homedir(), '.agent-brain');
  if (existsSync(dir) || !existsSync(old)) return dir;
  try {
    cpSync(old, dir, { recursive: true });
    if (existsSync(join(dir, 'agent-brain.ico')) && !existsSync(join(dir, 'cora.ico'))) copyFileSync(join(dir, 'agent-brain.ico'), join(dir, 'cora.ico'));
    writeFileSync(join(dir, 'MIGRATED.txt'), `Copied from ${old} on ${new Date().toISOString()} when agent-brain became Cora. The old folder can be deleted once nothing runs from it.\n`);
    return dir;
  } catch (e) {
    console.error('[cora] could not copy the old data folder; using it as is', e);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leave it */
    }
    return old;
  }
}

/**
 * The app's own profile (the dashboard's saved layout, the browser's tabs and logins) lived under the old package
 * name; copy it to Cora's the first time. Must run before the app is ready. Skipped for test instances that pass
 * their own --user-data-dir.
 */
export function migrateProfile(): void {
  if (app.commandLine.hasSwitch('user-data-dir')) return;
  const now = app.getPath('userData');
  const old = join(app.getPath('appData'), '@agent-brain', 'desktop');
  if (existsSync(now) || !existsSync(old)) return;
  try {
    // Chromium's lock files belong to the old (closed) app, not the copy
    cpSync(old, now, { recursive: true, filter: (src) => !/^(lockfile|Singleton(Lock|Cookie|Socket))$/.test(basename(src)) });
  } catch (e) {
    console.error('[cora] could not copy the old profile; using it as is', e);
    try {
      rmSync(now, { recursive: true, force: true });
    } catch {
      /* leave it */
    }
    app.setPath('userData', old);
  }
}

/** Cora's icon changed (its colour): the Start-menu shortcut (and so the taskbar) shows the new file. */
export function refreshStartMenuIcon(icon: string): void {
  if (process.platform !== 'win32') return;
  const lnk = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Cora.lnk');
  try {
    const have = existsSync(lnk) ? shell.readShortcutLink(lnk) : null;
    // installed: only the installer's own shortcut to this Cora
    if (have && (!app.isPackaged || have.target?.toLowerCase() === process.execPath.toLowerCase())) shell.writeShortcutLink(lnk, 'replace', { ...have, icon, iconIndex: 0 });
  } catch {
    /* it shows the old one until Windows looks again */
  }
}

/**
 * Is this Electron made Cora's (scripts/brand-electron.mjs)? Its product name is Cora (so the Start-menu shortcut
 * Electron keeps for notifications is "Cora", not "Electron") and its resources/app opens Cora with no arguments.
 */
export function branded(): boolean {
  const dist = dirname(process.execPath);
  return existsSync(join(dist, 'cora-brand.json')) && existsSync(join(dist, 'resources', 'app', 'index.js'));
}

/**
 * Swap the old "agent-brain" Start-menu shortcut for a "Cora" one (development setup only; an installer owns
 * this otherwise). Nothing is created when neither exists, so deleting the shortcut sticks.
 *
 * Electron keeps a shortcut of its own for notifications: "<product name>.lnk", pointing at electron.exe with no
 * arguments (it rewrites it whole when it shows one). On an Electron made Cora's that is this one, so it is written
 * the same way (no arguments: resources/app opens Cora) and the two never fight. Otherwise it is "Electron.lnk", a
 * second shortcut for Cora that Windows may show Cora as: it goes.
 */
export function ensureStartMenuShortcut(repo: string, dataDir: string, coraIcon?: string | null): void {
  if (process.platform !== 'win32') return;
  const programs = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const lnk = join(programs, 'Cora.lnk');
  if (app.isPackaged) return stampInstalledShortcut(lnk);
  try {
    const icon = [coraIcon, join(dataDir, 'cora.ico'), join(dataDir, 'agent-brain.ico')].find((f): f is string => !!f && existsSync(f));
    const own = branded();
    const want = { target: process.execPath, args: own ? '' : 'packages/desktop', cwd: own ? dirname(process.execPath) : repo, description: 'Cora', appUserModelId: APP_ID, toastActivatorClsid: TOAST_CLSID, ...(icon ? { icon, iconIndex: 0 } : {}) };
    let have: Electron.ShortcutDetails | null = null;
    try {
      have = existsSync(lnk) ? shell.readShortcutLink(lnk) : null;
    } catch {
      have = null;
    }
    const same = !!have && (Object.keys(want) as Array<keyof typeof want>).every((k) => String(have![k as keyof Electron.ShortcutDetails] ?? '').toLowerCase() === String(want[k]).toLowerCase());
    if (!same) shell.writeShortcutLink(lnk, have ? 'replace' : 'create', want);
    // the old name, and the shortcut Electron made for itself when Cora's had no toast activator
    for (const name of ['agent-brain.lnk', 'Electron.lnk']) {
      const f = join(programs, name);
      if (!existsSync(f)) continue;
      let theirs: Electron.ShortcutDetails | null = null;
      try {
        theirs = shell.readShortcutLink(f);
      } catch {
        theirs = null;
      }
      const ours = theirs?.target?.toLowerCase() === process.execPath.toLowerCase() || theirs?.appUserModelId === APP_ID;
      if (name === 'agent-brain.lnk' || ours) rmSync(f);
    }
  } catch (e) {
    console.error('[cora] could not update the Start-menu shortcut', e);
  }
}

/**
 * Installed, the installer owns the Start-menu shortcut: it only gets Cora's toast activator (so a notification's
 * click finds Cora), and only when it's this Cora's.
 */
function stampInstalledShortcut(lnk: string): void {
  try {
    if (!existsSync(lnk)) return;
    const have = shell.readShortcutLink(lnk);
    if (have.target?.toLowerCase() !== process.execPath.toLowerCase()) return;
    if (have.toastActivatorClsid?.toLowerCase() === TOAST_CLSID.toLowerCase() && have.appUserModelId === APP_ID) return;
    shell.writeShortcutLink(lnk, 'replace', { ...have, appUserModelId: APP_ID, toastActivatorClsid: TOAST_CLSID });
  } catch (e) {
    console.error('[cora] could not stamp the Start-menu shortcut', e);
  }
}
