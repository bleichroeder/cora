import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { HistoryItem } from '@cora/shared';

export type { HistoryItem };

const CHUNK = 64 * 1024;

async function readSlice(file: string, from: number, len: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, from);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

function lines(text: string): any[] {
  const out: any[] = [];
  for (const l of text.split('\n')) {
    try {
      out.push(JSON.parse(l));
    } catch {
      /* partial line at a chunk edge */
    }
  }
  return out;
}

/** Every main-session transcript on disk, newest first, with cwd / title / first prompt from its head and tail (`skip`: project folders to leave out). */
export async function listHistory(projectsDir: string, limit = 300, skip?: (slug: string) => boolean): Promise<HistoryItem[]> {
  const files: Array<{ file: string; slug: string; mtime: number; size: number }> = [];
  for (const slug of await readdir(projectsDir).catch(() => [] as string[])) {
    if (skip?.(slug)) continue;
    const dir = join(projectsDir, slug);
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!f.endsWith('.jsonl')) continue;
      const s = await stat(join(dir, f)).catch(() => null);
      if (s?.isFile()) files.push({ file: join(dir, f), slug, mtime: s.mtimeMs, size: s.size });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: HistoryItem[] = [];
  for (const f of files.slice(0, limit)) out.push(await historyItem(f));
  return out;
}

/** One transcript as the history lists it: cwd / title / first prompt from its head and tail. */
export async function historyItem(f: { file: string; slug: string; mtime: number; size: number }): Promise<HistoryItem> {
  const head = lines(await readSlice(f.file, 0, Math.min(CHUNK, f.size)));
  const tail = f.size > CHUNK ? lines(await readSlice(f.file, f.size - CHUNK, CHUNK)) : head;
  const cwd = head.find((o) => typeof o?.cwd === 'string')?.cwd ?? '';
  const prompt = head.find((o) => o?.type === 'user' && !o.isMeta && typeof o.message?.content === 'string' && !o.message.content.startsWith('<') && (o.origin?.kind === 'human' || o.promptSource === 'typed'));
  const title = [...tail, ...head].reverse().find((o) => o?.type === 'ai-title')?.aiTitle ?? '';
  return { sessionId: basename(f.file, '.jsonl'), projectSlug: f.slug, cwd, title, firstPrompt: String(prompt?.message?.content ?? '').slice(0, 160), mtime: f.mtime, size: f.size };
}

/** Subdirectories of a folder, for the new-session folder picker. */
export async function listDirs(path: string): Promise<{ path: string; parent: string | null; dirs: string[]; error?: string }> {
  const p = resolve(path);
  try {
    const entries = await readdir(p, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && !e.name.startsWith('$'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .slice(0, 300);
    const parent = dirname(p);
    return { path: p, parent: parent === p ? null : parent, dirs };
  } catch (e) {
    return { path: p, parent: null, dirs: [], error: (e as Error).message };
  }
}
