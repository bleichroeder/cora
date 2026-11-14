import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

/**
 * Downloads from pages in Cora's browser. Electron's own way is a save dialog for every file, and nothing after; Cora
 * saves into your Downloads folder under a name that's free, and tells the dashboard as it goes (a list by the address
 * bar: progress, show in folder, cancel, hand its path to the session). Cora never opens a downloaded file itself.
 */

export type DownloadState = 'going' | 'done' | 'failed' | 'cancelled';
/** A download, as the dashboard is told of it. */
export type Download = { id: string; name: string; url: string; path: string; state: DownloadState; received: number; total: number; startedAt: number; /** the page that started it (its web contents id) */ from?: number };

const BAD = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A file name safe to save under (what the site suggested, tidied): never a path, never empty, never a device's name. */
export function safeName(suggested: string): string {
  let n = basename(String(suggested ?? '').replace(/\\/g, '/')).replace(BAD, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').slice(0, 180);
  if (!n) n = 'download';
  const stem = n.slice(0, n.length - extname(n).length);
  if (RESERVED.test(stem)) n = `_${n}`;
  return n;
}

/** Where to save it: the folder's `name`, or `name (2)`, `name (3)`… when that's taken (`taken`: is this path in use?). */
export function freePath(dir: string, name: string, taken: (p: string) => boolean = existsSync): string {
  const safe = safeName(name);
  const ext = extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let p = join(dir, safe);
  for (let i = 2; taken(p) && i < 1000; i++) p = join(dir, `${stem} (${i})${ext}`);
  return p;
}

/** How many finished downloads the list keeps. */
export const KEPT = 30;

/** The list, with one more or one changed (newest first; old finished ones fall off). */
export function withDownload(list: Download[], d: Download): Download[] {
  const rest = list.filter((x) => x.id !== d.id);
  const next = list.some((x) => x.id === d.id) ? list.map((x) => (x.id === d.id ? d : x)) : [d, ...rest];
  const going = next.filter((x) => x.state === 'going');
  const over = next.filter((x) => x.state !== 'going').slice(0, KEPT);
  return next.filter((x) => going.includes(x) || over.includes(x));
}
