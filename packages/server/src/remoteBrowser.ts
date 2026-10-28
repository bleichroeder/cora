import { randomBytes } from 'node:crypto';

/**
 * A session's browser on your other devices: tabs whose
 * pages the desktop app renders out of sight (with the PC browser's logins), their pictures streamed to the screen
 * that watches, its taps, scrolls and keys sent back. The desktop app does the rendering only while someone watches.
 */
export type RTab = { id: string; sessionId: string; url: string; title: string; at: number; canBack?: boolean; canForward?: boolean; loading?: boolean };
type Sock = { send(d: string): void; close(): void; readyState: number; on(ev: string, fn: (...a: any[]) => void): void };

const KEEP_MS = 60_000;
const MAX_TABS = 24;

export class RemoteBrowser {
  private tabs: RTab[] = [];
  private desktop: Sock | null = null;
  private viewers = new Map<string, Set<Sock>>();
  private size = new Map<string, { w: number; h: number }>();
  private live = new Set<string>();
  private idle = new Map<string, ReturnType<typeof setTimeout>>();
  /** the tabs (or whether the desktop app is here) changed */
  onChange?: () => void;

  get available(): boolean {
    return !!this.desktop && this.desktop.readyState === 1;
  }
  list(): RTab[] {
    return this.tabs.map((t) => ({ ...t }));
  }

  /** A page for a session: a new tab (or the one already at that address). */
  open(sessionId: string, url: string): RTab | null {
    if (!/^https?:\/\//i.test(url)) return null;
    const had = this.tabs.find((t) => t.sessionId === sessionId && t.url === url);
    if (had) return had;
    const t: RTab = { id: randomBytes(5).toString('hex'), sessionId, url, title: url.replace(/^https?:\/\//, '').slice(0, 80), at: Date.now() };
    this.tabs.push(t);
    if (this.tabs.length > MAX_TABS) for (const old of this.tabs.splice(0, this.tabs.length - MAX_TABS)) this.drop(old.id);
    this.onChange?.();
    return t;
  }

  close(id: string): void {
    if (!this.tabs.some((t) => t.id === id)) return;
    this.tabs = this.tabs.filter((t) => t.id !== id);
    this.drop(id);
    this.onChange?.();
  }

  private drop(id: string): void {
    for (const v of this.viewers.get(id) ?? []) v.close();
    this.viewers.delete(id);
    this.stop(id);
  }
  private stop(id: string): void {
    clearTimeout(this.idle.get(id));
    this.idle.delete(id);
    if (this.live.delete(id)) this.toDesktop({ t: 'close', id });
  }
  private toDesktop(m: object): void {
    if (this.desktop?.readyState === 1) this.desktop.send(JSON.stringify(m));
  }

  /** The desktop app's link (one at a time: a new one replaces the old). */
  attachDesktop(sock: Sock): void {
    this.desktop?.close();
    this.desktop = sock;
    this.live.clear();
    // whoever watches now: their pages again
    for (const [id, vs] of this.viewers) if (vs.size) this.start(id);
    sock.on('message', (raw: Buffer | string) => {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      const tab = this.tabs.find((t) => t.id === m.id);
      if (m.t === 'frame' && tab) {
        const out = JSON.stringify({ t: 'frame', data: m.data, w: m.w, h: m.h });
        for (const v of this.viewers.get(m.id) ?? []) if (v.readyState === 1) v.send(out);
      } else if (m.t === 'state' && tab) {
        Object.assign(tab, {
          ...(typeof m.url === 'string' && /^https?:/i.test(m.url) ? { url: m.url } : {}),
          ...(typeof m.title === 'string' && m.title ? { title: m.title.slice(0, 120) } : {}),
          canBack: !!m.canBack,
          canForward: !!m.canForward,
          loading: !!m.loading,
        });
        const out = JSON.stringify({ t: 'state', tab });
        for (const v of this.viewers.get(m.id) ?? []) if (v.readyState === 1) v.send(out);
        this.onChange?.();
      } else if (m.t === 'popup' && tab && typeof m.url === 'string') {
        // a page opening another: a tab of its own
        this.open(tab.sessionId, m.url);
      }
    });
    sock.on('close', () => {
      if (this.desktop !== sock) return;
      this.desktop = null;
      this.live.clear();
      this.onChange?.();
    });
    this.onChange?.();
  }

  /** A screen watching a tab: its pictures to it, its input to the page. */
  attachViewer(sock: Sock, id: string): boolean {
    if (!this.tabs.some((t) => t.id === id)) return false;
    let vs = this.viewers.get(id);
    if (!vs) this.viewers.set(id, (vs = new Set()));
    vs.add(sock);
    clearTimeout(this.idle.get(id));
    sock.on('message', (raw: Buffer | string) => {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.t === 'size' && Number(m.w) > 0 && Number(m.h) > 0) {
        const size = { w: Math.round(Math.min(2400, Math.max(320, m.w))), h: Math.round(Math.min(2000, Math.max(240, m.h))) };
        this.size.set(id, size);
        if (this.live.has(id)) this.toDesktop({ t: 'size', id, ...size });
        else this.start(id);
      } else if (m.t === 'input' && m.ev && typeof m.ev === 'object') this.toDesktop({ t: 'input', id, ev: m.ev });
      else if (m.t === 'nav' && ['back', 'forward', 'reload', 'stop'].includes(m.action)) this.toDesktop({ t: 'nav', id, action: m.action });
      else if (m.t === 'go' && typeof m.url === 'string' && /^https?:\/\//i.test(m.url)) this.toDesktop({ t: 'go', id, url: m.url });
    });
    sock.on('close', () => {
      vs!.delete(sock);
      // nobody watching for a while: the desktop app lets the page go
      if (!vs!.size) this.idle.set(id, setTimeout(() => this.stop(id), KEEP_MS));
    });
    return true;
  }

  private start(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    const size = this.size.get(id);
    if (!tab || !size || this.live.has(id) || !this.available) return;
    this.live.add(id);
    this.toDesktop({ t: 'open', id, url: tab.url, ...size });
  }
}
