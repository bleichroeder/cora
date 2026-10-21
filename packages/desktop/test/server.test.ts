import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { ensureServer, probe, runningText, whoIs } from '../src/server';

let servers: Server[] = [];
afterEach(() => {
  servers.forEach((s) => s.close());
  servers = [];
});

const KEY = 'k'.repeat(64);
const keyFile = () => {
  const f = join(mkdtempSync(join(tmpdir(), 'ab-desk-')), 'token');
  writeFileSync(f, KEY + '\n');
  return f;
};
/** A real Cora answers the challenge with its key (never sending it); an impostor just answers. */
const listen = (port: number, o: { key?: string } = {}) =>
  new Promise<void>((r) => {
    const s = createServer((q, res) => {
      const n = new URL(q.url ?? '/', 'http://x').searchParams.get('n');
      if (o.key && q.url?.startsWith('/api/hello') && n) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ cora: true, mac: createHmac('sha256', o.key).update(`cora-hello:${n}`).digest('hex') }));
      res.writeHead(401).end();
    });
    servers.push(s);
    s.listen(port, '127.0.0.1', () => r());
  });

// docs/audit-2026-10-20.md S17: Cora is whoever proves it holds Cora's key, not whatever answers on the port
describe('desktop server lifecycle', () => {
  it('Cora is whoever proves it; anything else on the port is not, and nothing is nobody', async () => {
    const f = keyFile();
    await listen(47411, { key: KEY });
    await listen(47415);
    await listen(47416, { key: 'another' });
    expect(await whoIs(47411, f)).toBe('cora');
    expect(await whoIs(47415, f)).toBe('other');
    expect(await whoIs(47416, f)).toBe('other');
    expect(await whoIs(47412, f)).toBe('none');
    expect(await probe(47411, f)).toBe(true);
    expect(await probe(47415, f)).toBe(false);
  });

  it('uses an already-running Cora without owning it; refuses an impostor', async () => {
    const f = keyFile();
    await listen(47413, { key: KEY });
    const s = await ensureServer({ port: 47413, cliPath: 'unused.js', logFile: join(tmpdir(), 'ab-desktop.log'), tokenFile: f });
    expect(s.owned).toBe(false);
    await listen(47417);
    await expect(ensureServer({ port: 47417, cliPath: 'unused.js', logFile: join(tmpdir(), 'ab-desktop.log'), tokenFile: f })).rejects.toThrow(/Something else is answering on port 47417/);
  });

  it('spawns the CLI when nothing is running, waits for it, and stops it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-desk-'));
    const f = join(dir, 'token');
    writeFileSync(f, KEY + '\n');
    const fake = join(dir, 'fake-cli.cjs');
    writeFileSync(fake, `const p = Number(process.argv[process.argv.indexOf('--port') + 1]);
const key = require('node:fs').readFileSync(require('node:path').join(process.env.CORA_HOME, 'token'), 'utf8').trim();
require('node:http').createServer((q, r) => {
  const n = new URL(q.url, 'http://x').searchParams.get('n');
  if (q.url.startsWith('/api/hello') && n) return r.writeHead(200).end(JSON.stringify({ mac: require('node:crypto').createHmac('sha256', key).update('cora-hello:' + n).digest('hex') }));
  r.writeHead(401).end();
}).listen(p, '127.0.0.1');`);
    const s = await ensureServer({ port: 47414, cliPath: fake, logFile: join(dir, 'server.log'), timeoutMs: 10_000, tokenFile: f });
    expect(s.owned).toBe(true);
    expect(await probe(47414, f)).toBe(true);
    await s.stop();
    await new Promise((r) => setTimeout(r, 500));
    expect(await probe(47414, f)).toBe(false);
  });
});

describe('quit prompt', () => {
  it('names Claude sessions and shells', () => {
    expect(runningText(1)).toBe('1 Claude session is running in Cora.');
    expect(runningText(3, 1)).toBe('2 Claude sessions and 1 shell are running in Cora.');
    expect(runningText(2, 2)).toBe('2 shells are running in Cora.');
  });
});
