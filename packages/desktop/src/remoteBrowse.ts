import { BrowserWindow, type NativeImage } from 'electron';
import { readFileSync } from 'node:fs';
import { WEB_PARTITION, webSession } from './browser';

/**
 * A session's browser on your other devices: when a
 * remote screen (the iPad) watches a tab, Cora's server asks for its page here; it's rendered out of sight (never a
 * window on this PC's screen) with the PC browser's logins, its picture sent back a few times a second, the screen's
 * taps, scrolls and keys put into it. Nothing here runs unless a remote screen asks; the PC's own browser is untouched.
 */
type Cmd =
  | { t: 'open'; id: string; url: string; w: number; h: number }
  | { t: 'size'; id: string; w: number; h: number }
  | { t: 'close'; id: string }
  | { t: 'nav'; id: string; action: 'back' | 'forward' | 'reload' | 'stop' }
  | { t: 'go'; id: string; url: string }
  | { t: 'input'; id: string; ev: Record<string, unknown> };

const FRAME_MS = 180;

export function startRemoteBrowse(o: { base: string; tokenFile: string }): () => void {
  const pages = new Map<string, { win: BrowserWindow; last: NativeImage | null; timer: ReturnType<typeof setTimeout> | null }>();
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const send = (m: object) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  const state = (id: string) => {
    const p = pages.get(id);
    if (!p || p.win.isDestroyed()) return;
    const wc = p.win.webContents;
    send({ t: 'state', id, url: wc.getURL(), title: wc.getTitle(), canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward(), loading: wc.isLoading() });
  };
  const open = (c: Extract<Cmd, { t: 'open' }>) => {
    if (pages.has(c.id) || !/^https?:\/\//i.test(c.url)) return;
    webSession(WEB_PARTITION);
    const win = new BrowserWindow({ show: false, width: c.w, height: c.h, webPreferences: { offscreen: true, partition: WEB_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const p = { win, last: null as NativeImage | null, timer: null as ReturnType<typeof setTimeout> | null };
    pages.set(c.id, p);
    const wc = win.webContents;
    wc.setFrameRate(12);
    // its picture: the newest one, a few times a second
    wc.on('paint', (_e, _dirty, image) => {
      p.last = image;
      p.timer ??= setTimeout(() => {
        p.timer = null;
        if (!p.last || win.isDestroyed()) return;
        const size = p.last.getSize();
        send({ t: 'frame', id: c.id, data: p.last.toJPEG(62).toString('base64'), w: size.width, h: size.height });
      }, FRAME_MS);
    });
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) wc.on(ev as never, () => state(c.id));
    // a page opening another: a tab of its own on the remote screen (never a window here)
    wc.setWindowOpenHandler(({ url }) => (/^https?:\/\//i.test(url) && send({ t: 'popup', id: c.id, url }), { action: 'deny' }));
    void win.loadURL(c.url).catch(() => {});
  };
  const close = (id: string) => {
    const p = pages.get(id);
    pages.delete(id);
    if (p && !p.win.isDestroyed()) p.win.destroy();
  };
  const input = (id: string, ev: Record<string, unknown>) => {
    const p = pages.get(id);
    if (!p || p.win.isDestroyed()) return;
    const wc = p.win.webContents;
    const x = Math.round(Number(ev.x) || 0);
    const y = Math.round(Number(ev.y) || 0);
    const mods = (Array.isArray(ev.mods) ? ev.mods : []).filter((m): m is 'shift' | 'control' | 'alt' | 'meta' => ['shift', 'control', 'alt', 'meta'].includes(String(m)));
    if (ev.type === 'tap') {
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    } else if (ev.type === 'move') wc.sendInputEvent({ type: 'mouseMove', x, y });
    else if (ev.type === 'wheel') wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -(Number(ev.dx) || 0), deltaY: -(Number(ev.dy) || 0), canScroll: true } as Electron.MouseWheelInputEvent);
    else if (ev.type === 'text' && typeof ev.text === 'string') for (const ch of ev.text.slice(0, 500)) wc.sendInputEvent({ type: 'char', keyCode: ch });
    else if (ev.type === 'key' && typeof ev.key === 'string') {
      const key = KEYS[ev.key] ?? (ev.key.length === 1 ? ev.key : null);
      if (!key) return;
      wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods });
      if (ev.key.length === 1 && !mods.some((m) => m === 'control' || m === 'meta' || m === 'alt')) wc.sendInputEvent({ type: 'char', keyCode: ev.key, modifiers: mods });
      wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods });
    }
  };
  const onCmd = (c: Cmd) => {
    if (c.t === 'open') open(c);
    else if (c.t === 'close') close(c.id);
    else if (c.t === 'size') pages.get(c.id)?.win.setSize(Math.round(c.w), Math.round(c.h));
    else if (c.t === 'input') input(c.id, c.ev);
    else if (c.t === 'go') void pages.get(c.id)?.win.loadURL(c.url).catch(() => {});
    else if (c.t === 'nav') {
      const wc = pages.get(c.id)?.win.webContents;
      if (!wc) return;
      if (c.action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else if (c.action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      else if (c.action === 'reload') wc.reload();
      else if (c.action === 'stop') wc.stop();
    }
  };

  const connect = () => {
    if (stopped) return;
    let key = '';
    try {
      key = readFileSync(o.tokenFile, 'utf8').trim();
    } catch {
      retry = setTimeout(connect, 5000);
      return;
    }
    const sock = new WebSocket(`${o.base.replace(/^http/, 'ws')}/api/local/browse?key=${encodeURIComponent(key)}`);
    ws = sock;
    sock.onmessage = (m) => {
      try {
        onCmd(JSON.parse(String(m.data)) as Cmd);
      } catch {
        /* not one of ours */
      }
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      // the server went (a restart): the pages too; it asks again when it's back
      for (const id of [...pages.keys()]) close(id);
      if (!stopped) retry = setTimeout(connect, 5000);
    };
    sock.onerror = () => {};
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    ws?.close();
    for (const id of [...pages.keys()]) close(id);
  };
}

/** The remote screen's key names, as Electron's input events name them. */
const KEYS: Record<string, string> = { Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space' };
