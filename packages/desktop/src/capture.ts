import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import { join } from 'node:path';

/**
 * Quick capture (Ctrl+Alt+N from anywhere in Windows): a small frameless window at the top centre of the screen the
 * pointer is on, showing Cora's client in capture mode (just the jot box). Made once and kept hidden; clicking away
 * or Esc hides it, and the text in it stays for next time.
 */
export const CAPTURE_HOTKEY = 'Control+Alt+N';
const W = 560;
const H = 250;

let hide: () => void = () => {};
/** Lockdown: the capture window goes away (and doesn't come while locked). */
export const hideCapture = () => hide();

export function setupCapture(base: string, allowed: () => boolean = () => true): void {
  let w: BrowserWindow | null = null;
  hide = () => w?.hide();
  const make = () => {
    w = new BrowserWindow({
      width: W,
      height: H,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      title: 'Jot',
      backgroundColor: '#00000000',
      webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged || process.env.CORA_DEVTOOLS === '1' },
    });
    w.setAlwaysOnTop(true, 'floating');
    w.on('blur', () => w?.hide());
    w.on('closed', () => (w = null));
    // stays on the capture page: anything else (a link) is refused
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    void w.loadURL(`${base}/?capture=1`);
  };
  const show = () => {
    if (!w) make();
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    w!.setBounds({ x: Math.round(d.x + (d.width - W) / 2), y: d.y + Math.round(d.height * 0.12), width: W, height: H });
    w!.show();
    w!.focus();
    w!.webContents.send('ab:capture-shown');
  };
  const toggle = () => (w?.isVisible() ? w.hide() : allowed() ? show() : undefined);
  ipcMain.on('ab:capture-hide', (e) => {
    if (w && e.sender === w.webContents) w.hide();
  });
  if (!globalShortcut.register(CAPTURE_HOTKEY, toggle)) console.warn(`[cora] hotkey ${CAPTURE_HOTKEY} is taken`);
}
