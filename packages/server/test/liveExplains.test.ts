import { mkdtempSync, mkdirSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { artifactUrl } from '@cora/shared';
import { LiveExplains, sharePrompt, slugOf, type LiveData, type LiveVersion } from '../src/liveExplains';

const SID = 'sess-live-0001';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let live: LiveExplains | null = null;
afterEach(() => live?.stop());

function make() {
  const root = mkdtempSync(join(tmpdir(), 'cora-live-'));
  const versions: LiveVersion[] = [];
  const data: LiveData[] = [];
  live = new LiveExplains({ root, onVersion: (v) => versions.push(v), onData: (d) => data.push(d), settleMs: 20 });
  return { root, live, versions, data };
}

describe('live explains', () => {
  it('a title is a folder name, and the same title is the same folder', () => {
    expect(slugOf('Release 2.4: build & deploy!')).toBe('release-24-build-deploy');
    expect(slugOf('  ')).toBe('live');
    const { live: l, root } = make();
    const a = l.start(SID, 'Release 2.4');
    expect(a).toEqual({ slug: 'release-24', dir: join(root, SID, 'release-24'), page: join(root, SID, 'release-24', 'page.html'), data: join(root, SID, 'release-24', 'data.json') });
    expect(l.start(SID, 'Release  2.4 ').slug).toBe('release-24');
    expect(() => l.start('../../x', 'x')).toThrow(/not a session/);
  });

  it('a page write is a version (a burst of writes, one); a data write is sent on; a same page is no new version', async () => {
    const { live: l, versions, data } = make();
    const f = l.start(SID, 'Release 2.4');
    l.watch();
    writeFileSync(f.page, '<p>one</p>');
    writeFileSync(f.page, '<p>two</p>');
    await wait(400);
    expect(versions).toEqual([{ sessionId: SID, slug: 'release-24', title: 'Release 2.4', html: '<p>two</p>' }]);
    writeFileSync(f.data, JSON.stringify({ passed: 41, total: 60 }));
    await wait(400);
    expect(data).toEqual([{ sessionId: SID, slug: 'release-24', data: { passed: 41, total: 60 } }]);
    expect(l.latestData(SID, 'release-24')).toEqual({ passed: 41, total: 60 });
    writeFileSync(f.page, '<p>two</p>');
    await wait(400);
    expect(versions).toHaveLength(1);
  });

  it('bad JSON keeps the last good data; too big is ignored', async () => {
    const { live: l, data } = make();
    const f = l.start(SID, 'Tests');
    l.watch();
    writeFileSync(f.data, '{"n":1}');
    await wait(300);
    writeFileSync(f.data, '{"n":');
    await wait(300);
    expect(data.map((d) => d.data)).toEqual([{ n: 1 }]);
    expect(l.latestData(SID, 'tests')).toEqual({ n: 1 });
    writeFileSync(f.data, JSON.stringify({ big: 'x'.repeat(300_000) }));
    await wait(300);
    expect(data).toHaveLength(1);
  });

  it('only regular files in the folder: a link is refused, other files and paths are ignored', async () => {
    const { live: l, root, versions } = make();
    const f = l.start(SID, 'Linked');
    const secret = join(root, 'secret.txt');
    writeFileSync(secret, 'the token');
    try {
      symlinkSync(secret, f.page, 'file');
    } catch {
      return; // no symlinks without the right to make them (Windows): nothing to test here
    }
    l.changed(`${SID}/linked/page.html`);
    l.changed(`${SID}/linked/other.html`);
    l.changed(`${SID}/page.html`);
    await wait(150);
    expect(versions).toEqual([]);
  });

  it('prunes explains not touched since the cutoff', () => {
    const { live: l, root } = make();
    const old = l.start(SID, 'Old');
    const fresh = l.start(SID, 'Fresh');
    writeFileSync(old.page, 'x');
    writeFileSync(fresh.page, 'x');
    const long = new Date(Date.now() - 30 * 86_400_000);
    for (const f of ['page.html', 'meta.json']) utimesSync(join(old.dir, f), long, long);
    expect(l.prune(Date.now() - 7 * 86_400_000)).toBe(1);
    expect([existsSync(old.dir), existsSync(fresh.dir)]).toEqual([false, true]);
    mkdirSync(join(root, 'sess-empty-0002'));
    l.prune(Date.now());
    expect(existsSync(join(root, 'sess-empty-0002'))).toBe(false);
  });

  it("sharing: a copy in the explain's folder, and what the session is asked to do with it", async () => {
    const { live: l, root, versions } = make();
    l.watch();
    const file = l.share(SID, 'Release 2.4', '<p>shared</p>');
    expect(file).toBe(join(root, SID, 'release-24', 'share-release-24.html'));
    expect(readFileSync(file, 'utf8')).toBe('<p>shared</p>');
    await wait(300);
    expect(versions).toEqual([]); // not a page: no new version
    expect(() => l.share(SID, 'x', ' ')).toThrow();
    expect(() => l.share('../x', 'x', '<p>')).toThrow(/not a session/);
    const first = sharePrompt('Release "2.4"', file);
    expect(first).toContain(`publish ${file} as a private claude.ai artifact titled "Release '2.4'"`);
    expect(first).toContain('exactly as it is');
    expect(sharePrompt('Release 2.4', file, 'https://claude.ai/artifact/abc')).toContain(`republish ${file} to the existing artifact https://claude.ai/artifact/abc`);
    expect(artifactUrl('Published: https://claude.ai/artifact/AjNk-dh_c?sk=x (private)')).toBe('https://claude.ai/artifact/AjNk-dh_c');
    expect(artifactUrl('https://claude.ai/code/artifact/1234-ab')).toBe('https://claude.ai/code/artifact/1234-ab');
    expect(artifactUrl('https://evil.example/artifact/x')).toBeNull();
  });
});
