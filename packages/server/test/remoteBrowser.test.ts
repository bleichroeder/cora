import { describe, expect, it } from 'vitest';
import { RemoteBrowser } from '../src/remoteBrowser';

/** a socket double: what it was sent, and a way to say something to it */
function sock() {
  const handlers: Record<string, Array<(...a: any[]) => void>> = {};
  const s = {
    readyState: 1,
    sent: [] as any[],
    send(d: string) {
      s.sent.push(JSON.parse(d));
    },
    close() {
      s.readyState = 3;
      for (const f of handlers.close ?? []) f();
    },
    on(ev: string, fn: (...a: any[]) => void) {
      (handlers[ev] ??= []).push(fn);
    },
    emit(m: object) {
      for (const f of handlers.message ?? []) f(JSON.stringify(m));
    },
  };
  return s;
}

describe("a session's browser on your other devices", () => {
  it('renders a tab on the PC only while a screen watches it; its picture goes to the watcher, its input to the page', () => {
    const rb = new RemoteBrowser();
    let changes = 0;
    rb.onChange = () => changes++;
    expect(rb.open('s1', 'file:///etc/passwd')).toBeNull();
    const t = rb.open('s1', 'https://gitlab.com/x')!;
    expect(rb.open('s1', 'https://gitlab.com/x')!.id).toBe(t.id);
    const pc = sock();
    rb.attachDesktop(pc as never);
    expect(rb.available).toBe(true);
    // nobody watching: nothing asked of the PC
    expect(pc.sent).toEqual([]);
    const ipad = sock();
    expect(rb.attachViewer(ipad as never, t.id)).toBe(true);
    expect(rb.attachViewer(sock() as never, 'nope')).toBe(false);
    ipad.emit({ t: 'size', w: 1024, h: 700 });
    expect(pc.sent).toContainEqual({ t: 'open', id: t.id, url: 'https://gitlab.com/x', w: 1024, h: 700 });
    // the picture to the watcher; the page's state to everyone
    pc.emit({ t: 'frame', id: t.id, data: 'abc', w: 1024, h: 700 });
    expect(ipad.sent).toContainEqual({ t: 'frame', data: 'abc', w: 1024, h: 700 });
    pc.emit({ t: 'state', id: t.id, url: 'https://gitlab.com/x/-/merge_requests/1', title: 'MR 1', canBack: true });
    expect(rb.list()[0]).toMatchObject({ url: 'https://gitlab.com/x/-/merge_requests/1', title: 'MR 1', canBack: true });
    // a tap, and a navigation, to the page; a non-http address isn't
    ipad.emit({ t: 'input', ev: { type: 'tap', x: 10, y: 20 } });
    ipad.emit({ t: 'go', url: 'javascript:alert(1)' });
    ipad.emit({ t: 'nav', action: 'back' });
    expect(pc.sent).toContainEqual({ t: 'input', id: t.id, ev: { type: 'tap', x: 10, y: 20 } });
    expect(pc.sent.some((m) => m.t === 'go')).toBe(false);
    expect(pc.sent).toContainEqual({ t: 'nav', id: t.id, action: 'back' });
    // a popup: a tab of its own
    pc.emit({ t: 'popup', id: t.id, url: 'https://jira.example.com/browse/X-1' });
    expect(rb.list().map((x) => x.url)).toContain('https://jira.example.com/browse/X-1');
    // closed: its watcher's stream ends, the PC lets the page go
    rb.close(t.id);
    expect(ipad.readyState).toBe(3);
    expect(pc.sent).toContainEqual({ t: 'close', id: t.id });
    expect(changes).toBeGreaterThan(2);
  });
});
