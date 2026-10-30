import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { socketPath } from './protocol';
import { startHost } from './host';

// The terminal host process: `node ptyhost.js --data <Cora's data dir>`. Started detached by the server.
const i = process.argv.indexOf('--data');
const dataDir = i >= 0 ? process.argv[i + 1] : '';
if (!dataDir) {
  console.error('usage: ptyhost --data <dir>');
  process.exit(2);
}
const log = (m: string) => console.log(`${new Date().toISOString()} [ptyhost ${process.pid}] ${m}`);
// its own key (Cora writes it before starting the host); an older Cora's host used the hook token
const token = (() => {
  try {
    return readFileSync(join(dataDir, 'host-token'), 'utf8').trim() || readFileSync(join(dataDir, 'token'), 'utf8').trim();
  } catch {
    return readFileSync(join(dataDir, 'token'), 'utf8').trim();
  }
})();

process.on('uncaughtException', (e) => log(`uncaught: ${e.stack ?? e}`));
// never in a folder that gets replaced (Electron's own, an update's): Windows won't rename a folder a process runs in
try {
  process.chdir(dataDir);
} catch {
  /* stays where it was started */
}
// the folder it runs from: said in its hello, and its pid kept there (an installed Cora's runtime folder), so a newer
// Cora never removes a folder a host still runs from
const hostDir = dirname(fileURLToPath(import.meta.url));
try {
  if (existsSync(join(hostDir, 'ready'))) writeFileSync(join(hostDir, 'host.pid'), String(process.pid));
} catch {
  /* not kept: a newer Cora asks Windows instead */
}
startHost({ path: socketPath(dataDir), token, log, dir: hostDir, onClose: () => process.exit(0) }).catch((e) => {
  // most likely another host is already listening on the pipe
  log(`could not start: ${(e as Error).message}`);
  process.exit(1);
});
