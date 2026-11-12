/**
 * File paths in what a transcript shows (your prompts, a reply's `code`): found, so they can be looked at (a picture's
 * thumbnail, a text file's first lines) and opened. A path may end in `:line` or `:line:col`.
 */

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** absolute POSIX: under a system folder, or ending in an extension (not a route like /api/boards) */
const POSIX = String.raw`/(?:(?:etc|home|Users|tmp|var|opt|usr|mnt|srv|root|private)/[^\s"'\`<>|*?]*[^\s"'\`<>|*?.,;:!)\]}]|[\w@.-]+(?:/[\w@.-]+)*\.[A-Za-z0-9]{1,10})`;
/** Windows (C:\… or C:/…), a UNC share, home (~/…), or absolute POSIX */
const ABS = String.raw`(?:(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|~[\\/])[^\s"'\`<>|*?]*[^\s"'\`<>|*?.,;:!)\]}]|${POSIX})`;
/** quoted, a Windows path may hold spaces ("C:\My Files\a b.txt") */
const QUOTED_WIN = /^([A-Za-z]:[\\/][^"<>|*?\n]*?)(?::(\d+)(?::\d+)?)?$/;
/** relative: two or more parts, the last with an extension (src/app.ts, ./a/b.md); not a web address */
const REL = String.raw`(?:\.{1,2}[\\/])?[\w@.-]+(?:[\\/][\w@.-]+)+\.[A-Za-z0-9]{1,10}`;
const LINE = String.raw`(?::(\d+)(?::\d+)?)?`;
const WHOLE = new RegExp(String.raw`^(${ABS}|${REL})${LINE}$`);
const INSIDE = new RegExp(String.raw`(?<![\w/\\:.-])(${ABS}|${REL})${LINE}(?![\w/\\])`, 'g');

export type FileRef = { path: string; line?: number };

/** The whole string, if it is a path (with its line, if it says one). */
export function asFileRef(s: string): FileRef | null {
  const raw = s.trim();
  const quoted = /^(["']).*\1$/.test(raw);
  const t = quoted ? raw.slice(1, -1) : raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null;
  if (quoted) {
    const q = t.match(QUOTED_WIN);
    if (q) return { path: q[1], ...(q[2] ? { line: Number(q[2]) } : {}) };
  }
  const m = t.match(WHOLE);
  if (!m) return null;
  return { path: m[1], ...(m[2] ? { line: Number(m[2]) } : {}) };
}

/** The paths in a text, where each is (its index and length, with its `:line`). Web addresses are not paths. */
export function findFileRefs(text: string): Array<FileRef & { index: number; length: number }> {
  const out: Array<FileRef & { index: number; length: number }> = [];
  for (const m of text.matchAll(INSIDE)) {
    const i = m.index ?? 0;
    // part of a web address (https://host/a/b.png)
    const before = text.slice(Math.max(0, i - 200), i);
    if (/[a-z][a-z0-9+.-]*:\/\/\S*$/i.test(before)) continue;
    out.push({ path: m[1], ...(m[2] ? { line: Number(m[2]) } : {}), index: i, length: m[0].length });
  }
  return out;
}

/**
 * A prompt's attached pictures: lines that are only an image's path (the composer puts each attachment on a line of
 * its own) come out as `images`; the rest stays as its `text`.
 */
export function splitPrompt(text: string): { text: string; images: string[] } {
  const images: string[] = [];
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const r = asFileRef(line);
    if (r && IMAGE_EXT.test(r.path) && !r.line) images.push(r.path);
    else kept.push(line);
  }
  return { text: kept.join('\n').replace(/\s+$/, ''), images };
}

export const fileName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
