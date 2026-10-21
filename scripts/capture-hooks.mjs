// Captures real Claude Code hook payloads for test fixtures.
// usage: node scripts/capture-hooks.mjs <outDir> [port=4399]
// Each POST /hook/<Event> is written to <outDir>/<nn>-<Event>.json (with received headers).
// PermissionRequest/Elicitation get an empty JSON response (= no decision).
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? 'captured';
const port = Number(process.argv[3] ?? 4399);
mkdirSync(outDir, { recursive: true });
let n = 0;

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const event = decodeURIComponent((req.url ?? '').split('/').pop() ?? 'unknown');
    const file = join(outDir, `${String(++n).padStart(3, '0')}-${event}.json`);
    let json;
    try { json = JSON.parse(body); } catch { json = { raw: body }; }
    writeFileSync(file, JSON.stringify({ receivedAt: Date.now(), headers: { token: (req.headers['x-cora-token'] ?? req.headers['x-agent-brain-token']) }, body: json }, null, 2));
    console.log(new Date().toISOString(), event);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}).listen(port, '127.0.0.1', () => console.log(`capturing on http://127.0.0.1:${port} → ${outDir}`));
