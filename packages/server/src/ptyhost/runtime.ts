import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Is a terminal host running from this folder? Its pid there (still alive), else (a host from before that) Windows' own list. Unsure: yes. */
export function hostRunningFrom(dir: string): boolean {
  try {
    const pid = Number(readFileSync(join(dir, 'host.pid'), 'utf8').trim());
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
  } catch {
    /* no pid kept: a host from before */
  }
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.ExecutablePath }"], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    const d = `${dir.toLowerCase()}\\`;
    return out.split(/\r?\n/).some((p) => p.trim().toLowerCase().startsWith(d));
  } catch {
    return true;
  }
}

/**
 * The terminal host, installed Cora: it outlives the app by
 * design, so it can't run from the install folder (an update couldn't replace the files it holds open, or would have
 * to end it and every session with it). It runs from a copy in ~/.cora/runtime/host-<hash>/: the bundled Node, the
 * host's script and its terminal library. A new build's host gets its own folder; old ones go once nothing runs there.
 */
export function hostRuntime(o: { dataDir: string; node: string; distDir: string; modulesDir: string; log?: (m: string) => void; /** is a host running from this folder (tests fake it) */ running?: (dir: string) => boolean }): { node: string; script: string } {
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
  // older hosts' folders, once no host runs from them: Windows lets a running host's folder be renamed (it works
  // elsewhere), and a host whose files went can't start a terminal again (and Cora reconnects to it)
  const running = o.running ?? hostRunningFrom;
  for (const old of readdirSync(root).filter((d) => d.startsWith('host-') && d !== name)) {
    const from = join(root, old);
    if (!old.endsWith('.gone') && running(from)) continue;
    try {
      const gone = old.endsWith('.gone') ? from : `${from}.gone`;
      if (gone !== from) renameSync(from, gone);
      rmSync(gone, { recursive: true, force: true });
    } catch (e) {
      o.log?.(`an old terminal host's folder stays (${old}): ${(e as Error).message}`);
    }
  }
  return { node: join(dir, 'node.exe'), script: join(dir, 'ptyhost.js') };
}
