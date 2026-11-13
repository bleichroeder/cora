import { createRequire } from 'node:module';
import { inputBox } from '@cora/shared';

/** An off-screen terminal mirroring a hosted PTY, so the server can read what Claude Code shows. */
export type Screen = { write(d: string): void; resize(cols: number, rows: number): void; lines(): string[]; /** the dimmed text in Claude Code's input box, when that's all there is in it (its suggested next prompt) */ dimInput?(): string | null; dispose(): void };

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
    dimInput: () => {
      try {
        const b = t.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < t.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
        const box = inputBox(lines);
        if (!box) return null;
        const out: string[] = [];
        for (let r = box.top + 1; r < box.bottom; r++) {
          const line = b.getLine(b.viewportY + r);
          if (!line) return null;
          let row = '';
          // after the prompt mark (the first row): every character must be dimmed
          const from = r === box.top + 1 ? Math.max(0, lines[r].search(/[❯>]/u)) + 1 : 0;
          for (let x = from; x < line.length; x++) {
            const c = line.getCell(x);
            const ch = c?.getChars() ?? '';
            if (ch.trim() && !c!.isDim()) return null;
            row += ch || ' ';
          }
          out.push(row.trim());
        }
        return out.join(' ').replace(/\s+/g, ' ').trim() || null;
      } catch {
        return null;
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

/**
 * Claude Code's suggested next prompt, from the dimmed text in its input box: not its placeholder examples ('Try
 * "fix the lint errors"'), and without the key hint it may end with.
 */
export function suggestionFrom(dim: string | null): string | null {
  if (!dim) return null;
  const s = dim.replace(/\s*[(\[]?(?:tab|enter|↵|→)[^)\]]{0,24}(?:accept|use|send)[)\]]?\s*$/iu, '').trim();
  if (!s || s.length < 3 || /^try\s+["“]/i.test(s) || /^(?:press|type)\b.*\bfor\b/i.test(s)) return null;
  return s.slice(0, 400);
}

/**
 * Claude Code's permission mode, as the bar under its input box says it ("⏵⏵ auto mode on", "⏸ plan mode on",
 * "⏵⏵ accept edits on"; nothing said: the default). Null when its input box isn't on screen (a dialog, a menu): not known.
 */
export function claudeMode(lines: string[]): string | null {
  const box = inputBox(lines);
  if (!box) return null;
  const under = lines.slice(box.bottom + 1).join(' ').toLowerCase();
  if (under.includes('plan mode on')) return 'plan';
  if (under.includes('auto mode on')) return 'auto';
  if (under.includes('accept edits on')) return 'acceptEdits';
  if (under.includes('bypass permissions on')) return 'bypassPermissions';
  return 'default';
}

export { choiceOpen } from '@cora/shared';
