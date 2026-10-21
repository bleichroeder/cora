import { join, resolve } from 'node:path';

/**
 * Where Cora's parts are and how they run: in a dev checkout (the repo; the server on the system's Node) or installed
 *. The installed app keeps
 * the repo's layout under resources/app, so the paths between its parts are the same.
 */
export type Runtime = {
  packaged: boolean;
  /** the repo, or the installed app's folder (resources/app) */
  root: string;
  /** the server's CLI (`cli.js start`, `cli.js install`) */
  cli: string;
  /** how to run it: the system's node, or Cora.exe as Node (Electron's own) */
  node: { file: string; env: Record<string, string | undefined> };
  /** the standalone Node the terminal host runs on, outside the install folder (installed only) */
  hostNode?: string;
  /** what starts Cora at login */
  login: { path: string; args: string[] };
  /** the server's extra arguments: an installed Cora is updated by its updater, not the dev security check's npm */
  serverArgs: string[];
};

export function runtimeFor(o: { packaged: boolean; execPath: string; dirname: string; resourcesPath: string }): Runtime {
  // packages/desktop/dist → the repo (or resources/app)
  const root = resolve(o.dirname, '..', '..', '..');
  const cli = join(root, 'packages', 'server', 'dist', 'cli.js');
  if (o.packaged)
    return {
      packaged: true,
      root,
      cli,
      node: { file: o.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
      hostNode: join(o.resourcesPath, 'node', 'node.exe'),
      login: { path: o.execPath, args: ['--hidden'] },
      serverArgs: ['--no-security-check'],
    };
  return {
    packaged: false,
    root,
    cli,
    node: { file: 'node', env: { ELECTRON_RUN_AS_NODE: undefined } },
    // electron.exe needs Cora's folder (without it, an Electron that isn't made Cora's opens its demo app)
    login: { path: o.execPath, args: [join(root, 'packages', 'desktop'), '--hidden'] },
    serverArgs: [],
  };
}
