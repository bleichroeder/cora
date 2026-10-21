import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { Store } from './store';

const TAIL_BYTES = 16 * 1024;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/**
 * Where a background command's output goes, as Claude Code recorded it for this session (the Bash result or the
 * task-notification). Only a path the transcript named, and only one ending in the task's own `<id>.output`.
 */
export function taskOutputFile(store: Store, sessionId: string, taskId: string): string | null {
  if (!/^\w{1,64}$/.test(taskId)) return null;
  for (const e of store.findEvents(sessionId, `%${taskId}%`)) {
    const file = e.tool?.background?.taskId === taskId ? e.tool.background.outputFile : e.task?.id === taskId ? e.task.outputFile : undefined;
    if (file && (file.endsWith(`\\${taskId}.output`) || file.endsWith(`/${taskId}.output`))) return file;
  }
  return null;
}

/** The last few lines a background command has written (colour codes stripped), and how much it has written. */
export function tailOutput(file: string, lines = 6): { lines: string[]; bytes: number } | null {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8').replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
    const all = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
    return { lines: all.slice(-lines).map((l) => (l.length > 300 ? l.slice(0, 300) + '…' : l)), bytes: size };
  } catch {
    return null;
  } finally {
    if (fd != null) closeSync(fd);
  }
}
