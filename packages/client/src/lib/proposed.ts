import { structuredPatch } from 'diff';
import type { Hunk } from '@cora/shared';

/** The change an Edit/MultiEdit/Write permission request proposes, as hunks (null for anything else). */
export function proposedChange(toolName: string, input: unknown): { path: string; hunks: Hunk[]; note?: string } | null {
  const inp = (input ?? {}) as { file_path?: unknown; old_string?: unknown; new_string?: unknown; content?: unknown; edits?: unknown };
  const path = typeof inp.file_path === 'string' ? inp.file_path : null;
  if (!path) return null;
  // snippets, not whole files: end both with a newline so there's no "no newline at end of file" noise
  const nl = (s: string) => (s.endsWith('\n') ? s : s + '\n');
  const patch = (a: string, b: string) => structuredPatch('a', 'b', nl(a), nl(b), '', '', { context: 2 }).hunks as Hunk[];
  if (toolName === 'Edit' && typeof inp.old_string === 'string' && typeof inp.new_string === 'string') return { path, hunks: patch(inp.old_string, inp.new_string) };
  if (toolName === 'MultiEdit' && Array.isArray(inp.edits)) {
    const hunks = inp.edits.flatMap((e: any) => (typeof e?.old_string === 'string' && typeof e?.new_string === 'string' ? patch(e.old_string, e.new_string) : []));
    return { path, hunks };
  }
  if (toolName === 'Write' && typeof inp.content === 'string') {
    const lines = inp.content.replace(/\n$/, '').split('\n');
    return { path, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => '+' + l) }], note: 'writes the whole file' };
  }
  return null;
}
