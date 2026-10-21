import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Largest file the composer can hand over (a screenshot or a log, not a video). */
export const MAX_ATTACHMENT = 15 * 1024 * 1024;
/** Attachments are only needed while Claude reads them: older ones are cleared away. */
const KEEP_MS = 14 * 86_400_000;

/** Where pasted screenshots and dropped files go. Hosted sessions get it as an extra folder (no permission prompt to read them). */
export const attachmentsDir = (dataDir: string) => join(dataDir, 'attachments');

/** A file name that's safe on every OS and still says what it was. */
export function safeName(name: string): string {
  const ext = extname(name).replace(/[^\w.]/g, '').slice(0, 10).toLowerCase();
  const base = name
    .slice(0, name.length - extname(name).length)
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60);
  return `${base || 'file'}${ext}`;
}

/** Save a file for a session; returns its full path (what goes in the prompt). */
export function saveAttachment(dataDir: string, sessionId: string, name: string, data: Buffer, now = new Date()): string {
  if (!/^[\w-]{1,80}$/.test(sessionId)) throw new Error('bad session id');
  const dir = join(attachmentsDir(dataDir), sessionId);
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let file = join(dir, `${stamp}-${safeName(name)}`);
  for (let i = 2; exists(file); i++) file = join(dir, `${stamp}-${i}-${safeName(name)}`);
  writeFileSync(file, data);
  return file;
}

const exists = (p: string) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Remove attachments older than two weeks (and folders left empty). Returns how many files went. */
export function pruneAttachments(dataDir: string, now = Date.now(), keepMs = KEEP_MS): number {
  const root = attachmentsDir(dataDir);
  let n = 0;
  let sessions: string[] = [];
  try {
    sessions = readdirSync(root);
  } catch {
    return 0;
  }
  for (const s of sessions) {
    const dir = join(root, s);
    try {
      const files = readdirSync(dir);
      for (const f of files) {
        const p = join(dir, f);
        if (now - statSync(p).mtimeMs > keepMs) {
          rmSync(p, { force: true });
          n++;
        }
      }
      if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* not a folder, or in use */
    }
  }
  return n;
}
