import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, session, shell, Tray, type NativeImage } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { orbPng } from './icons';
import { coraIcoFile, readCoraColor, saveCoraColor } from './look';
import { isCoraColor } from '@cora/shared';
import { APP_ID, dataHome, ensureStartMenuShortcut, migrateProfile, refreshStartMenuIcon, TOAST_CLSID } from './paths';
import { hideToolWindows, isWeb, openToolWindow, setToolHosts, setupBrowser } from './browser';
import { hideCapture, setupCapture } from './capture';
import { startPresence } from './presence';
import { startRemoteBrowse } from './remoteBrowse';
import { startBanner } from './banner';
import { setupJira, startJiraWatch } from './jira';
import { setupDiagnostics } from './diag';
import { attachContextMenu, enableSpellcheck } from './contextMenu';
import { ensureServer, liveTerminals, probe, runningText, type ServerHandle } from './server';
import { runtimeFor } from './runtime';
import { startUpdates } from './updates';
import { saveExplain } from './explainFile';
import { forgetLogins, setupOnePassword } from './opFill';
import { setupLockdown } from './lockdown';

const PORT = Number(process.env.CORA_PORT ?? process.env.AGENT_BRAIN_PORT ?? 4317);
const DATA = dataHome();
// after the GPU process crashes Chromium blocks the page from WebGL until it reloads: Cora's 3D views rebuild their
// context instead (and a blocked page couldn't)
app.disableDomainBlockingFor3DAPIs();
setupDiagnostics(DATA);
migrateProfile();
// a dev checkout, or an installed Cora (no repo, no Node): where the parts are and how they run
const RT = runtimeFor({ packaged: app.isPackaged, execPath: process.execPath, dirname: __dirname, resourcesPath: process.resourcesPath });
const REPO = RT.root;
const CLI = RT.cli;
const BASE = `http://127.0.0.1:${PORT}`;
let jiraWatchStop: (() => void) | null = null;
const HOTKEY = 'Control+Alt+B';
const CORA_HOTKEY = 'Control+Alt+Space';
const CORA_STANDDOWN = 'Control+Alt+Backspace';
const SPLASH = join(__dirname, '..', 'splash.html');
const LOG = join(DATA, 'server.log');
// installed: the server runs on Cora.exe as Node, its terminal host on the bundled Node (from ~/.cora/runtime)
const SERVER = { port: PORT, cliPath: CLI, logFile: LOG, tokenFile: join(DATA, 'token'), run: { file: RT.node.file, env: { ...RT.node.env, ...(RT.hostNode ? { CORA_HOST_NODE: RT.hostNode } : {}) } }, args: RT.serverArgs };

const argv = process.argv;
const screenshotPath = argv.includes('--screenshot') ? argv[argv.indexOf('--screenshot') + 1] : undefined;
const startHidden = argv.includes('--hidden');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: ServerHandle | null = null;
let quitting = false;
/** chosen when quitting with sessions running: end them, or leave them in the terminal host */
let endOnQuit = false;
let needsYou = 0;
/** installed: a new version downloaded and waiting for a restart (and how to install it) */
let pendingUpdate: string | null = null;
let updates: { install(): void } | null = null;
/** popped-out explains (hidden while Cora is locked) */
const popouts = new Set<BrowserWindow>();

/**
 * Lockdown: while the window shows the lock screen, nothing else of Cora's shows (tools, popped-out explains, quick
 * capture), its hotkeys rest, and the tray only shows it or quits (never ending sessions).
 */
const lockdown = setupLockdown({
  base: BASE,
  tokenFile: join(DATA, 'token'),
  win: () => win,
  askPin: () => {
    show();
    win?.webContents.send('ab:command', 'lock');
  },
  onChange: (locked) => {
    if (locked) {
      hideToolWindows();
      hideCapture();
      forgetLogins();
      for (const w of popouts) if (!w.isDestroyed()) w.hide();
      // Cora's talk hotkeys: the dashboard turns them back on when it's back
      for (const k of [CORA_HOTKEY, CORA_STANDDOWN]) if (globalShortcut.isRegistered(k)) globalShortcut.unregister(k);
    } else for (const w of popouts) if (!w.isDestroyed()) w.showInactive();
    refreshTray();
  },
});

const img = (size: number, color?: string): NativeImage => nativeImage.createFromBuffer(orbPng(size, color));
// the orb in Cora's colour (yours to pick in Settings); red when something needs you
let coraColor = readCoraColor(DATA);
const ICON = { app: img(256, coraColor), tray: img(32, coraColor), trayAlert: img(32, '#f87171'), badge: img(16, '#f87171') };

/** Cora's colour changed: the window's and tray's icon now, the Start menu's file, and the splash next time. */
function setCoraColor(color: string) {
  coraColor = color;
  saveCoraColor(DATA, color);
  ICON.app = img(256, color);
  ICON.tray = img(32, color);
  win?.setIcon(ICON.app);
  refreshTray();
  const ico = coraIcoFile(DATA, color);
  if (ico) refreshStartMenuIcon(ico);
}

function show() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggle() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else show();
}

/** DevTools: in development, or when asked for (CORA_DEVTOOLS=1); not in the installed app (audit S12). */
const DEVTOOLS = !app.isPackaged || process.env.CORA_DEVTOOLS === '1';
/** Only http(s) and mail links go to other programs; nothing else a page links to starts one (audit S12). */
const outside = (url: string) => (isWeb(url) || /^mailto:/i.test(url)) && void shell.openExternal(url);

/**
 * Cora's own window (the default session): its page may use the mic (voice, the wake word), the clipboard and
 * notifications; nothing else, and nothing for any other page (the built-in browser has its own session). Popped-out
 * explains get their own session, which may do nothing (audit S12).
 */
function lockSessions(): void {
  const OWN = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'speaker-selection']);
  const ours = (url?: string) => !!url && (url === BASE || url.startsWith(`${BASE}/`));
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(OWN.has(perm) && ours(details?.requestingUrl || wc?.getURL())));
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => OWN.has(perm) && ours(origin || wc?.getURL()));
  const pop = session.fromPartition(POPOUT);
  pop.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  pop.setPermissionCheckHandler(() => false);
}
const POPOUT = 'popout';

function createWindow() {
  win = new BrowserWindow({
    width: 1640,
    height: 1020,
    minWidth: 1000,
    minHeight: 640,
    show: !startHidden,
    backgroundColor: '#06090f',
    title: 'Cora',
    icon: ICON.app,
    autoHideMenuBar: true,
    // no Windows title bar: the app runs to the top, and Windows' own buttons sit over its top-right corner, as tall
    // as the app's top row (40 px, its hairline left showing) on its dark; the rows' empty parts move the window
    titleBarStyle: 'hidden',
    // the window's buttons on a clear ground: what's under them (the session card's band, its glow) shows through
    titleBarOverlay: { color: '#00000000', symbolColor: '#a4afbf', height: 39 },
    // autoplay: voice speaks on its own (a spoken summary right after a restart, before you've clicked anything)
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, devTools: DEVTOOLS },
  });
  setupBrowser(win, BASE);
  setupOnePassword(win, BASE);
  setupJira(win);
  // watching Jira for you: once per run (a window made again doesn't start another)
  jiraWatchStop ??= startJiraWatch({ base: BASE, tokenFile: join(DATA, 'token') });
  // Ctrl+R (Ctrl+Shift+R: ignoring the cache) and F5 reload the app, wherever the keyboard is: a terminal would
  // otherwise take Ctrl+R (Claude Code's history search) and the menu would never see it
  win.webContents.on('before-input-event', (e, i) => {
    // Ctrl+Alt+L: lock Cora, wherever the keyboard is
    if (i.type === 'keyDown' && i.control && i.alt && !i.shift && !i.meta && i.key.toLowerCase() === 'l') {
      e.preventDefault();
      if (!lockdown.locked) void lockdown.lock('key');
      return;
    }
    if (i.type !== 'keyDown' || i.alt || i.meta) return;
    // F11: full screen (no taskbar, no window buttons), and back
    if (i.key === 'F11' && !i.control && !i.shift) {
      e.preventDefault();
      win?.setFullScreen(!win.isFullScreen());
      return;
    }
    const reload = (i.control && i.key.toLowerCase() === 'r') || (!i.control && i.key === 'F5');
    if (!reload) return;
    e.preventDefault();
    if (i.shift) win?.webContents.reloadIgnoringCache();
    else win?.webContents.reload();
  });
  // right-click in the dashboard's text fields and selections (elsewhere, nothing: the scene and terminals have their own)
  enableSpellcheck(win.webContents.session);
  lockdown.watch(win);
  attachContextMenu(win.webContents, { window: win, web: false });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });
  win.on('focus', () => win?.flashFrame(false));
  // Web links open in the built-in browser; Ctrl/Shift+click (and anything else) in the default browser.
  win.webContents.setWindowOpenHandler(({ url, disposition }) => {
    if (url.startsWith(BASE)) return { action: 'deny' };
    if (isWeb(url) && disposition === 'foreground-tab') win?.webContents.send('ab:open-web', url);
    else outside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(BASE)) {
      e.preventDefault();
      outside(url);
    }
  });
}

/** The dashboard's setup check, asked for while the splash plays (the server keeps the answer for the dashboard). */
let warming: Promise<void> | null = null;
function warmUp(): void {
  try {
    const token = readFileSync(join(DATA, 'ui-token'), 'utf8').trim();
    warming = fetch(`${BASE}/api/setup?warm=1`, { headers: { cookie: `ab_session=${token}` }, signal: AbortSignal.timeout(8000) })
      .then(() => undefined)
      .catch(() => undefined);
  } catch {
    warming = null;
  }
}

let watching = false;
/** Show the dashboard (the server is up); from here on, keep the server alive. */
function loadDashboard() {
  if (!win) return;
  const token = readFileSync(join(DATA, 'ui-token'), 'utf8').trim();
  void win.loadURL(`${BASE}/auth?key=${token}`);
  // nothing to go back to: the splash (and the sign-in link) would restart the app if the mouse's back button
  // or a stray history.back() reached them
  win.webContents.once('did-finish-load', () => win?.webContents.navigationHistory.clear());
  if (!watching) {
    watching = true;
    watchServer();
    // quick capture (Ctrl+Alt+N): once the dashboard has signed in (its window shares the sign-in)
    setupCapture(BASE, () => !lockdown.locked);
    // are you at the PC (Cora's Slack bot messages you while you're away)
    startPresence({ base: BASE, tokenFile: join(DATA, 'token') });
    // a session's browser on your other devices: pages rendered out of sight, only when one of them asks
    startRemoteBrowse({ base: BASE, tokenFile: join(DATA, 'token') });
    // Cora's Slack banner: recorded out of sight when a message you send has one
    startBanner({ base: BASE, tokenFile: join(DATA, 'token'), color: () => coraColor });
  }
  if (screenshotPath) {
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        const shot = await win!.webContents.capturePage();
        writeFileSync(screenshotPath, shot.toPNG());
        console.log(`[cora] screenshot written to ${screenshotPath}`);
      }, 7000),
    );
  }
}

/**
 * Start at login (the tray's checkbox): electron.exe with Cora's folder and --hidden. The folder matters on an
 * Electron that isn't made Cora's (scripts/brand-electron.mjs): without it, Windows opened Electron's demo app.
 */
const LOGIN = () => RT.login;
const loginOn = () => app.getLoginItemSettings(LOGIN()).executableWillLaunchAtLogin;
const setLogin = (on: boolean) => app.setLoginItemSettings({ openAtLogin: on, ...LOGIN() });
/** An entry from before (only --hidden: it opened Electron's demo app at login) gets Cora's folder. */
function repairLogin(): void {
  if (process.platform !== 'win32' || app.isPackaged || app.commandLine.hasSwitch('user-data-dir')) return;
  const s = app.getLoginItemSettings(LOGIN());
  if (s.executableWillLaunchAtLogin && !s.openAtLogin) setLogin(true);
}

function refreshTray() {
  if (!tray) return;
  tray.setImage(needsYou > 0 ? ICON.trayAlert : ICON.tray);
  tray.setToolTip(needsYou > 0 ? `Cora · ${needsYou} need${needsYou === 1 ? 's' : ''} you` : 'Cora');
  const login = loginOn();
  // locked: show it (the lock screen) or quit; nothing that would reach a session
  if (lockdown.locked) {
    tray.setToolTip('Cora · locked');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Show Cora (locked)', click: show }, { type: 'separator' }, { label: 'Quit', click: () => void quitAsking() }]));
    return;
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Cora', accelerator: HOTKEY, click: show },
      {
        label: 'New session…',
        click: () => {
          show();
          win?.webContents.send('ab:command', 'new-session');
        },
      },
      { label: 'Lock Cora', accelerator: 'Control+Alt+L', click: () => void lockdown.lock('tray') },
      { type: 'separator' },
      {
        label: 'Start at login',
        type: 'checkbox',
        checked: login,
        click: (item) => {
          setLogin(item.checked);
          refreshTray();
        },
      },
      { type: 'separator' },
      ...(pendingUpdate ? [{ label: `Restart to update (v${pendingUpdate})`, click: restartKeeping }, { type: 'separator' as const }] : []),
      { label: 'Quit', click: () => void quitAsking() },
    ]),
  );
}

/**
 * A newer Electron patch the server's security check downloaded (updates.json): install it now, before anything
 * starts. A helper waits for this app to exit, installs it, and opens Cora again. Not for test instances, and never
 * twice for the same version (a failed install is noted; a start that finds it still not installed gives up on it).
 */
function installPendingUpdate(): boolean {
  if (app.isPackaged || app.commandLine.hasSwitch('user-data-dir')) return false;
  const file = join(DATA, 'updates.json');
  let u: { electron?: { version?: string; ready?: boolean; failed?: string; tried?: string; after?: number; at?: number } } = {};
  try {
    u = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  const e = u.electron;
  const cur = process.versions.electron;
  const parts = (v: string) => v.split('.').map(Number);
  const newer = (a: string, b: string) => {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
    return false;
  };
  if (!e?.ready || !e.version || e.failed === e.version || parts(e.version)[0] !== parts(cur)[0] || !newer(e.version, cur)) return false;
  // it didn't install a moment ago: try again at a later start, not this one
  if (e.after && Date.now() < e.after) return false;
  const helper = join(REPO, 'scripts', 'update-electron.mjs');
  if (!existsSync(helper)) return false;
  // tried before and we're still on the old one: the helper didn't get to finish; don't loop
  if (e.tried === e.version) {
    writeFileSync(file, JSON.stringify({ ...u, electron: { ...e, ready: false, failed: e.version } }, null, 2));
    return false;
  }
  try {
    writeFileSync(file, JSON.stringify({ ...u, electron: { ...e, tried: e.version } }, null, 2));
    spawn('node', [helper, '--repo', REPO, '--version', e.version, '--from', cur, '--data', DATA, '--pid', String(process.pid), '--exe', process.execPath], { cwd: REPO, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    return false;
  }
  if (Notification.isSupported()) new Notification({ title: 'Updating Cora', body: `Installing Electron ${e.version} (security fixes). Cora opens again in a few seconds.`, icon: ICON.app }).show();
  return true;
}

/** The Electron installer is running now (its note in the data folder, and its process alive). */
function updating(): boolean {
  if (app.isPackaged) return false;
  try {
    const { pid } = JSON.parse(readFileSync(join(DATA, 'updating.json'), 'utf8')) as { pid?: number };
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Restart (to install an update): sessions keep running in the terminal host. */
function restartKeeping() {
  endOnQuit = false;
  quitting = true;
  // a downloaded update: it installs, and Cora opens again (sessions keep running in the terminal host)
  if (pendingUpdate && updates) return updates.install();
  app.relaunch();
  app.quit();
}

/** Quit; with Claude sessions (or shells) running in Cora, ask whether to end them or keep them running. */
async function quitAsking() {
  // locked: quitting keeps every session running (whoever is at the PC can't end them)
  if (lockdown.locked) {
    endOnQuit = false;
    quitting = true;
    return app.quit();
  }
  const { live, shells, persistent } = server?.owned ? await liveTerminals(PORT, join(DATA, 'token')) : { live: 0, shells: 0, persistent: true };
  if (live > 0) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'Quit Cora',
      message: runningText(live, shells),
      detail: persistent ? 'Keep them running in the background and pick them up next time you open Cora, or end them now.' : 'They will end when Cora quits.',
      buttons: persistent ? ['Keep running', 'End and quit', 'Cancel'] : ['End and quit', 'Cancel'],
      defaultId: 0,
      cancelId: persistent ? 2 : 1,
      noLink: true,
    });
    if (persistent ? response === 2 : response === 1) return;
    endOnQuit = persistent ? response === 1 : true;
  }
  quitting = true;
  app.quit();
}

/** If the server dies (crash, killed), start it again; terminals in the terminal host are picked back up. */
function watchServer() {
  let misses = 0;
  let restarting = false;
  setInterval(async () => {
    if (quitting || restarting) return;
    if (await probe(PORT, SERVER.tokenFile)) return void (misses = 0);
    if (++misses < 2) return;
    restarting = true;
    try {
      server = await ensureServer(SERVER);
      misses = 0;
      refreshTray();
    } catch (e) {
      console.error('[cora] server restart failed', e);
    } finally {
      restarting = false;
    }
  }, 4000).unref();
}

let booting = false;
let ready = false;

/**
 * For the splash's footer and notes: this build, Electron's version, how many changes since the last start, and
 * whether Electron was updated since then. Remembered in last-start.json for next time.
 */
function aboutThisStart(): Promise<{ t: 'about'; build: string | null; electron: string; changes: number | null; electronFrom: string | null }> {
  const git = (args: string[]) => new Promise<string | null>((res) => execFile('git', ['-C', REPO, ...args], { windowsHide: true, timeout: 3000 }, (err, out) => res(err ? null : String(out).trim())));
  const file = join(DATA, 'last-start.json');
  let last: { build?: string; electron?: string } = {};
  try {
    last = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* the first start */
  }
  const electron = process.versions.electron;
  return (async () => {
    // installed: its version (there's no repo to ask)
    const build = RT.packaged ? `v${app.getVersion()}` : await git(['rev-parse', '--short', 'HEAD']);
    const n = !RT.packaged && build && last.build && last.build !== build ? await git(['rev-list', '--count', `${last.build}..HEAD`]) : null;
    try {
      writeFileSync(file, JSON.stringify({ build, electron, at: Date.now() }, null, 2));
    } catch {
      /* not kept */
    }
    return { t: 'about' as const, build, electron, changes: n != null && /^\d+$/.test(n) ? Number(n) : null, electronFrom: last.electron && last.electron !== electron ? last.electron : null };
  })();
}
/** Start the server while the splash plays, relaying its startup stages; the splash asks for the dashboard when its finale ends. */
async function bootServer(noHost: boolean) {
  const send = (m: unknown) => win?.webContents.send('ab:splash', m);
  if (ready) return send({ t: 'ready' });
  if (booting) return;
  booting = true;
  void aboutThisStart().then(send);
  try {
    server = await ensureServer({ ...SERVER, noHost, stageFile: join(DATA, 'startup-stages.jsonl'), onStage: send });
    ready = true;
    warmUp();
    refreshTray();
    send({ t: 'ready' });
  } catch (e) {
    send({ t: 'error', message: (e as Error).message });
  } finally {
    booting = false;
  }
}

function fromOurWindow(e: Electron.IpcMainEvent) {
  return win && e.sender === win.webContents;
}

function wireIpc() {
  ipcMain.on('ab:splash-start', (e, noHost: boolean) => {
    if (fromOurWindow(e)) void bootServer(!!noHost);
  });
  // the splash's finale is done: the dashboard comes once its setup check is (the splash holds its last frame till
  // then, a few seconds at most), so it opens straight on the app, or on setting Cora up: never a second loader
  ipcMain.on('ab:splash-done', (e) => {
    if (fromOurWindow(e) && ready) void Promise.race([warming ?? Promise.resolve(), new Promise((r) => setTimeout(r, 4000))]).then(loadDashboard);
  });
  ipcMain.on('ab:splash-log', (e) => {
    if (fromOurWindow(e)) void shell.openPath(LOG);
  });
  ipcMain.handle('ab:clipboard-read', async (e) => {
    if (!win || e.sender !== win.webContents) return { text: '', image: false };
    const text = await clipboard.readText().catch(() => '');
    return { text, image: !text && (await clipboard.has('image/png').catch(() => false)) };
  });
  // sessions' journals: Documents\Cora\Journal, opened in Explorer (made first if it isn't there yet)
  ipcMain.on('ab:open-journal', (e, file: unknown) => {
    if (!fromOurWindow(e)) return;
    const dir = join(app.getPath('documents'), 'Cora', 'Journal');
    mkdirSync(dir, { recursive: true });
    // one journal: only a markdown file inside that folder
    const f = typeof file === 'string' ? resolve(file) : null;
    if (f && f.toLowerCase().startsWith(resolve(dir).toLowerCase() + '\\') && f.toLowerCase().endsWith('.md') && existsSync(f)) void shell.openPath(f);
    else void shell.openPath(dir);
  });
  ipcMain.on('ab:restart', (e) => {
    if (fromOurWindow(e)) restartKeeping();
  });
  // a new version waiting (installed Cora): the dashboard offers the restart
  ipcMain.handle('ab:update-ready', (e) => (win && e.sender === win.webContents ? pendingUpdate : null));
  // what this copy of Cora is (Settings › Updates & security)
  // a small picture of part of the dashboard (the session switcher's previews): a JPEG, at most 560 px wide
  ipcMain.handle('ab:snap', async (e, r: { x: number; y: number; width: number; height: number }) => {
    if (!win || e.sender !== win.webContents || !r || ![r.x, r.y, r.width, r.height].every((n) => Number.isFinite(n))) return null;
    const rect = { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
    try {
      const img = await win.webContents.capturePage(rect);
      if (img.isEmpty()) return null;
      const small = img.getSize().width > 560 ? img.resize({ width: 560, quality: 'good' }) : img;
      return `data:image/jpeg;base64,${small.toJPEG(72).toString('base64')}`;
    } catch {
      return null;
    }
  });
  ipcMain.handle('ab:app-info', (e) => (win && e.sender === win.webContents ? { version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron, chrome: process.versions.chrome } : null));
  // an explain saved as a file (Documents\Cora\Explains), shown selected in Explorer: its path, or why not
  ipcMain.handle('ab:save-explain', (e, m: { title?: unknown; ext?: unknown; content?: unknown }) => {
    if (!win || e.sender !== win.webContents) return { error: 'not allowed' };
    if (typeof m?.content !== 'string' || (m.ext !== 'md' && m.ext !== 'html')) return { error: 'nothing to save' };
    try {
      const path = saveExplain(join(app.getPath('documents'), 'Cora', 'Explains'), String(m.title ?? ''), m.ext, m.content);
      shell.showItemInFolder(path);
      return { path };
    } catch (err) {
      return { error: (err as Error).message };
    }
  });
  // Cora's hotkey, from anywhere: bring Cora up and start (or stop) talking to it
  ipcMain.on('ab:cora-hotkey', (e, on: unknown) => {
    if (!fromOurWindow(e) || (on && lockdown.locked)) return;
    const registered = globalShortcut.isRegistered(CORA_HOTKEY);
    if (on && !registered) {
      if (!globalShortcut.register(CORA_HOTKEY, () => (show(), win?.webContents.send('ab:cora-ptt')))) console.warn(`[cora] hotkey ${CORA_HOTKEY} is taken`);
      // stand Cora down, from anywhere
      if (!globalShortcut.register(CORA_STANDDOWN, () => win?.webContents.send('ab:cora-standdown'))) console.warn(`[cora] hotkey ${CORA_STANDDOWN} is taken`);
    } else if (!on && registered) {
      globalShortcut.unregister(CORA_HOTKEY);
      if (globalShortcut.isRegistered(CORA_STANDDOWN)) globalShortcut.unregister(CORA_STANDDOWN);
    }
  });
  ipcMain.on('ab:tool-window', (e, m: { url: string; title: string }) => {
    if (fromOurWindow(e) && !lockdown.locked && isWeb(String(m?.url))) openToolWindow(String(m.url), String(m.title ?? 'Cora'), ICON.app);
  });
  ipcMain.on('ab:cora-color', (e, c: unknown) => {
    if (fromOurWindow(e) && isCoraColor(c) && c.toLowerCase() !== coraColor) setCoraColor(c.toLowerCase());
  });
  ipcMain.on('ab:tool-hosts', (e, hosts: unknown) => {
    if (fromOurWindow(e) && Array.isArray(hosts)) setToolHosts(hosts.map(String));
  });
  ipcMain.on('ab:open-external', (e, url: string) => {
    if (fromOurWindow(e) && isWeb(String(url))) void shell.openExternal(String(url));
  });
  // plain text, or { text, html }: both formats at once (a reply copied with its formatting)
  ipcMain.on('ab:clipboard-write', (e, data: unknown) => {
    if (!fromOurWindow(e)) return;
    if (data && typeof data === 'object') {
      const { text, html } = data as { text?: unknown; html?: unknown };
      void clipboard.write([new ClipboardItem({ 'text/plain': String(text ?? ''), ...(typeof html === 'string' ? { 'text/html': html } : {}) })]).catch(() => {});
    } else void clipboard.writeText(String(data)).catch(() => {});
  });
  ipcMain.on('ab:notify', (e, m: { title: string; body: string; sessionId: string; open?: string }) => {
    if (!fromOurWindow(e) || !Notification.isSupported()) return;
    const n = new Notification({ title: m.title, body: m.body, icon: ICON.app, silent: false });
    n.on('click', () => {
      show();
      // about a page (a Jira ticket): open it; else go to the session
      if (m.open && /^https:\/\//.test(m.open)) win?.webContents.send('ab:open-url', m.open);
      else win?.webContents.send('ab:focus-session', m.sessionId);
    });
    n.show();
  });
  ipcMain.on('ab:needs-you', (e, n: number) => {
    if (!fromOurWindow(e)) return;
    const was = needsYou;
    needsYou = n;
    win?.setOverlayIcon(n > 0 ? ICON.badge : null, n > 0 ? `${n} need you` : '');
    if (n > was && win && !win.isFocused()) win.flashFrame(true);
    refreshTray();
  });
  ipcMain.on('ab:popout', (e, m: { title: string; html: string }) => {
    if (!fromOurWindow(e) || lockdown.locked) return;
    const w = new BrowserWindow({
      width: 1100,
      height: 820,
      title: m.title,
      icon: ICON.app,
      backgroundColor: '#0b0f17',
      autoHideMenuBar: true,
      // its own session: a popped-out explain (its scripts too) can't use the mic, the clipboard or anything else
      webPreferences: { partition: POPOUT, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: DEVTOOLS },
    });
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (isWeb(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    w.webContents.on('will-navigate', (ev) => ev.preventDefault());
    popouts.add(w);
    w.on('closed', () => popouts.delete(w));
    void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(m.html)}`);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', show);
  app.whenReady().then(async () => {
    lockSessions();
    app.setAppUserModelId(APP_ID);
    if (process.platform === 'win32') app.setToastActivatorCLSID(TOAST_CLSID);
    // before any notification: Electron sends them through this shortcut (or makes one of its own)
    ensureStartMenuShortcut(REPO, DATA, coraIcoFile(DATA, coraColor));
    repairLogin();
    // an Electron patch is being installed right now (scripts/update-electron.mjs): this Cora would hold its folder;
    // the installer opens Cora again when it's done
    if (updating()) {
      if (Notification.isSupported()) new Notification({ title: 'Cora is updating', body: 'It opens again by itself in a few seconds.', icon: ICON.app }).show();
      setTimeout(() => app.exit(0), 1200);
      return;
    }
    // an Electron security patch is waiting: install it first (Cora opens again by itself)
    if (installPendingUpdate()) {
      setTimeout(() => app.exit(0), 1200);
      return;
    }
    mkdirSync(DATA, { recursive: true });
    if (!existsSync(CLI)) {
      dialog.showErrorBox('Cora', RT.packaged ? `Cora's server is missing from its install:\n${CLI}\n\nInstall Cora again.` : `Server build not found:\n${CLI}\n\nRun \`npm run build\` in ${REPO}.`);
      app.exit(1);
      return;
    }
    wireIpc();
    updates = startUpdates({
      root: RT.root,
      onReady: (version) => {
        pendingUpdate = version;
        win?.webContents.send('ab:update', version);
        refreshTray();
      },
      log: (m) => console.log(`[cora] ${m}`),
    });
    // View-only app menu: Electron's default Edit menu would also handle Ctrl+V and paste twice into the
    // terminal. Text fields still get native copy/paste on Windows without it.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, ...(DEVTOOLS ? [{ role: 'toggleDevTools' as const }] : []), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      ]),
    );
    tray = new Tray(ICON.tray);
    tray.on('click', toggle);
    if (!globalShortcut.register(HOTKEY, toggle)) console.warn(`[cora] hotkey ${HOTKEY} is taken`);
    // A server that's already up (or a hidden start at login) goes straight to the dashboard; otherwise the
    // window opens at once on the splash, which starts the server and follows it up.
    const warm = await probe(PORT, SERVER.tokenFile);
    if (warm || startHidden) {
      if (!warm) {
        try {
          server = await ensureServer(SERVER);
        } catch (e) {
          dialog.showErrorBox('Cora', `Could not start the Cora server.\n\n${(e as Error).message}`);
          app.exit(1);
          return;
        }
      }
      ready = true;
      createWindow();
      loadDashboard();
    } else {
      createWindow();
      void win!.loadFile(SPLASH, { query: { cora: coraColor } });
    }
    refreshTray();
  });

  // Stay alive in the tray when the window is closed.
  app.on('window-all-closed', () => {});
  app.on('before-quit', (e) => {
    quitting = true;
    if (server?.owned) {
      const s = server;
      server = null;
      e.preventDefault();
      void s.stop(endOnQuit).finally(() => app.quit());
    }
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
