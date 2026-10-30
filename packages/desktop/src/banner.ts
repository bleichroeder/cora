import { BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { encodeGif, type GifFrame } from '@cora/shared';

/**
 * Cora's Slack banner: when you send a message Cora drafted,
 * the server asks here for its banner. Cora's own banner page (`/?banner=1`) is opened out of sight (never a window on
 * your screen, in a session of its own), a couple of seconds of it recorded once it says it's ready, played forward and
 * back so it loops without a jump, and the GIF sent back. Anything going wrong sends back nothing: the message goes
 * without it. It also draws a debrief video's slides (below).
 */
type Cmd = { t: 'render'; id: string; q: Record<string, string> } | { t: 'slides'; id: string; slides: unknown[]; color?: string };

/** the banner as Slack shows it: its page drawn at 480×120, scaled to this (banner-page zoom in slackBanner.css) */
const W = 420;
const H = 105;
/** pixel for pixel: Slack shows a picture at its size in pixels (up to a width), whatever the screen */
const SCALE = 1;
const FRAMES = 26;
const EVERY_MS = 70;
const GIVE_UP_MS = 15_000;
/** a 1920×1080 slide's PNG smaller than this is a frame with nothing on it yet */
const BLANK_PNG = 16_000;
/** a moving slide is recorded at this many frames a second */
const REC_FPS = 24;

export function startBanner(o: { base: string; tokenFile: string; /** Cora's colour, as you chose it */ color: () => string }): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const send = (m: object) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  const render = (c: Extract<Cmd, { t: 'render' }>) => {
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
    // what it made, or why not (the server's log says it)
    const finish = (data: string | null, why = 'it failed') => {
      if (over) return;
      over = true;
      clearInterval(timer);
      clearTimeout(giveUp);
      if (!win.isDestroyed()) win.destroy();
      send(data ? { t: 'gif', id: c.id, data } : { t: 'gif', id: c.id, error: why });
    };
    const giveUp = setTimeout(() => finish(null, last ? `its page never said it was drawn in ${GIVE_UP_MS / 1000} s` : `nothing drew in ${GIVE_UP_MS / 1000} s (graphics unavailable?)`), GIVE_UP_MS);
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
        } catch (e) {
          finish(null, `making the GIF failed: ${(e as Error).message}`);
        }
      }, EVERY_MS);
    });
    wc.on('render-process-gone', (_e, d) => finish(null, `its page crashed (${d.reason})`));
    const u = new URL(o.base);
    u.searchParams.set('banner', '1');
    u.searchParams.set('color', o.color());
    for (const [k, v] of Object.entries(c.q ?? {})) if (typeof v === 'string') u.searchParams.set(k, v);
    void win.loadURL(u.toString()).catch((e: Error) => finish(null, `its page didn't load: ${e.message}`));
  };

  /**
   * A debrief video's slides: Cora's slides page out of
   * sight at 1920×1080; each slide put on it (the page fits it and says when it's drawn), its picture sent back.
   */
  const slides = async (c: { id: string; slides: unknown[]; color?: string }) => {
    const win = new BrowserWindow({ show: false, width: 1920, height: 1080, frame: false, backgroundColor: '#0b0e14', webPreferences: { offscreen: { deviceScaleFactor: 1 }, partition: 'cora-banner', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const wc = win.webContents;
    let paint: ((img: Electron.NativeImage) => void) | null = null;
    wc.setFrameRate(30);
    wc.on('paint', (_e, _d, image) => {
      const p = paint;
      paint = null;
      p?.(image);
    });
    const nextPaint = () => new Promise<Electron.NativeImage>((res, rej) => {
      const t = setTimeout(() => rej(new Error('a slide never drew')), 8000);
      paint = (img) => (clearTimeout(t), res(img));
      wc.invalidate();
    });
    try {
      const ready = new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error("the slides page didn't load")), 20_000);
        wc.on('page-title-updated', (_e, title) => title === 'slides-ready' && (clearTimeout(t), res()));
        wc.on('render-process-gone', () => rej(new Error('the slides page crashed')));
      });
      const u = new URL(o.base);
      u.searchParams.set('slides', '1');
      u.searchParams.set('color', c.color && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : o.color());
      await win.loadURL(u.toString());
      await ready;
      for (let i = 0; i < c.slides.length; i++) {
        await wc.executeJavaScript(`window.coraSlide(${JSON.stringify(c.slides[i])})`, true);
        // a frame or two after it's laid out, so what's captured is what's there; a picture that's next to empty (a frame
        // from before the slide reached the window) is taken again
        await nextPaint();
        let png = (await nextPaint()).toPNG();
        for (let tries = 0; png.length < BLANK_PNG && tries < 6; tries++) {
          await new Promise((r) => setTimeout(r, 250));
          png = (await nextPaint()).toPNG();
        }
        const rec = Number((c.slides[i] as { record?: unknown }).record) || 0;
        if (!rec) {
          send({ t: 'slide', id: c.id, i, data: png.toString('base64') });
          continue;
        }
        // one that moves (the title's orb): a couple of seconds of it, frame by frame, at an even pace
        const of = Math.min(120, rec);
        for (let k = 0; k < of; k++) {
          const at = Date.now();
          const img = k ? await nextPaint() : null;
          send({ t: 'slide', id: c.id, i, k, of, data: (img ? img.toJPEG(92) : png).toString('base64') });
          await new Promise((r) => setTimeout(r, Math.max(0, 1000 / REC_FPS - (Date.now() - at))));
        }
      }
      send({ t: 'slides-done', id: c.id });
    } catch (e) {
      send({ t: 'slides-done', id: c.id, error: (e as Error).message });
    } finally {
      if (!win.isDestroyed()) win.destroy();
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
    const sock = new WebSocket(`${o.base.replace(/^http/, 'ws')}/api/local/banner?key=${encodeURIComponent(key)}`);
    ws = sock;
    sock.onmessage = (m) => {
      try {
        const c = JSON.parse(String(m.data)) as Cmd;
        if (c.t === 'render' && typeof c.id === 'string') render(c);
        else if (c.t === 'slides' && typeof c.id === 'string' && Array.isArray(c.slides)) void slides(c);
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
