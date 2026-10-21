import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** At most this much is written (an explain is a document, not a dump). */
export const EXPLAIN_MAX = 16 * 1024 * 1024;

/** A file name for an explain: its title, made safe for Windows, then the date (`Release plan 2026-10-20.md`). */
export function explainFileName(title: string, ext: 'md' | 'html', now = new Date()): string {
  const safe =
    title
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 80) || 'Explain';
  // names Windows keeps for itself (CON, NUL, COM1…) can't be files
  const name = /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(safe) ? `${safe} explain` : safe;
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `${name} ${d}.${ext}`;
}

/** Write an explain into `dir` (made if needed), never over another file: `… (2).md` and on. Returns its path. */
export function saveExplain(dir: string, title: string, ext: 'md' | 'html', content: string, now = new Date()): string {
  if (content.length > EXPLAIN_MAX) throw new Error('too big to save');
  mkdirSync(dir, { recursive: true });
  const first = explainFileName(title, ext, now);
  let path = join(dir, first);
  for (let n = 2; existsSync(path); n++) path = join(dir, first.replace(new RegExp(`\\.${ext}$`), ` (${n}).${ext}`));
  writeFileSync(path, content, 'utf8');
  return path;
}
