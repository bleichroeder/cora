import { describe, expect, it } from 'vitest';
import { headlessScreen, isScreenError, rebuildScreens, statusLine } from '../src/screen';

describe('statusLine', () => {
  it('finds the working indicator', () => {
    expect(statusLine(['some output', '✻ Cogitating… (12s · ↑ 1.4k tokens · esc to interrupt)', '────', '❯ '])).toBe('✻ Cogitating… (12s · ↑ 1.4k tokens · esc to interrupt)');
  });
  it('null when idle (only the finished summary is on screen)', () => {
    expect(statusLine(['✻ Baked for 7s · done 1:25 PM', '────', '❯ '])).toBeNull();
  });
  it('ignores the status bar and finds the spinner without "esc to interrupt"', () => {
    const screen = ['✶ Beaming… (8s · ↓ 611 tokens · thought for 7s)', '', '────', '❯ ', '────', '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents'];
    expect(statusLine(screen)).toBe('✶ Beaming… (8s · ↓ 611 tokens · thought for 7s)');
    expect(statusLine(screen.slice(1))).toBeNull();
  });
  it('reads a real rendered screen', async () => {
    const s = headlessScreen(80, 4);
    s.write('hello\r\n\x1b[38;5;174m✢\x1b[39m \x1b[1mBrewing…\x1b[22m (3s · esc to interrupt)');
    await new Promise((r) => setTimeout(r, 50));
    expect(statusLine(s.lines())).toBe('✢ Brewing… (3s · esc to interrupt)');
    s.dispose();
  });
});

describe('headlessScreen robustness', () => {
  it('survives TUI escape sequences mixed with resizes (crashed with scrollback 0)', async () => {
    let seed = 3;
    const r = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const op = () =>
      [`\x1b[${r(60) + 1};${r(100) + 1}H`, `\x1b[${r(30) + 1};${r(60) + 1}r`, '\x1bM', `\x1b[${r(5) + 1}L`, `\x1b[${r(5) + 1}M`, `\x1b[${r(5) + 1}A\x1b[2K`, '\x1b[?1049h', '\x1b[?1049l', 'x'.repeat(r(200)) + '\r\n'][r(9)];
    const errors: unknown[] = [];
    const onErr = (e: unknown) => void errors.push(e);
    process.on('uncaughtException', onErr);
    const screens = Array.from({ length: 6 }, () => headlessScreen(120, 30));
    for (let i = 0; i < 1500 && !errors.length; i++) {
      for (const s of screens) {
        if (r(4) === 0) s.resize(r(150) + 2, r(40) + 2);
        let d = '';
        for (let j = 0; j < 20; j++) d += op();
        s.write(d);
      }
      await new Promise((res) => setImmediate(res)); // let xterm parse (it writes on a timer)
    }
    await new Promise((res) => setTimeout(res, 200));
    process.off('uncaughtException', onErr);
    expect(errors.map((e) => String((e as Error).message ?? e))).toEqual([]);
    for (const s of screens) {
      expect(Array.isArray(s.lines())).toBe(true);
      s.dispose();
    }
  }, 60_000);

  it('rebuildScreens starts mirrors over and they keep working', async () => {
    const s = headlessScreen(40, 4);
    s.write('before');
    expect(rebuildScreens()).toBeGreaterThanOrEqual(1);
    s.write('after');
    await new Promise((res) => setTimeout(res, 50));
    expect(s.lines()[0]).toBe('after');
    s.dispose();
  });

  it('isScreenError recognises xterm frames on Windows and POSIX paths', () => {
    const e = (path: string) => Object.assign(new TypeError('x'), { stack: `TypeError: x\n    at A.lineFeed (${path}:1:27204)` });
    expect(isScreenError(e(String.raw`C:\Code\agent-brain\node_modules\@xterm\headless\lib-headless\xterm-headless.js`))).toBe(true);
    expect(isScreenError(e('/repo/node_modules/@xterm/headless/lib-headless/xterm-headless.js'))).toBe(true);
    expect(isScreenError(e('/repo/src/store.ts'))).toBe(false);
  });
});
