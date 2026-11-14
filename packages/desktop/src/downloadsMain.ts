import { app, ipcMain, shell, type BrowserWindow, type DownloadItem, type WebContents } from 'electron';
import { basename } from 'node:path';
import { freePath, withDownload, type Download } from './downloads';

/**
 * Downloads, wired to Electron (downloads.ts has the rules): each one saved into your Downloads folder without a
 * dialog, the dashboard told as it goes, and its few acts (show in folder, cancel, clear the finished ones).
 */

let win: BrowserWindow | null = null;
let list: Download[] = [];
const items = new Map<string, DownloadItem>();
let n = 0;

const tell = (d: Download) => {
  list = withDownload(list, d);
  if (win && !win.isDestroyed()) win.webContents.send('ab:download', d);
};

let wired = false;
export function setupDownloads(w: BrowserWindow) {
  win = w;
  // (the window made again: the same handlers serve it)
  if (wired) return;
  wired = true;
  const ours = (e: { sender: WebContents }) => !!win && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.handle('ab:downloads', (e) => (ours(e) ? list : []));
  ipcMain.on('ab:download-act', (e, m: { id?: unknown; act?: unknown } | null) => {
    if (!ours(e) || !m) return;
    if (m.act === 'clear') {
      list = list.filter((d) => d.state === 'going');
      return void win!.webContents.send('ab:downloads-cleared');
    }
    const d = list.find((x) => x.id === m.id);
    if (!d) return;
    // (only ever a file this list saved: never a path the dashboard names)
    if (m.act === 'show') shell.showItemInFolder(d.path);
    else if (m.act === 'cancel') items.get(d.id)?.cancel();
  });
}

/** A page started a download (a session's `will-download`). */
export function startDownload(item: DownloadItem, wc?: WebContents) {
  const id = `dl${Date.now().toString(36)}${++n}`;
  const path = freePath(app.getPath('downloads'), item.getFilename());
  item.setSavePath(path);
  let d: Download = { id, name: basename(path), url: item.getURL().slice(0, 300), path, state: 'going', received: 0, total: item.getTotalBytes(), startedAt: Date.now(), ...(wc && !wc.isDestroyed() ? { from: wc.id } : {}) };
  items.set(id, item);
  tell(d);
  let last = 0;
  item.on('updated', () => {
    const now = Date.now();
    if (now - last < 400) return;
    last = now;
    tell((d = { ...d, received: item.getReceivedBytes(), total: item.getTotalBytes() }));
  });
  item.once('done', (_e, state) => {
    items.delete(id);
    tell((d = { ...d, received: item.getReceivedBytes(), total: item.getTotalBytes(), state: state === 'completed' ? 'done' : state === 'cancelled' ? 'cancelled' : 'failed' }));
    if (state === 'completed' && win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
  });
}
