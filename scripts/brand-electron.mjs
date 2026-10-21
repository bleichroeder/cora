// Make this repo's Electron behave like an installed Cora on Windows (the development setup runs Electron straight
// from node_modules). Two things, both needed:
//   - its product name and icon become Cora's. Electron keeps a Start-menu shortcut of its own for notifications,
//     named after the program's product name and pointing at it with no arguments: "Electron.lnk" otherwise, which
//     Windows then shows Cora as.
//   - resources/app loads Cora. With no arguments (that shortcut, the login item) electron.exe then opens Cora, not
//     Electron's demo app. Launches with `packages/desktop` still work: Electron runs resources/app either way.
// Run it while Cora is closed (Windows locks a running .exe):
//   node scripts/brand-electron.mjs [--repo <repo>] [--icon <file.ico>]
// update-electron.mjs runs it after each Electron update (an update replaces Electron's folder).
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const repo = resolve(arg('repo') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const dist = join(repo, 'node_modules', 'electron', 'dist');
const exe = join(dist, 'electron.exe');
const data = process.env.CORA_HOME ?? join(homedir(), '.cora');
const icon = [arg('icon'), join(data, 'cora.ico'), join(repo, 'packages', 'desktop', 'cora.ico')].find((f) => f && existsSync(f));

/** Brand it; returns what it did (or throws). */
export async function brand() {
  if (process.platform !== 'win32') return 'not Windows: nothing to do';
  if (!existsSync(exe)) throw new Error(`no Electron at ${exe}`);
  const desktop = JSON.parse(readFileSync(join(repo, 'packages', 'desktop', 'package.json'), 'utf8'));
  const rcedit = createRequire(join(repo, 'package.json'))('rcedit');
  await rcedit(exe, { 'version-string': { ProductName: 'Cora', FileDescription: 'Cora' }, ...(icon ? { icon } : {}) });
  // the same name and product name as the real app, so its profile folder (and so its saved state) is the same
  const app = join(dist, 'resources', 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: desktop.name, productName: desktop.productName, version: desktop.version, private: true, main: 'index.js' }, null, 2) + '\n');
  writeFileSync(join(app, 'index.js'), `// Cora, from ${repo} (written by scripts/brand-electron.mjs)\nrequire(${JSON.stringify(join(repo, 'packages', 'desktop', 'dist', 'main.cjs'))});\n`);
  const version = readFileSync(join(dist, 'version'), 'utf8').trim();
  writeFileSync(join(dist, 'cora-brand.json'), JSON.stringify({ electron: version, repo, icon: icon ?? null, at: new Date().toISOString() }, null, 2) + '\n');
  return `Electron ${version} is Cora now${icon ? ` (icon ${icon})` : ''}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  brand().then(
    (m) => console.log(m),
    (e) => {
      console.error(`couldn't brand Electron: ${e.message}${/EBUSY|being used|access/i.test(e.message) ? ' (close Cora first: Windows locks a running .exe)' : ''}`);
      process.exit(1);
    },
  );
}
