import { app } from 'electron';
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What to know when the window misbehaves (the 3D view went blank, a renderer died): why Chromium's GPU and renderer
 * processes went away, and the window's console errors, in <data>/desktop.log (kept to about a megabyte).
 */
export function setupDiagnostics(dataDir: string): (m: string) => void {
  const file = join(dataDir, 'desktop.log');
  const log = (m: string) => {
    try {
      if (existsSync(file) && statSync(file).size > 1_000_000) renameSync(file, `${file}.1`);
      appendFileSync(file, `${new Date().toISOString()} ${m}\n`);
    } catch {
      /* not kept */
    }
  };
  app.on('child-process-gone', (_e, d) => log(`${d.type} process gone: ${d.reason} (exit ${d.exitCode})${d.name ? ` ${d.name}` : ''}`));
  app.on('render-process-gone', (_e, wc, d) => log(`renderer gone: ${d.reason} (exit ${d.exitCode}) ${wc.getType()}`));
  app.on('web-contents-created', (_e, wc) => {
    // Cora's own window (not the web pages in its browser and tools, which have errors of their own)
    if (wc.getType() !== 'window') return;
    wc.on('console-message', (e: any, level?: unknown, message?: unknown, line?: unknown, source?: unknown) => {
      const lvl = e?.level ?? level;
      if (lvl !== 'error' && lvl !== 3) return;
      log(`console error: ${String(e?.message ?? message).slice(0, 500)} (${e?.sourceId ?? source ?? ''}:${e?.lineNumber ?? line ?? ''})`);
    });
  });
  return log;
}
