import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recapText } from '@cora/shared';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';
import { Store } from '../src/store';
import { newParseCtx, parseLine } from '../src/transcript/parse';

let srv: Running;
afterEach(async () => srv?.close());
const cfg = () => loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-recap-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope-client') });
const H = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };
const recapLine = (uuid: string, iso: string, content: string, sessionId = 's1') => ({ type: 'system', subtype: 'away_summary', content, timestamp: iso, uuid, sessionId, cwd: 'C:\\code\\x', version: '2.1.281', isMeta: false });

describe('recaps', () => {
  it("are read from the transcript without Claude Code's note on turning them off", () => {
    expect(recapText('You are setting up X. Next, run Y. (disable recaps in /config)')).toBe('You are setting up X. Next, run Y.');
    // written in the session's style: Cora's say line copied in
    expect(recapText('I mapped the pages. Next, your ideas.\n\n<!-- say: I mapped the pages. Next, your ideas. --> (disable recaps in /config)')).toBe('I mapped the pages. Next, your ideas.');
    const { meta, events } = parseLine(recapLine('r1', '2026-10-21T03:03:39.067Z', 'Where it stands. (disable recaps in /config)'), newParseCtx());
    expect(meta.recap).toEqual({ id: 'r1', text: 'Where it stands.', at: Date.parse('2026-10-21T03:03:39.067Z') });
    expect(events).toEqual([]);
  });

  it('are kept once each, listed oldest first, and pruned with the rest of history', () => {
    const s = new Store(':memory:');
    expect(s.addRecap({ id: 'a', sessionId: 's1', at: 1000, text: 'one' })).toBe(true);
    expect(s.addRecap({ id: 'a', sessionId: 's1', at: 1000, text: 'one' })).toBe(false);
    s.addRecap({ id: 'b', sessionId: 's2', at: 2000, text: 'two' });
    s.addRecap({ id: 'c', sessionId: 's1', at: 3000, text: 'three' });
    expect(s.recaps().map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(s.recaps({ sessionId: 's1' }).map((r) => r.text)).toEqual(['one', 'three']);
    expect(s.recaps({ since: 1500 }).map((r) => r.id)).toEqual(['b', 'c']);
    s.prune(2500);
    expect(s.recaps().map((r) => r.id)).toEqual(['c']);
  });

  it("give the session its latest (an older one read later doesn't replace it), and the API lists them", async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    const info = { sessionId: 's1', agentId: 'main', projectSlug: 'C--code-x' } as never;
    srv.pipeline.ingestTranscript('s1.jsonl', [recapLine('r2', '2026-10-21T13:10:14.063Z', 'Newer. (disable recaps in /config)')], info);
    srv.pipeline.ingestTranscript('s1.jsonl', [recapLine('r1', '2026-10-21T03:03:39.067Z', 'Older.')], info);
    expect(srv.store.getSession('s1')?.recap).toEqual({ text: 'Newer.', at: Date.parse('2026-10-21T13:10:14.063Z') });
    const r = await srv.app.inject({ method: 'GET', url: '/api/recaps?session=s1', headers: H });
    expect((r.json() as { recaps: Array<{ text: string }> }).recaps.map((x) => x.text)).toEqual(['Older.', 'Newer.']);
  });
});
