// Runs the transcript parser over every local transcript and reports crashes / unknown line rates.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { newParseCtx, parseLine } from '../packages/server/src/transcript/parse';

const root = join(homedir(), '.claude', 'projects');
const files: string[] = [];
for (const p of readdirSync(root)) {
  const dir = join(root, p);
  if (!statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.jsonl')) files.push(join(dir, f));
    const sub = join(dir, f, 'subagents');
    try { for (const s of readdirSync(sub)) if (s.endsWith('.jsonl')) files.push(join(sub, s)); } catch {}
  }
}
let lines = 0, bad = 0, unknown = 0, crashes = 0;
const kinds: Record<string, number> = {};
const unknownTypes: Record<string, number> = {};
for (const f of files) {
  const ctx = newParseCtx();
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    lines++;
    let obj: any;
    try { obj = JSON.parse(line); } catch { bad++; continue; }
    try {
      const r = parseLine(obj, ctx);
      if (r.meta.unknown) { unknown++; unknownTypes[obj.type] = (unknownTypes[obj.type] ?? 0) + 1; }
      for (const e of r.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    } catch (e) {
      crashes++;
      if (crashes < 5) console.error(f, (e as Error).message);
    }
  }
}
console.log({ files: files.length, lines, bad, unknown, crashes, kinds, unknownTypes });
