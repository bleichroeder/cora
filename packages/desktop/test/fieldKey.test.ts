import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIELD_KEY_JS } from '../src/pageScripts';

/** Just enough of a page for the key: inputs, focus events, and a body to put the key in. */
function fakePage(inputs: Array<{ type?: string; name?: string; autocomplete?: string }>) {
  const docListeners: Record<string, Array<(e: unknown) => void>> = {};
  const btnListeners: Record<string, Array<(e: unknown) => void>> = {};
  const btn = { style: {} as Record<string, string>, addEventListener: (k: string, f: (e: unknown) => void) => ((btnListeners[k] ??= []).push(f)) };
  const els = inputs.map((i) => ({
    tagName: 'INPUT',
    type: i.type ?? 'text',
    name: i.name ?? '',
    id: '',
    placeholder: '',
    disabled: false,
    readOnly: false,
    isConnected: true,
    getAttribute: (k: string) => (k === 'autocomplete' ? (i.autocomplete ?? null) : null),
    getBoundingClientRect: () => ({ left: 10, top: 20, right: 210, bottom: 52, width: 200, height: 32 }),
  }));
  const host = { isConnected: false, attachShadow: () => ({ set innerHTML(_v: string) {}, querySelector: () => btn }) };
  const doc = {
    activeElement: null as unknown,
    body: { appendChild: () => (host.isConnected = true) },
    createElement: () => host,
    querySelector: (sel: string) => (/password/.test(sel) ? (els.find((e) => e.type === 'password') ?? null) : null),
    addEventListener: (k: string, f: (e: unknown) => void) => ((docListeners[k] ??= []).push(f)),
  };
  const said: string[] = [];
  const win = { addEventListener: () => {} } as Record<string, unknown>;
  const run = () => new Function('doc', 'c', 'window', 'console', FIELD_KEY_JS)(doc, 'NONCE:', win, { debug: (m: string) => said.push(m) });
  const fire = (k: string, target: unknown) => docListeners[k]?.forEach((f) => f({ target }));
  const click = () => btnListeners.click?.forEach((f) => f({ preventDefault() {}, stopPropagation() {} }));
  return { els, doc, btn, said, run, fire, click };
}

describe('the key in a login field', () => {
  afterEach(() => vi.useRealTimers());

  it('shows at a focused password field and says so, with the nonce; a click asks for the menu there', () => {
    const p = fakePage([{ name: 'user' }, { type: 'password' }]);
    p.run();
    p.fire('focusin', p.els[1]);
    expect(p.btn.style.display).toBe('flex');
    // (and whether it has something in it already: no suggestions then)
    expect(p.said).toEqual(['NONCE:{"k":"focus","r":{"x":10,"y":20,"w":200,"h":32},"v":false}']);
    p.click();
    expect(p.said.at(-1)).toBe('NONCE:{"k":"open","r":{"x":10,"y":20,"w":200,"h":32}}');
  });

  it("the username field of a page with a password field too, but not a search box", () => {
    const p = fakePage([{ name: 'q' }, { name: 'username' }, { type: 'password' }]);
    p.run();
    p.fire('focusin', p.els[0]);
    expect(p.said).toEqual([]);
    p.fire('focusin', p.els[1]);
    expect(p.said).toHaveLength(1);
  });

  it('no password field on the page: no key', () => {
    const p = fakePage([{ name: 'username' }]);
    p.run();
    p.fire('focusin', p.els[0]);
    expect(p.said).toEqual([]);
  });

  it('leaving the field hides the key and says so', () => {
    vi.useFakeTimers();
    const p = fakePage([{ type: 'password' }]);
    p.run();
    p.fire('focusin', p.els[0]);
    p.fire('focusout', p.els[0]);
    vi.advanceTimersByTime(200);
    expect(p.btn.style.display).toBe('none');
    expect(p.said.at(-1)).toBe('NONCE:{"k":"blur"}');
  });
});
