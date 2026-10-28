import { BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { encodeGif, type GifFrame } from '@cora/shared';

/**
 * Cora's Slack banner: when you send a message Cora drafted,
 * the server asks here for its banner. Cora's own banner page (`/?banner=1`) is opened out of sight (never a window on
 * your screen, in a session of its own), a couple of seconds of it recorded once it says it's ready, played forward and
 * back so it loops without a jump, and the GIF sent back. Anything going wrong sends back nothing: the message goes
 * without it.
 */
type Cmd = { t: 'render'; id: string; q: Record<string, string> };

const W = 480;
const H = 120;
/** pixel for pixel: Slack shows a picture at its size in pixels (up to a width), whatever the screen */
const SCALE = 1;
const FRAMES = 26;
const EVERY_MS = 70;
const GIVE_UP_MS = 15_000;

export function startBanner(o: { base: string; tokenFile: string; /** Cora's colour, as you chose it */ color: () => string }): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const send = (m: object) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  const render = (c: Cmd) => {
    const win = new BrowserWindow({
      show: false,
      width: W,
      height: H,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: { deviceScaleFactor: SCALE }, partition: 'cora-banner', sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const wc = win.webContents;
    let last: Electron.NativeImage | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const frames: GifFrame[] = [];
    let size = { width: 0, height: 0 };
    let over = false;
    const finish = (data: string | null) => {
      if (over) return;
      over = true;
      clearInterval(timer);
      clearTimeout(giveUp);
      if (!win.isDestroyed()) win.destroy();
      send(data ? { t: 'gif', id: c.id, data } : { t: 'gif', id: c.id, error: true });
    };
    const giveUp = setTimeout(() => finish(null), GIVE_UP_MS);
    wc.setFrameRate(30);
    wc.on('paint', (_e, _dirty, image) => void (last = image));
    wc.on('page-title-updated', (_e, title) => {
      if (title !== 'ready' || timer) return;
      timer = setInterval(() => {
        if (!last || over) return;
        const s = last.getSize();
        if (!frames.length) size = s;
        if (s.width !== size.width || s.height !== size.height) return;
        frames.push({ data: last.toBitmap(), order: process.platform === 'darwin' ? 'rgba' : 'bgra' });
        if (frames.length < FRAMES) return;
        clearInterval(timer);
        try {
          // forward, then back: it loops without a jump
          const all = [...frames, ...frames.slice(1, -1).reverse()];
          const gif = encodeGif(all, { width: size.width, height: size.height, delayCs: EVERY_MS / 10 });
          finish(Buffer.from(gif).toString('base64'));
        } catch {
          finish(null);
        }
      }, EVERY_MS);
    });
    wc.on('render-process-gone', () => finish(null));
    const u = new URL(o.base);
    u.searchParams.set('banner', '1');
    u.searchParams.set('color', o.color());
    for (const [k, v] of Object.entries(c.q ?? {})) if (typeof v === 'string') u.searchParams.set(k, v);
    void win.loadURL(u.toString()).catch(() => finish(null));
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
    const sock = new WebSocket(`${o.base.replace(/^http/, 'ws')}/api/local/banner?key=${encodeURIComponent(key)}`);
    ws = sock;
    sock.onmessage = (m) => {
      try {
        const c = JSON.parse(String(m.data)) as Cmd;
        if (c.t === 'render' && typeof c.id === 'string') render(c);
      } catch {
        /* not one of ours */
      }
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (!stopped) retry = setTimeout(connect, 5000);
    };
    sock.onerror = () => {};
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    ws?.close();
  };
}
