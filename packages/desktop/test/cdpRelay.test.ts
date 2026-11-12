import { describe, expect, it } from 'vitest';
import { CdpRelay, type RelayHost, type RelayTab } from '../src/cdpRelay';

/** A tab whose page answers commands from a table, and can fire events (its own and a frame's). */
function fakeTab(id: string, url = 'https://example.com/') {
  const sent: Array<{ method: string; params?: object; sessionId?: string }> = [];
  const subs = new Set<(m: string, p: unknown, s?: string) => void>();
  const tab: RelayTab & { sent: typeof sent; fire(m: string, p: unknown, s?: string): void; subs: typeof subs } = {
    id,
    url: () => url,
    title: () => `title of ${id}`,
    bounds: () => ({ left: 0, top: 0, width: 900, height: 600 }),
    sent,
    subs,
    send: async (method, params, sessionId) => {
      sent.push({ method, params, sessionId });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `T-${id}` } } };
      if (method === 'Runtime.evaluate') return { result: { value: 2 } };
      if (method === 'Page.crash') throw new Error('nope');
      return {};
    },
    onEvent: (cb) => (subs.add(cb), () => void subs.delete(cb)),
    fire: (m, p, s) => subs.forEach((f) => f(m, p, s)),
  };
  return tab;
}

function rig(initial: ReturnType<typeof fakeTab>[] = [fakeTab('a')]) {
  let tabs = [...initial];
  const changed = new Set<() => void>();
  const released: string[] = [];
  const opened: string[] = [];
  const host: RelayHost = {
    tabs: () => tabs,
    onTabsChanged: (cb) => (changed.add(cb), () => void changed.delete(cb)),
    open: async (url) => {
      opened.push(url);
      const t = fakeTab(`n${opened.length}`, url);
      tabs = [...tabs, t];
      return t;
    },
    close: async (id) => {
      tabs = tabs.filter((t) => t.id !== id);
      changed.forEach((f) => f());
    },
    release: (t) => void released.push(t.id),
    version: () => ({ product: 'Chrome/150.0.0.0', userAgent: 'Mozilla/5.0 Chrome/150' }),
  };
  const out: any[] = [];
  const relay = new CdpRelay(host, (m) => out.push(JSON.parse(m)));
  let id = 0;
  const call = async (method: string, params: object = {}, sessionId?: string) => {
    const n = ++id;
    relay.handle(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    for (let i = 0; i < 50 && !out.some((m) => m.id === n); i++) await new Promise((r) => setTimeout(r, 1));
    return out.find((m) => m.id === n);
  };
  const events = (method: string) => out.filter((m) => m.method === method);
  return {
    relay,
    call,
    events,
    out,
    released,
    opened,
    get tabs() {
      return tabs;
    },
    drop: (tid: string) => ((tabs = tabs.filter((t) => t.id !== tid)), changed.forEach((f) => f())),
  };
}

describe('the CDP relay (a session\'s Playwright driving Cora\'s browser tabs)', () => {
  it('plays the browser: its version, and each tab Playwright may drive attached as a page once it asks', async () => {
    const r = rig();
    expect((await r.call('Browser.getVersion')).result).toMatchObject({ product: 'Chrome/150.0.0.0', userAgent: 'Mozilla/5.0 Chrome/150' });
    expect(r.events('Target.attachedToTarget')).toHaveLength(0);
    await r.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const [att] = r.events('Target.attachedToTarget');
    expect(att.params).toMatchObject({ sessionId: 'cora-a', waitingForDebugger: false, targetInfo: { targetId: 'T-a', type: 'page', url: 'https://example.com/', browserContextId: 'cora-browser' } });
    expect((await r.call('Target.getTargetInfo')).result.targetInfo.type).toBe('browser');
  });

  it("passes a page's commands to its tab and its events back, on the page's session", async () => {
    const r = rig();
    await r.call('Target.setAutoAttach', { autoAttach: true, flatten: true });
    const res = await r.call('Runtime.evaluate', { expression: '1+1' }, 'cora-a');
    expect(res).toMatchObject({ sessionId: 'cora-a', result: { result: { value: 2 } } });
    expect(r.tabs[0].sent.at(-1)).toEqual({ method: 'Runtime.evaluate', params: { expression: '1+1' }, sessionId: undefined });
    (r.tabs[0] as ReturnType<typeof fakeTab>).fire('Page.loadEventFired', { timestamp: 1 });
    expect(r.out.at(-1)).toEqual({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'cora-a' });
    // a failed command: Playwright's error shape
    expect((await r.call('Page.crash', {}, 'cora-a')).error).toEqual({ code: -32000, message: 'nope' });
    expect((await r.call('Page.enable', {}, 'nobody')).error.message).toMatch(/not found/);
  });

  it("a frame or worker inside a page (its own session) is routed to that page's tab with its session", async () => {
    const r = rig();
    await r.call('Target.setAutoAttach', { autoAttach: true, flatten: true });
    const t = r.tabs[0] as ReturnType<typeof fakeTab>;
    t.fire('Target.attachedToTarget', { sessionId: 'CHILD1', targetInfo: { targetId: 'F1', type: 'iframe' } });
    expect(r.out.at(-1)).toMatchObject({ method: 'Target.attachedToTarget', sessionId: 'cora-a', params: { sessionId: 'CHILD1' } });
    await r.call('Runtime.enable', {}, 'CHILD1');
    expect(t.sent.at(-1)).toEqual({ method: 'Runtime.enable', params: {}, sessionId: 'CHILD1' });
    t.fire('Runtime.executionContextCreated', { context: { id: 7 } }, 'CHILD1');
    expect(r.out.at(-1)).toMatchObject({ method: 'Runtime.executionContextCreated', sessionId: 'CHILD1' });
    t.fire('Target.detachedFromTarget', { sessionId: 'CHILD1' });
    expect((await r.call('Runtime.enable', {}, 'CHILD1')).error).toBeTruthy();
  });

  it("the page's window is its tab: where it is, and it can't be moved or resized from Playwright", async () => {
    const r = rig();
    await r.call('Target.setAutoAttach', { autoAttach: true, flatten: true });
    expect((await r.call('Browser.getWindowForTarget', {}, 'cora-a')).result).toEqual({ windowId: 1, bounds: { left: 0, top: 0, width: 900, height: 600, windowState: 'normal' } });
    expect((await r.call('Browser.setWindowBounds', { windowId: 1, bounds: { width: 10 } }, 'cora-a')).result).toEqual({});
    expect(r.tabs[0].sent.some((s) => s.method.startsWith('Browser.'))).toBe(false);
  });

  it("Playwright's new page is a new tab in the session's browser; closing it closes the tab", async () => {
    const r = rig();
    await r.call('Target.setAutoAttach', { autoAttach: true, flatten: true });
    const made = await r.call('Target.createTarget', { url: 'about:blank' });
    expect(r.opened).toEqual(['about:blank']);
    expect(made.result).toEqual({ targetId: 'T-n1' });
    expect(r.events('Target.attachedToTarget').map((e) => e.params.sessionId)).toEqual(['cora-a', 'cora-n1']);
    expect((await r.call('Target.closeTarget', { targetId: 'T-n1' })).result).toEqual({ success: true });
    expect(r.events('Target.detachedFromTarget').at(-1).params).toEqual({ sessionId: 'cora-n1', targetId: 'T-n1' });
    expect(r.released).toEqual(['n1']);
  });

  it('a tab you close goes from Playwright; a tab opened for the session (a popup) comes to it', async () => {
    const r = rig([fakeTab('a'), fakeTab('b')]);
    await r.call('Target.setAutoAttach', { autoAttach: true, flatten: true });
    r.drop('b');
    expect(r.events('Target.detachedFromTarget').map((e) => e.params.targetId)).toEqual(['T-b']);
    expect(r.released).toEqual(['b']);
  });

  it("what Cora's browser can't do says so; it never closes Cora", async () => {
    const r = rig();
    expect((await r.call('Target.createBrowserContext')).error.message).toMatch(/isolated Playwright needs its own browser/);
    expect((await r.call('Tracing.start')).error.message).toMatch(/isn't available in Cora's browser/);
    expect((await r.call('Browser.close')).result).toEqual({});
    expect((await r.call('Browser.setDownloadBehavior', { behavior: 'allowAndName' })).result).toEqual({});
  });

  it('cookies go through a page (the profile\'s); Playwright going lets go of every tab', async () => {
    const r = rig();
    await r.call('Target.setAutoAttach', { autoAttach: true, flatten: true });
    await r.call('Storage.getCookies', {});
    expect(r.tabs[0].sent.at(-1)?.method).toBe('Network.getAllCookies');
    r.relay.close();
    expect(r.released).toEqual(['a']);
    expect((r.tabs[0] as ReturnType<typeof fakeTab>).subs.size).toBe(0);
  });
});

describe("Playwright's keyboard in a webview (Electron's input, not CDP's)", () => {
  it('turns its key events into Electron key events, a typing key with its character', async () => {
    const { electronKeys } = await import('../src/cdpKeys');
    expect(electronKeys({ type: 'keyDown', key: 'a', text: 'a' })).toEqual([
      { type: 'keyDown', keyCode: 'a', modifiers: [] },
      { type: 'char', keyCode: 'a', modifiers: [] },
    ]);
    expect(electronKeys({ type: 'rawKeyDown', key: 'ArrowLeft', modifiers: 8 })).toEqual([{ type: 'keyDown', keyCode: 'Left', modifiers: ['shift'] }]);
    expect(electronKeys({ type: 'keyUp', key: 'Enter', modifiers: 2 | 1 })).toEqual([{ type: 'keyUp', keyCode: 'Enter', modifiers: ['alt', 'control'] }]);
    expect(electronKeys({ type: 'char', text: 'é' })).toEqual([{ type: 'char', keyCode: 'é', modifiers: [] }]);
  });

  it('sends a tab that can take input its text and keys that way (never to its debugger)', async () => {
    const t = fakeTab('a');
    const typed: string[] = [];
    const keys: unknown[] = [];
    t.input = { text: async (x) => void typed.push(x), key: (p) => void keys.push(p) };
    const r = rig([t]);
    await r.call('Target.setAutoAttach', { autoAttach: true, flatten: true });
    expect((await r.call('Input.insertText', { text: 'hello' }, 'cora-a')).result).toEqual({});
    await r.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' }, 'cora-a');
    expect(typed).toEqual(['hello']);
    expect(keys).toEqual([{ type: 'keyDown', key: 'Enter' }]);
    expect(t.sent.some((s) => s.method.startsWith('Input.'))).toBe(false);
  });
});
