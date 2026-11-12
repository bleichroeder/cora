/**
 * A Chrome DevTools Protocol relay: Playwright (a session's Playwright MCP, connected over CDP) drives tabs of Cora's
 * own browser. Playwright speaks to a whole browser; Cora's tabs are <webview>s in its window, each with a debugger of
 * its own (webContents.debugger). So the relay plays the browser: it answers the browser-level messages itself
 * (Browser.getVersion, Target.setAutoAttach, Target.createTarget…) and passes each page's messages to that tab's
 * debugger, and its events back. Playwright sees only the tabs it's given: never Cora's window, never other tabs.
 *
 * Transport-free (a message in, messages out) so it can be tested without Electron.
 */

import type { CdpKey } from './cdpKeys';

/** One tab Playwright may drive. */
export type RelayTab = {
  /** Cora's id for the tab */
  id: string;
  /** the tab whose page opened it (a popup) */
  opener?: string;
  url(): string;
  title(): string;
  /** A command to the tab's page (or, with a sessionId, to a frame or worker inside it). */
  send(method: string, params?: object, sessionId?: string): Promise<unknown>;
  /** Its page's events (and its frames' and workers', with their sessionId). Returns an unsubscribe. */
  onEvent(cb: (method: string, params: unknown, sessionId?: string) => void): () => void;
  /**
   * Typing into it another way, when CDP's keys can't reach it (a <webview>: they only reach a focused page). Given,
   * Input.insertText and Input.dispatchKeyEvent go here instead.
   */
  input?: { text(text: string): Promise<void>; key(p: CdpKey): void };
  /** Where it sits on screen, in CSS pixels: what Playwright is told is its window. */
  bounds(): { left: number; top: number; width: number; height: number };
};

/** What the relay may see and do in Cora's browser, for one session. */
export type RelayHost = {
  /** The tabs this connection may drive (the session's agent tabs) */
  tabs(): RelayTab[];
  /** Call back when that list changes (a tab opened, closed). Returns an unsubscribe. */
  onTabsChanged(cb: () => void): () => void;
  /** Open a tab (Playwright's newPage, or a page's window.open): resolves once its page can be driven. */
  open(url: string): Promise<RelayTab>;
  close(id: string): Promise<void>;
  /** Show it (Target.activateTarget). */
  activate?(id: string): void;
  /** Playwright let go of it: undo what it set on the page (its scripts, overrides, interceptions). */
  release(tab: RelayTab): void;
  version(): { product: string; userAgent: string };
};

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };
type Attached = { tab: RelayTab; targetId: string; sessionId: string; off: () => void };

const CONTEXT = 'cora-browser';
const NOT_HERE = (what: string) => `${what} isn't available in Cora's browser`;

export class CdpRelay {
  private auto = false;
  private closed = false;
  /** each tab attached (by Cora's tab id) */
  private attached = new Map<string, Attached>();
  /** the session Playwright uses for each attached page */
  private bySession = new Map<string, Attached>();
  /** frames' and workers' sessions inside a page: which tab they belong to */
  private children = new Map<string, Attached>();
  private offTabs: () => void;
  /** tabs being attached (so a tab isn't attached twice while its target id is asked for) */
  private attaching = new Map<string, Promise<Attached | null>>();

  constructor(
    private host: RelayHost,
    private out: (msg: string) => void,
  ) {
    this.offTabs = host.onTabsChanged(() => void this.sync());
  }

  /** A message from Playwright. */
  handle(raw: string): void {
    let m: Msg;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof m.id !== 'number' || typeof m.method !== 'string') return;
    void this.dispatch(m as Required<Pick<Msg, 'id' | 'method'>> & Msg).then(
      (result) => this.reply(m, { result: result ?? {} }),
      (e: unknown) => this.reply(m, { error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }),
    );
  }

  /** Playwright went: let go of every tab. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.offTabs();
    for (const a of this.attached.values()) this.detach(a, false);
  }

  private reply(m: Msg, body: object) {
    if (this.closed) return;
    this.out(JSON.stringify({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), ...body }));
  }
  private emit(method: string, params: unknown, sessionId?: string) {
    if (this.closed) return;
    this.out(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  }

  private async dispatch(m: Msg & { id: number; method: string }): Promise<unknown> {
    const p = m.params ?? {};
    if (m.sessionId) return this.page(m.sessionId, m.method, p);
    switch (m.method) {
      case 'Browser.getVersion': {
        const v = this.host.version();
        return { protocolVersion: '1.3', product: v.product, revision: '', userAgent: v.userAgent, jsVersion: '' };
      }
      case 'Target.setAutoAttach':
        this.auto = !!p.autoAttach;
        if (this.auto) await this.sync();
        return {};
      case 'Target.setDiscoverTargets':
        return {};
      case 'Target.getTargetInfo':
        if (typeof p.targetId === 'string' && p.targetId !== 'browser') {
          const a = [...this.attached.values()].find((x) => x.targetId === p.targetId);
          if (!a) throw new Error('No target with given id found');
          return { targetInfo: this.info(a) };
        }
        return { targetInfo: { targetId: 'browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
      case 'Target.getTargets':
        return { targetInfos: [...this.attached.values()].map((a) => this.info(a)) };
      case 'Target.getBrowserContexts':
        return { browserContextIds: [] };
      case 'Target.attachToTarget': {
        const a = [...this.attached.values()].find((x) => x.targetId === p.targetId);
        if (!a) throw new Error('No target with given id found');
        return { sessionId: a.sessionId };
      }
      case 'Target.detachFromTarget':
        // (Playwright lets go of targets it doesn't drive; the relay only hands it pages)
        return {};
      case 'Target.createTarget': {
        const url = typeof p.url === 'string' && p.url ? p.url : 'about:blank';
        const tab = await this.host.open(url);
        const a = await this.attach(tab);
        if (!a) throw new Error("The new tab couldn't be driven");
        return { targetId: a.targetId };
      }
      case 'Target.closeTarget': {
        const a = [...this.attached.values()].find((x) => x.targetId === p.targetId);
        if (!a) return { success: false };
        await this.host.close(a.tab.id);
        return { success: true };
      }
      case 'Target.activateTarget': {
        const a = [...this.attached.values()].find((x) => x.targetId === p.targetId);
        if (a) this.host.activate?.(a.tab.id);
        return {};
      }
      case 'Target.createBrowserContext':
        throw new Error(`${NOT_HERE('A separate browser context')}: its tabs share a browser profile's logins (an isolated Playwright needs its own browser)`);
      case 'Target.disposeBrowserContext':
        return {};
      // Cora's browser downloads as it does for you, and keeps its own permissions
      case 'Browser.setDownloadBehavior':
      case 'Browser.grantPermissions':
      case 'Browser.resetPermissions':
      case 'Browser.cancelDownload':
        return {};
      case 'Browser.close':
        // never Cora: Playwright just goes
        return {};
      case 'Storage.getCookies': {
        const t = this.anyTab();
        return t ? { cookies: ((await t.send('Network.getAllCookies')) as { cookies?: unknown[] }).cookies ?? [] } : { cookies: [] };
      }
      case 'Storage.setCookies': {
        const t = this.anyTab();
        if (!t) throw new Error('Open a page first');
        await t.send('Network.setCookies', { cookies: p.cookies ?? [] });
        return {};
      }
      case 'Storage.clearCookies': {
        const t = this.anyTab();
        if (t) await t.send('Network.clearBrowserCookies');
        return {};
      }
      default:
        throw new Error(`'${m.method}' ${NOT_HERE('this')}`);
    }
  }

  /** A message to a page (or a frame or worker in one). */
  private async page(sessionId: string, method: string, p: Record<string, unknown>): Promise<unknown> {
    const top = this.bySession.get(sessionId);
    const child = top ? undefined : this.children.get(sessionId);
    const a = top ?? child;
    if (!a) throw new Error(`Session with given id not found: ${sessionId}`);
    // its "window" is the tab: where it is, and it can't be moved or resized from here
    if (top) {
      const b = () => ({ ...a.tab.bounds(), windowState: 'normal' });
      if (method === 'Browser.getWindowForTarget') return { windowId: 1, bounds: b() };
      if (method === 'Browser.getWindowBounds') return { bounds: b() };
      if (method === 'Browser.setWindowBounds') return {};
    }
    // its keyboard, the way the page can take it
    const input = a.tab.input;
    if (input && method === 'Input.insertText') return input.text(String(p.text ?? '')).then(() => ({}));
    if (input && method === 'Input.dispatchKeyEvent') return input.key(p as unknown as CdpKey), {};
    return a.tab.send(method, p, child ? sessionId : undefined);
  }

  private anyTab(): RelayTab | undefined {
    return this.attached.values().next().value?.tab;
  }

  private info(a: Attached) {
    const opener = a.tab.opener ? this.attached.get(a.tab.opener)?.targetId : undefined;
    return { targetId: a.targetId, type: 'page', title: a.tab.title(), url: a.tab.url(), attached: true, canAccessOpener: !!opener, ...(opener ? { openerId: opener } : {}), browserContextId: CONTEXT };
  }

  /** The tab list changed: attach the new ones (once auto-attach is on), let go of the gone ones. */
  private async sync(): Promise<void> {
    if (this.closed) return;
    const now = this.host.tabs();
    const ids = new Set(now.map((t) => t.id));
    for (const a of [...this.attached.values()]) if (!ids.has(a.tab.id)) this.detach(a, true);
    if (!this.auto) return;
    await Promise.all(now.map((t) => this.attach(t)));
  }

  private attach(tab: RelayTab): Promise<Attached | null> {
    const had = this.attached.get(tab.id);
    if (had) return Promise.resolve(had);
    const busy = this.attaching.get(tab.id);
    if (busy) return busy;
    const go = (async () => {
      // its id: its main frame's (what Chrome's page target id is, and Playwright takes its main frame by it). Not
      // Target.getTargetInfo: through a webview's debugger every tab answers with the same one.
      let targetId = '';
      try {
        const r = (await tab.send('Page.getFrameTree')) as { frameTree?: { frame?: { id?: string } } };
        targetId = r.frameTree?.frame?.id ?? '';
      } catch {
        /* not a page yet: Cora's id stands in */
      }
      if (this.closed || !this.host.tabs().some((t) => t.id === tab.id)) return null;
      // (never two the same: a duplicate would close or drive the wrong tab)
      if (!targetId || [...this.attached.values()].some((x) => x.targetId === targetId)) targetId = `cora-${tab.id}`;
      const sessionId = `cora-${tab.id}`;
      const a: Attached = { tab, targetId, sessionId, off: () => {} };
      a.off = tab.onEvent((method, params, child) => this.event(a, method, params, child));
      this.attached.set(tab.id, a);
      this.bySession.set(sessionId, a);
      if (this.auto) this.emit('Target.attachedToTarget', { sessionId, targetInfo: this.info(a), waitingForDebugger: false });
      return a;
    })().finally(() => this.attaching.delete(tab.id));
    this.attaching.set(tab.id, go);
    return go;
  }

  private event(a: Attached, method: string, params: unknown, child?: string) {
    if (method === 'Target.attachedToTarget') {
      const s = (params as { sessionId?: string })?.sessionId;
      if (s) this.children.set(s, a);
    } else if (method === 'Target.detachedFromTarget') {
      const s = (params as { sessionId?: string })?.sessionId;
      if (s) this.children.delete(s);
    }
    this.emit(method, params, child ?? a.sessionId);
  }

  private detach(a: Attached, tell: boolean) {
    a.off();
    this.attached.delete(a.tab.id);
    this.bySession.delete(a.sessionId);
    for (const [s, x] of this.children) if (x === a) this.children.delete(s);
    if (tell) {
      this.emit('Target.detachedFromTarget', { sessionId: a.sessionId, targetId: a.targetId });
      this.emit('Target.targetDestroyed', { targetId: a.targetId });
    }
    this.host.release(a.tab);
  }
}
