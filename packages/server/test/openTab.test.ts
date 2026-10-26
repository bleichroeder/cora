import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type UiCommand } from '@cora/shared';
import { registerMcp } from '../src/mcp';

const H = { 'x-cora-token': 'tok', 'x-cora-session': 'sess-open-1', accept: 'application/json, text/event-stream', 'content-type': 'application/json' };

function setup(o: { othersTurn?: boolean } = {}) {
  const sent: UiCommand[] = [];
  const app = Fastify();
  const settings = { ...DEFAULT_SETTINGS, gitlab: { host: 'gitlab.acme.io', todos: true } };
  const orch = o.othersTurn ? { isAgent: (sid: string) => sid === 'sess-open-1', deps: () => ({ othersTurn: () => true }) as any } : undefined;
  registerMcp(app, 'tok', () => settings, undefined, orch, undefined, undefined, undefined, undefined, 'tok', (cmd) => sent.push(cmd));
  const call = async (url: string, headers: Record<string, string> = H) => {
    const r = await app.inject({ method: 'POST', url: '/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'open_tab', arguments: { url } } } });
    return JSON.parse(r.body).result as { isError?: boolean; content: Array<{ text: string }> };
  };
  return { sent, call };
}

// docs/audit-2026-10-20.md S15: the tool is what opens a page, after its checks; never the call in a transcript
describe('open_tab', () => {
  it("opens the user's own sites; asks about others", async () => {
    const { sent, call } = setup();
    expect((await call('https://github.com/acme/app/pull/3')).content[0].text).toMatch(/^Opened/);
    expect((await call('https://gitlab.acme.io/team/app/-/merge_requests/9')).content[0].text).toMatch(/^Opened/);
    expect((await call('https://evil.example/?d=secrets')).content[0].text).toMatch(/otherwise they're asked first/);
    expect(sent).toEqual([
      { action: 'open_tab', url: 'https://github.com/acme/app/pull/3', known: true, sessionId: 'sess-open-1' },
      { action: 'open_tab', url: 'https://gitlab.acme.io/team/app/-/merge_requests/9', known: true, sessionId: 'sess-open-1' },
      { action: 'open_tab', url: 'https://evil.example/?d=secrets', known: false, sessionId: 'sess-open-1' },
    ]);
  });

  it('a refused call opens nothing: not http(s), or Cora on a turn someone else started', async () => {
    const a = setup();
    expect((await a.call('file:///C:/Users/x/.ssh/id_rsa')).isError).toBe(true);
    expect(a.sent).toEqual([]);
    const b = setup({ othersTurn: true });
    const r = await b.call('https://github.com/x', { ...H, 'x-cora-agent': 'tok' });
    expect(r.isError).toBe(true);
    expect(b.sent).toEqual([]);
  });
});
