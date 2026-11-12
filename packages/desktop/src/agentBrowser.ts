import { app, ipcMain, webContents, type BrowserWindow, type WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import { CdpRelay, type RelayHost, type RelayTab } from './cdpRelay';
import { chromeIdentity } from './chromeIdentity';
import { electronKeys } from './cdpKeys';

/**
 * A session's Playwright in Cora's browser (the server's side: server/src/cdpBridge.ts). The server passes each
 * Playwright connection here over one link; each gets a relay (cdpRelay.ts) that drives the session's agent tabs.
 * The tabs themselves are the window's (its Playwright tabs, client/src/components/AgentPages.tsx): it says which
 * there are and their pages (`ab:agent-tabs`), and opens and closes them when asked (`ab:agent-open`, `ab:agent-close`).
 */

/** One of the window's agent tabs, as it reports them. */
export type AgentTab = { tabId: string; sessionId: string; wcId: number; url: string; title: string; w: number; h: number; req?: string; /** the tab whose page opened it */ opener?: string };

type Link = { send(m: object): void };

const OPEN_WAIT_MS = 20_000;

export function startAgentBrowser(o: { base: string; tokenFile: string; win: BrowserWindow }): () => void {
  let tabs: AgentTab[] = [];
  const listeners = new Set<() => void>();
  const waiting = new Map<string, (t: AgentTab | null) => void>();
  /** how many relays drive each page (it's let go of when the last one goes) */
  const holders = new Map<number, number>();
  let seq = 0;

  const onTabs = (_e: Electron.IpcMainEvent, list: unknown) => {
    if (_e.sender !== o.win.webContents || !Array.isArray(list)) return;
    tabs = list.filter((t): t is AgentTab => !!t && typeof t.tabId === 'string' && typeof t.sessionId === 'string' && Number.isInteger(t.wcId) && t.wcId > 0);
    for (const t of tabs) if (t.req && waiting.has(t.req)) (waiting.get(t.req)!(t), waiting.delete(t.req));
    for (const f of listeners) f();
  };
  ipcMain.on('ab:agent-tabs', onTabs);

  const toWin = (channel: string, m: object) => !o.win.isDestroyed() && o.win.webContents.send(channel, m);

  const page = (wcId: number): WebContents | null => {
    const wc = webContents.fromId(wcId);
    return wc && !wc.isDestroyed() ? wc : null;
  };

  const relayTab = (t: AgentTab): RelayTab => ({
    id: t.tabId,
    opener: t.opener,
    url: () => tabs.find((x) => x.tabId === t.tabId)?.url ?? t.url,
    title: () => tabs.find((x) => x.tabId === t.tabId)?.title ?? t.title,
    bounds: () => {
      const x = tabs.find((y) => y.tabId === t.tabId) ?? t;
      return { left: 0, top: 0, width: x.w || 1280, height: x.h || 800 };
    },
    send: async (method, params, sessionId) => {
      const wc = page(t.wcId);
      if (!wc) throw new Error('Target closed');
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      return wc.debugger.sendCommand(method, params as Record<string, unknown> | undefined, sessionId);
    },
    // CDP's keys don't reach a webview's page (only a focused one): Electron's own input does, without taking focus
    input: {
      text: async (text) => void (await page(t.wcId)?.insertText(text)),
      key: (p) => {
        const wc = page(t.wcId);
        if (wc) for (const e of electronKeys(p)) wc.sendInputEvent(e as Electron.KeyboardInputEvent);
      },
    },
    onEvent: (cb) => {
      const wc = page(t.wcId);
      if (!wc) return () => {};
      const h = (_e: Electron.Event, method: string, params: unknown, sessionId?: string) => cb(method, params, sessionId || undefined);
      wc.debugger.on('message', h);
      holders.set(t.wcId, (holders.get(t.wcId) ?? 0) + 1);
      return () => wc.isDestroyed() || wc.debugger.removeListener('message', h);
    },
  });

  const host = (sessionId: string): RelayHost => ({
    tabs: () => tabs.filter((t) => t.sessionId === sessionId).map(relayTab),
    onTabsChanged: (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    open: (url) =>
      new Promise((resolve, reject) => {
        const req = `r${(++seq).toString(36)}`;
        const timer = setTimeout(() => (waiting.delete(req), reject(new Error("Cora's browser didn't open the tab (is Cora's window open?)"))), OPEN_WAIT_MS);
        waiting.set(req, (t) => (clearTimeout(timer), t ? resolve(relayTab(t)) : reject(new Error('The tab closed'))));
        toWin('ab:agent-open', { req, sessionId, url });
      }),
    close: async (id) => void toWin('ab:agent-close', { tabId: id }),
    activate: (id) => void toWin('ab:agent-activate', { tabId: id }),
    release: (tab) => {
      const t = tabs.find((x) => x.tabId === tab.id);
      if (!t) return;
      const n = (holders.get(t.wcId) ?? 1) - 1;
      if (n > 0) return void holders.set(t.wcId, n);
      holders.delete(t.wcId);
      // what Playwright set on the page (its scripts, overrides, interceptions) goes with its debugger session; then
      // the page's Chrome identity again (chromeIdentity's own session)
      const wc = page(t.wcId);
      if (!wc) return;
      try {
        if (wc.debugger.isAttached()) wc.debugger.detach();
      } catch {
        /* already gone */
      }
      chromeIdentity(wc);
    },
    version: () => ({ product: `Chrome/${process.versions.chrome}`, userAgent: app.userAgentFallback }),
  });

  // the server's link: one relay per Playwright connection
  const relays = new Map<string, CdpRelay>();
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const dropAll = () => {
    for (const r of relays.values()) r.close();
    relays.clear();
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
    const sock = new WebSocket(`${o.base.replace(/^http/, 'ws')}/api/local/agent-browser?key=${encodeURIComponent(key)}`);
    ws = sock;
    const link: Link = { send: (m) => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify(m)) };
    sock.onmessage = (ev) => {
      let m: { t: string; c: string; sid?: string; d?: string };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.t === 'open' && m.sid && /^[\w-]{8,80}$/.test(m.sid)) {
        const c = m.c;
        relays.get(c)?.close();
        relays.set(c, new CdpRelay(host(m.sid), (d) => link.send({ t: 'msg', c, d })));
      } else if (m.t === 'msg' && typeof m.d === 'string') relays.get(m.c)?.handle(m.d);
      else if (m.t === 'close') {
        relays.get(m.c)?.close();
        relays.delete(m.c);
      }
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      dropAll();
      if (!stopped) retry = setTimeout(connect, 5000);
    };
    sock.onerror = () => {};
  };
  connect();

  return () => {
    stopped = true;
    clearTimeout(retry);
    ws?.close();
    dropAll();
    ipcMain.removeListener('ab:agent-tabs', onTabs);
  };
}
