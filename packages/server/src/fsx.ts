import { existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Write a whole file so that a crash or power cut mid-write can't leave it half there (and Cora load it as empty): the
 * new content goes to a file beside it, which then takes its place. Windows may hold the file for a moment (antivirus,
 * the indexer): it's tried again, and as a last resort written in place, as before (docs/audit-2026-10-20.md B2).
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, opts?: { mode?: number }): void {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, data, opts);
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i < 4 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        pause(25 * (i + 1));
        continue;
      }
      try {
        writeFileSync(file, data, opts);
      } finally {
        rmSync(tmp, { force: true });
      }
      return;
    }
  }
}

/**
 * A log that would otherwise grow forever: past `max` bytes it becomes <file>.1 (replacing the one before) and a new
 * one starts, so there's at most about twice that on disk (docs/audit-2026-10-20.md B13).
 */
export function rollLog(file: string, max = 1_000_000): void {
  try {
    if (!existsSync(file) || statSync(file).size <= max) return;
    rmSync(`${file}.1`, { force: true });
    renameSync(file, `${file}.1`);
  } catch {
    /* kept as it is: in use, or not ours to move */
  }
}
