import { createRequire } from 'node:module';

export type PtyLike = {
  onData(cb: (d: string) => void): unknown;
  onExit(cb: (e: { exitCode: number }) => void): unknown;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};
export type SpawnFn = (file: string, args: string[], o: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }) => PtyLike;

/** Real PTYs via @lydell/node-pty (prebuilt binaries), loaded lazily so tests and non-terminal use never touch it. */
export const nodePtySpawn: SpawnFn = (file, args, o) => {
  const pty = createRequire(import.meta.url)('@lydell/node-pty') as typeof import('@lydell/node-pty');
  return pty.spawn(file, args, { name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env as Record<string, string> });
};
