import { describe, expect, it } from 'vitest';
import { explainShim, themeVars } from '../src/lib/explainShim';

/** Run the shim's script in a fake page; returns what a page would see. */
function page(html: string) {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const parent = { posted: [] as unknown[], postMessage(m: unknown) { this.posted.push(m); } };
  const win: any = { parent, scrollY: 0, scrollTo: (_x: number, y: number) => (win.scrolledTo = y), addEventListener: (k: string, f: (e: any) => void) => ((listeners[k] ??= []).push(f)) };
  new Function('window', 'console', script)(win, { error: () => {} });
  const send = (data: unknown, source: unknown = parent) => listeners.message?.forEach((f) => f({ source, data }));
  return { win, parent, send, fire: (k: string) => listeners[k]?.forEach((f) => f({})) };
}

describe('the explain shim', () => {
  it('the theme as CSS variables, from the dashboard\'s own', () => {
    const vars = themeVars((n) => ({ '--nav': '#0b0e14', '--cora': ' #f472b6 ', '--work': '#3ddc97' })[n] ?? '');
    expect(vars).toEqual({ '--bg': '#0b0e14', '--cora': '#f472b6', '--ok': '#3ddc97' });
    expect(explainShim({ vars })).toContain('<style>:root{--bg:#0b0e14;--cora:#f472b6;--ok:#3ddc97}</style>');
    expect(explainShim({ vars: { '--x': 'red;}</style><script>' } })).toContain(':root{}');
  });

  it('cora.onData: the latest data at once, then each update from the viewer only', () => {
    const p = page(explainShim({ vars: {}, live: true, data: { passed: 41 } }));
    const got: unknown[] = [];
    p.win.cora.onData((d: unknown) => got.push(d));
    expect(got).toEqual([{ passed: 41 }]);
    p.send({ cora: 'data', data: { passed: 42 } });
    p.send({ cora: 'data', data: { passed: 99 } }, { someone: 'else' });
    p.send({ other: 1 });
    expect(got).toEqual([{ passed: 41 }, { passed: 42 }]);
  });

  it('no data yet: onData waits for the first; data can\'t close the script', () => {
    const p = page(explainShim({ vars: {}, live: true }));
    const got: unknown[] = [];
    p.win.cora.onData((d: unknown) => got.push(d));
    expect(got).toEqual([]);
    p.send({ cora: 'data', data: 7 });
    expect(got).toEqual([7]);
    expect(explainShim({ vars: {}, live: true, data: '</script><b>' })).not.toContain('</script><b>');
  });

  it('keeps the scroll across a reload', () => {
    const p = page(explainShim({ vars: {}, scroll: 640 }));
    p.fire('load');
    expect(p.win.scrolledTo).toBe(640);
  });
});
