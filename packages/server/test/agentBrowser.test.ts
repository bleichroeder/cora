import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@cora/shared';
import { findPlaywright, playwrightInCora } from '../src/agentPlaywright';
import { CdpBridge, cdpEndpoint, cdpKey } from '../src/cdpBridge';
import { hostedArgs } from '../src/hosted';
import { loadConfig } from '../src/config';

const files = (m: Record<string, unknown>) => (p: string) => {
  const k = Object.keys(m).find((x) => p.replace(/\\/g, '/').endsWith(x));
  if (!k) throw new Error('ENOENT');
  return JSON.stringify(m[k]);
};

describe("a session's Playwright in Cora's browser", () => {
  it('finds your Playwright MCP server: the folder\'s own first, then the project\'s .mcp.json, then yours', () => {
    const user = { command: 'npx', args: ['@playwright/mcp@latest'] };
    const local = { command: 'npx', args: ['@playwright/mcp@0.0.40'] };
    const project = { command: 'node', args: ['pw.js'] };
    expect(findPlaywright('C:\\work\\app', files({ '.claude.json': { mcpServers: { playwright: user } } }), 'H')).toEqual(user);
    expect(findPlaywright('C:\\work\\app', files({ '.claude.json': { mcpServers: { playwright: user } }, 'app/.mcp.json': { mcpServers: { playwright: project } } }), 'H')).toEqual(project);
    expect(findPlaywright('C:\\work\\app', files({ '.claude.json': { mcpServers: { playwright: user }, projects: { 'C:/work/app': { mcpServers: { playwright: local } } } } }), 'H')).toEqual(local);
    // none, or not one that runs here (an http server)
    expect(findPlaywright('C:\\work\\app', files({ '.claude.json': { mcpServers: {} } }), 'H')).toBeNull();
    expect(findPlaywright(undefined, files({ '.claude.json': { mcpServers: { playwright: { type: 'http', url: 'http://x' } } } }), 'H')).toBeNull();
  });

  it('runs yours, pointed at Cora\'s browser: its own browser\'s options dropped', () => {
    const s = playwrightInCora({ command: 'cmd', args: ['/c', 'npx', '-y', '@playwright/mcp@latest', '--isolated', '--browser', 'msedge', '--user-data-dir=C:\\x', '--caps', 'vision'], env: { A: '1' } }, 'ws://127.0.0.1:4317/cdp/s1?k=K');
    expect(s).toEqual({ type: 'stdio', command: 'cmd', args: ['/c', 'npx', '-y', '@playwright/mcp@latest', '--caps', 'vision', '--cdp-endpoint', 'ws://127.0.0.1:4317/cdp/s1?k=K'], env: { PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: 'true', A: '1' } });
  });

  it("lets it reach files (a file:// preview, a screenshot to the scratchpad) unless you said otherwise", () => {
    expect(playwrightInCora({ command: 'npx', args: [] }, 'ws://x').env).toEqual({ PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: 'true' });
    expect(playwrightInCora({ command: 'npx', args: [], env: { PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: 'false' } }, 'ws://x').env).toEqual({ PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: 'false' });
  });

  it("each session connects with its own key; the session's MCP config gets it unless it's off or you don't use Playwright", () => {
    expect(cdpKey('secret', 's1')).not.toBe(cdpKey('secret', 's2'));
    expect(cdpEndpoint(4317, 'secret', 'sess-0001')).toBe(`ws://127.0.0.1:4317/cdp/sess-0001?k=${cdpKey('secret', 'sess-0001')}`);
    const cfg = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-pw-')), hookToken: 't', uiToken: 'u' });
    const mcpOf = (args: string[]) => JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers;
    const pw = () => ({ command: 'npx', args: ['@playwright/mcp@latest'] });
    const on = mcpOf(hostedArgs(cfg, DEFAULT_SETTINGS, 'sess-0001', undefined, undefined, 'C:\\w', pw));
    expect(on.playwright).toEqual({ type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest', '--cdp-endpoint', cdpEndpoint(cfg.port, 't', 'sess-0001')], env: { PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: 'true' } });
    expect(on.cora).toBeTruthy();
    expect(mcpOf(hostedArgs(cfg, { ...DEFAULT_SETTINGS, browser: { ...DEFAULT_SETTINGS.browser, playwright: 'off' } }, 'sess-0002', undefined, undefined, 'C:\\w', pw)).playwright).toBeUndefined();
    expect(mcpOf(hostedArgs(cfg, DEFAULT_SETTINGS, 'sess-0003', undefined, undefined, 'C:\\w', () => null)).playwright).toBeUndefined();
  });

  it("passes each Playwright connection's messages to the desktop app and back, by an id of its own", () => {
    type S = { sent: string[]; closed?: [number?, string?]; h: Record<string, (d?: unknown) => void>; send(d: string): void; close(c?: number, r?: string): void; on(ev: string, f: (d?: unknown) => void): void };
    const sock = (): S => {
      const s: S = { sent: [], h: {}, send: (d) => void s.sent.push(d), close: (c, r) => void (s.closed = [c, r]), on: (ev, f) => void (s.h[ev] = f) };
      return s;
    };
    const b = new CdpBridge();
    const early = sock();
    b.attachClient(early as never, 'sess-0001');
    expect(early.closed?.[1]).toMatch(/desktop app/);
    const desk = sock();
    b.attachDesktop(desk as never);
    const pw = sock();
    b.attachClient(pw as never, 'sess-0001');
    expect(JSON.parse(desk.sent[0])).toEqual({ t: 'open', c: 'c1', sid: 'sess-0001' });
    pw.h.message('{"id":1,"method":"Browser.getVersion"}');
    expect(JSON.parse(desk.sent[1])).toEqual({ t: 'msg', c: 'c1', d: '{"id":1,"method":"Browser.getVersion"}' });
    desk.h.message(JSON.stringify({ t: 'msg', c: 'c1', d: '{"id":1,"result":{}}' }));
    expect(pw.sent).toEqual(['{"id":1,"result":{}}']);
    pw.h.close();
    expect(JSON.parse(desk.sent[2])).toEqual({ t: 'close', c: 'c1' });
    // the desktop app going ends its connections
    const pw2 = sock();
    b.attachClient(pw2 as never, 'sess-0001');
    desk.h.close();
    expect(pw2.closed?.[1]).toMatch(/desktop app went/);
    expect(b.available).toBe(false);
  });
});
