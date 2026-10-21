import { describe, expect, it } from 'vitest';
import { fuzzy, lineOf, matchEntry, pushRecent, rank, recentFolders, runs, searchLines, snippet, tokensOf, type Entry } from '../src/lib/palette';

const at = (text: string, hits: number[]) => hits.map((h) => text[h]).join('');

describe('fuzzy', () => {
  it('prefers a substring, more so at the start of the text or a word', () => {
    const a = fuzzy('cora', 'cora-shell')!;
    const b = fuzzy('cora', 'my-cora')!;
    const c = fuzzy('cora', 'decorator')!;
    expect(a.score).toBeGreaterThan(b.score);
    expect(b.score).toBeGreaterThan(c.score);
    expect(at('cora-shell', a.hits)).toBe('cora');
  });
  it('takes the occurrence at a word start over an earlier one mid-word', () => {
    const h = fuzzy('set', 'reset settings')!;
    expect(h.hits[0]).toBe(6);
  });
  it('matches letters in order, landing on word starts', () => {
    const t = 'Settings: Voice';
    const h = fuzzy('stv', t)!;
    expect(h).not.toBeNull();
    expect(at(t, h.hits)).toBe('StV');
    expect(h.hits).toEqual([0, 2, 10]);
    expect(h.score).toBeLessThan(fuzzy('voice', t)!.score);
  });
  it('rejects letters out of order, short scattered queries and hopelessly scattered ones', () => {
    expect(fuzzy('vs', 'Settings: Voice')).toBeNull();
    expect(fuzzy('xyz', 'Settings')).toBeNull();
    expect(fuzzy('aei', 'zzzzzzzazzzzzzzezzzzzzzzi')).toBeNull();
    expect(fuzzy('voi', 'version and dev environment')).toBeNull();
    expect(fuzzy('reading', 'WSL GitLab repos Visual Studio debugging output')).toBeNull();
  });
  it('allows one piece to begin mid-word', () => {
    expect(fuzzy('tvo', 'Settings: Voice')).not.toBeNull();
  });
  it('treats camelCase humps as word starts', () => {
    const t = 'useCursorStep';
    expect(at(t, fuzzy('ucs', t)!.hits)).toBe('uCS');
  });
});

describe('matchEntry', () => {
  it('needs every word, from the label, the detail or the keywords', () => {
    const e = { label: 'New session in cora', detail: 'C:/Code/cora', keywords: 'launch start' };
    expect(matchEntry(tokensOf('new cora'), e)).not.toBeNull();
    expect(matchEntry(tokensOf('launch code'), e)).not.toBeNull();
    expect(matchEntry(tokensOf('new banana'), e)).toBeNull();
  });
  it('highlights in the label when the label matches, in the detail otherwise', () => {
    const m = matchEntry(['code'], { label: 'cora', detail: 'C:/Code/cora' })!;
    expect(m.labelHits).toEqual([]);
    expect(m.detailHits).toEqual([3, 4, 5, 6]);
  });
});

describe('rank', () => {
  const entries: Entry[] = [
    { id: 'session:a', group: 'session', label: 'palette work', boost: 2 },
    { id: 'session:b', group: 'session', label: 'jira chips', boost: 1 },
    { id: 'cmd:settings', group: 'command', label: 'Settings', featured: true },
    { id: 'cmd:voice', group: 'command', label: 'Settings: Voice' },
    { id: 'older:x', group: 'older', label: 'set up the palette' },
  ];
  it('with no query: recent picks first, then sessions by boost, then featured entries', () => {
    const g = rank(entries, '', { recent: ['cmd:voice', 'gone'] });
    expect(g.map((x) => x.id)).toEqual(['recent', 'session', 'command']);
    expect(g[0].items.map((r) => r.e.id)).toEqual(['cmd:voice']);
    expect(g[1].items.map((r) => r.e.id)).toEqual(['session:a', 'session:b']);
    expect(g[2].items.map((r) => r.e.id)).toEqual(['cmd:settings']);
  });
  it('with a query: groups in order of their best match', () => {
    const g = rank(entries, 'settings', { recent: [] });
    expect(g[0].id).toBe('command');
    expect(g[0].items[0].e.id).toBe('cmd:settings');
    const p = rank(entries, 'palette', { recent: [] });
    expect(p[0].items[0].e.id).toBe('session:a');
  });
  it('lifts recent picks', () => {
    const plain = rank(entries, 'settings', { recent: [] })[0].items.map((r) => r.e.id);
    const lifted = rank(entries, 'settings', { recent: ['cmd:voice'] })[0].items.map((r) => r.e.id);
    expect(plain[0]).toBe('cmd:settings');
    expect(lifted[0]).toBe('cmd:voice');
  });
  it('caps each group', () => {
    const many: Entry[] = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, group: 'session', label: `session ${i}` }));
    expect(rank(many, 'session', { recent: [] })[0].items).toHaveLength(8);
    expect(rank(many, 'session', { recent: [], caps: { session: 3 } })[0].items).toHaveLength(3);
  });
  it('takes pre-matched entries as they are', () => {
    const g = rank([{ id: 't', group: 'transcript', label: 'whatever', pre: { score: 60, labelHits: [1] } }], 'zzz', { recent: [] });
    expect(g[0].items[0].score).toBe(60);
  });
});

describe('runs', () => {
  it('merges adjacent hits into ranges', () => {
    expect(runs([5, 0, 1, 2, 6, 2])).toEqual([[0, 3], [5, 7]]);
  });
});

describe('transcript lines', () => {
  const ev = (id: string, ts: number, kind: string, text: string, extra = {}) => ({ id, ts, kind, agentId: 'main', text, ...extra });
  it('flattens replies, prompts and tool calls; skips the rest', () => {
    expect(lineOf(ev('1', 1, 'say', '**Done.**\n\n# Heading\nUse `npm`'))!.text).toBe('Done. Heading Use npm');
    expect(lineOf({ id: '2', ts: 1, kind: 'tool', agentId: 'main', phase: 'start', toolUseId: 'u', tool: { name: 'mcp__cora__present', summary: 'Plan' } })!.text).toBe('present Plan');
    expect(lineOf({ id: '3', ts: 1, kind: 'tool', agentId: 'main', phase: 'end', tool: { name: 'Bash', summary: 'ls' } })).toBeNull();
    expect(lineOf(ev('4', 1, 'think', 'hidden'))).toBeNull();
  });
  it('finds lines holding every word, newest first, stopping at the cap', () => {
    const lines = [ev('a', 1000, 'say', 'the palette opens'), ev('b', 2000, 'prompt', 'make a palette please'), ev('c', 3000, 'say', 'nothing here')].map((e) => lineOf(e)!);
    const hits = searchLines([{ sessionId: 's', lines }], ['palette'], 3000);
    expect(hits.map((h) => h.line.id)).toEqual(['b', 'a']);
    expect(searchLines([{ sessionId: 's', lines }], ['palette', 'opens'], 3000).map((h) => h.line.id)).toEqual(['a']);
    expect(searchLines([{ sessionId: 's', lines }], ['palette'], 3000, 1)).toHaveLength(1);
    expect(searchLines([{ sessionId: 's', lines }], ['pa'], 3000)).toEqual([]);
  });
  it('shows the same words once per session, the newest', () => {
    const lines = [ev('a', 1, 'prompt', 'run the tests'), ev('b', 2, 'prompt', 'Run the  tests')].map((e) => lineOf(e)!);
    expect(searchLines([{ sessionId: 's', lines }, { sessionId: 't', lines }], ['tests'], 2).map((h) => `${h.sessionId}${h.line.id}`)).toEqual(['sb', 'tb']);
  });
  it('ranks the boosted (focused) session first', () => {
    const l = (id: string) => [lineOf(ev(id, 1000, 'say', 'palette'))!];
    const hits = searchLines([{ sessionId: 'x', lines: l('x') }, { sessionId: 'y', lines: l('y'), boost: 15 }], ['palette'], 1000);
    expect(hits[0].sessionId).toBe('y');
  });
});

describe('snippet', () => {
  it('cuts around the first match at word edges and marks every match', () => {
    const text = `${'lorem ipsum '.repeat(20)}the palette is here and the palette again ${'dolor '.repeat(30)}`;
    const s = snippet(text, text.toLowerCase(), ['palette'], 80);
    expect(s.snippet.startsWith('…')).toBe(true);
    expect(s.snippet.endsWith('…')).toBe(true);
    expect(s.snippet.length).toBeLessThanOrEqual(84);
    const words = runs(s.hits).map(([a, b]) => s.snippet.slice(a, b));
    expect(words).toEqual(['palette', 'palette']);
  });
  it('keeps a short text whole', () => {
    expect(snippet('find me', 'find me', ['me']).snippet).toBe('find me');
  });
});

describe('recent picks and folders', () => {
  it('moves a pick to the front once and keeps the list short', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pushRecent(['a', 'b'], 'c', 2)).toEqual(['c', 'a']);
  });
  it('lists folders newest first, once each, whatever their slashes or case', () => {
    const f = recentFolders([
      { cwd: 'C:\\Code\\cora', ts: 1 },
      { cwd: 'c:/code/cora/', ts: 5 },
      { cwd: 'C:\\Code\\other', ts: 3 },
      { cwd: '', ts: 9 },
    ]);
    expect(f).toEqual(['c:/code/cora/', 'C:\\Code\\other']);
  });
});
