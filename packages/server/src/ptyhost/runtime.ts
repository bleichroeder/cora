import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The terminal host, installed Cora: it outlives the app by
 * design, so it can't run from the install folder (an update couldn't replace the files it holds open, or would have
 * to end it and every session with it). It runs from a copy in ~/.cora/runtime/host-<hash>/: the bundled Node, the
 * host's script and its terminal library. A new build's host gets its own folder; old ones go once nothing runs there.
 */
export function hostRuntime(o: { dataDir: string; node: string; distDir: string; modulesDir: string }): { node: string; script: string } {
  const files = readdirSync(o.distDir).filter((f) => f === 'ptyhost.js' || /^chunk-[\w-]+\.js$/.test(f));
  const hash = createHash('sha256');
  for (const f of files.sort()) hash.update(f).update(readFileSync(join(o.distDir, f)));
  const name = `host-${hash.digest('hex').slice(0, 12)}`;
  const root = join(o.dataDir, 'runtime');
  const dir = join(root, name);
  if (!existsSync(join(dir, 'ready'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cpSync(o.node, join(dir, 'node.exe'));
    for (const f of files) cpSync(join(o.distDir, f), join(dir, f));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', private: true }));
    for (const m of readdirSync(join(o.modulesDir, '@lydell')).filter((m) => m.startsWith('node-pty'))) cpSync(join(o.modulesDir, '@lydell', m), join(dir, 'node_modules', '@lydell', m), { recursive: true });
    writeFileSync(join(dir, 'ready'), new Date().toISOString());
  }
  // older hosts' folders: one still running can't be moved (Windows holds its files), so it stays
  for (const old of readdirSync(root).filter((d) => d.startsWith('host-') && d !== name)) {
    const from = join(root, old);
    try {
      const gone = `${from}.gone`;
      renameSync(from, gone);
      rmSync(gone, { recursive: true, force: true });
    } catch {
      /* in use */
    }
  }
  return { node: join(dir, 'node.exe'), script: join(dir, 'ptyhost.js') };
}
