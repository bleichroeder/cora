import { createRequire } from 'node:module';

/** An off-screen terminal mirroring a hosted PTY, so the server can read what Claude Code shows. */
export type Screen = { write(d: string): void; resize(cols: number, rows: number): void; lines(): string[]; dispose(): void };

/**
 * Scrollback must not be 0: with no scrollback xterm can line-feed or resize onto a buffer line that doesn't exist
 * and throw from inside its own write timer, which nothing can catch (it took the whole server down). A small
 * scrollback avoids that; the mirror is never displayed, so the size doesn't matter.
 */
const SCROLLBACK = 200;
const live = new Set<{ rebuild(): void }>();

export function headlessScreen(cols: number, rows: number): Screen {
  const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless');
  let size = { cols, rows };
  const make = () => new Terminal({ cols: size.cols, rows: size.rows, allowProposedApi: true, scrollback: SCROLLBACK });
  let t = make();
  const self = {
    rebuild() {
      try {
        t.dispose();
      } catch {
        /* already broken */
      }
      t = make();
    },
  };
  live.add(self);
  return {
    write: (d) => t.write(d),
    resize: (c, r) => {
      size = { cols: Math.max(2, c), rows: Math.max(2, r) };
      t.resize(size.cols, size.rows);
    },
    lines: () => {
      try {
        const b = t.buffer.active;
        const out: string[] = [];
        for (let i = 0; i < t.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
        return out;
      } catch {
        self.rebuild();
        return [];
      }
    },
    dispose: () => {
      live.delete(self);
      t.dispose();
    },
  };
}

/** True for errors thrown by the headless terminal (they surface as uncaught exceptions from its write timer). */
export const isScreenError = (e: unknown): boolean => e instanceof Error && /@xterm[\\/]headless/.test(e.stack ?? '');

/** Start every mirror over (they only feed the status line; the next frames repopulate them). Returns how many. */
export function rebuildScreens(): number {
  for (const s of live) s.rebuild();
  return live.size;
}

/**
 * Claude Code's working indicator, e.g. "✻ Cogitating… (12s · ↑ 1.4k tokens · thought for 7s)": a spinner glyph, a
 * verb ending in "…", then a parenthesised elapsed time. It is only on screen while Claude is working, so its presence
 * is the signal; the finished summary ("✻ Baked for 7s") has no "…". The status bar ("⏵⏵ auto mode on · esc to
 * interrupt") is not it. Returns null when idle.
 */
const SPINNER = /^\s*[·✢✳✶✻✽*✦✧◆]\s+[^\s(][^(]*…\s*\(/u;

export function statusLine(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SPINNER.test(lines[i]) && !lines[i].includes('⏵⏵')) return lines[i].replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  return null;
}

export { choiceOpen } from '@cora/shared';
