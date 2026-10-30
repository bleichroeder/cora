import { createRequire } from 'node:module';

export type PtyLike = {
  onData(cb: (d: string) => void): unknown;
  onExit(cb: (e: { exitCode: number }) => void): unknown;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};
export type SpawnFn = (file: string, args: string[], o: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }) => PtyLike;

/**
 * Real PTYs via @lydell/node-pty (prebuilt binaries), loaded lazily so tests and non-terminal use never touch it. On
 * Windows through its own console (conpty.dll and OpenConsole, as Windows Terminal uses): the system's left a console
 * host behind for every terminal that exited (~8 MB each, for as long as the terminal host ran); this one goes with it.
 */
export const nodePtySpawn: SpawnFn = (file, args, o) => {
  const pty = createRequire(import.meta.url)('@lydell/node-pty') as typeof import('@lydell/node-pty');
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env as Record<string, string>, ...(process.platform === 'win32' ? { useConptyDll: true } : {}) });
  // killed once, ever: a second kill of the same terminal corrupts the heap in that console code and the whole host
  // goes (0xC0000374), every session's terminal with it (a shell's tab closed while the board closed it too)
  let killed = false;
  const kill = p.kill.bind(p);
  p.kill = (signal?: string) => {
    if (killed) return;
    killed = true;
    kill(signal);
  };
  return p;
};
