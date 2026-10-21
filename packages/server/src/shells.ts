import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import type { ShellProfile } from '@cora/shared';

/**
 * The shells a shell tab can be (as Windows Terminal finds them): PowerShell 7, Windows PowerShell, Command Prompt,
 * Git Bash and each WSL distro installed. Elsewhere: the user's $SHELL. CORA_SHELL_CMD (development) is the only one
 * when set. Full paths, so the terminal host needn't search PATH.
 */

export type Shell = ShellProfile & { cmd: string[] };

/** Container tools' own distros (Docker Desktop, Rancher Desktop, Podman): not for people. */
const NOT_FOR_PEOPLE = /^(docker-desktop(-data)?|rancher-desktop(-data)?|podman-machine(-.*)?)$/i;

/** The WSL distros installed (`wsl -l -q` writes UTF-16), or none. */
export function wslDistros(run: () => Buffer = () => execFileSync('wsl.exe', ['-l', '-q'], { timeout: 4000, windowsHide: true })): string[] {
  try {
    const raw = run();
    const text = raw.length > 1 && raw[1] === 0 ? raw.toString('utf16le') : raw.toString('utf8');
    return text
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !NOT_FOR_PEOPLE.test(l));
  } catch {
    return [];
  }
}

export function detectShells(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync, win = process.platform === 'win32', distros: () => string[] = wslDistros): Shell[] {
  if (env.CORA_SHELL_CMD) return [{ id: 'custom', name: 'Shell', cmd: JSON.parse(env.CORA_SHELL_CMD) as string[] }];
  if (!win) {
    const sh = env.SHELL || '/bin/sh';
    return [{ id: 'default', name: basename(sh), cmd: [sh] }];
  }
  const out: Shell[] = [];
  const sys = join(env.SystemRoot ?? 'C:\\Windows', 'System32');
  const dirs = (env.PATH ?? env.Path ?? '').split(win ? ';' : delimiter).filter(Boolean);
  const pf = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter((p): p is string => !!p);
  const pwsh = [...dirs, ...pf.map((p) => join(p, 'PowerShell', '7'))].map((d) => join(d, 'pwsh.exe')).find(exists);
  if (pwsh) out.push({ id: 'pwsh', name: 'PowerShell', cmd: [pwsh, '-NoLogo'] });
  const winPs = join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  out.push({ id: 'powershell', name: pwsh ? 'Windows PowerShell' : 'PowerShell', cmd: [exists(winPs) ? winPs : 'powershell.exe', '-NoLogo'] });
  const cmd = join(sys, 'cmd.exe');
  out.push({ id: 'cmd', name: 'Command Prompt', cmd: [exists(cmd) ? cmd : 'cmd.exe'] });
  const gitRoots = [...pf.map((p) => join(p, 'Git')), ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'Git')] : [])];
  const bash = gitRoots.map((r) => join(r, 'bin', 'bash.exe')).find(exists);
  if (bash) out.push({ id: 'gitbash', name: 'Git Bash', cmd: [bash, '--login', '-i'] });
  // WSL: started in the session's folder (Windows maps it: C:\code → /mnt/c/code)
  const wsl = join(sys, 'wsl.exe');
  if (exists(wsl)) for (const d of distros()) out.push({ id: `wsl:${d}`, name: d, wsl: true, cmd: [wsl, '-d', d] });
  return out;
}

/** The shell to open: the one asked for, else the default, else the first. */
export function pickShell(shells: Shell[], id?: string, fallback?: string): Shell {
  return shells.find((s) => s.id === id) ?? shells.find((s) => s.id === fallback) ?? shells[0];
}
