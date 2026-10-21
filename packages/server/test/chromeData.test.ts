import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChromeData } from '../src/chromeData';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** A Chrome "User Data" folder with one profile: its bookmarks, and a history database. */
function chromeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cora-chrome-'));
  const p = join(root, 'Default');
  mkdirSync(p);
  mkdirSync(join(root, 'System Profile'));
  writeFileSync(
    join(p, 'Bookmarks'),
    JSON.stringify({
      roots: {
        bookmark_bar: { type: 'folder', children: [{ type: 'url', name: 'GitLab MRs', url: 'https://gitlab.com/dashboard/merge_requests' }, { type: 'folder', children: [{ type: 'url', name: 'Grafana', url: 'https://grafana.acme.io/d/abc' }] }] },
        other: { type: 'folder', children: [{ type: 'url', name: 'Jira board', url: 'https://acme.atlassian.net/jira/boards/7' }, { type: 'url', name: 'bad', url: 'javascript:alert(1)' }] },
      },
    }),
  );
  const db = new DatabaseSync(join(p, 'History'));
  db.exec('CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER)');
  const add = db.prepare('INSERT INTO urls VALUES (?, ?, ?, ?, 0)');
  add.run('https://gitlab.com/acme/app/-/pipelines', 'Pipelines · acme/app', 40, 1);
  add.run('https://grafana.acme.io/d/abc', 'Grafana', 3, 2);
  add.run('https://news.example.com/', 'News', 900, 3);
  add.run('file:///C:/secret.txt', 'file', 999, 4);
  db.close();
  return root;
}

describe("your Chrome bookmarks and history, in Cora's browser", () => {
  it("suggests from them as you type: a host that starts with it first, bookmarks before history; only web pages", () => {
    const c = new ChromeData({ roots: () => [chromeRoot()] });
    expect(c.suggest('git').map((s) => s.url)).toEqual(['https://gitlab.com/dashboard/merge_requests', 'https://gitlab.com/acme/app/-/pipelines']);
    expect(c.suggest('pipelines acme')[0]).toMatchObject({ url: 'https://gitlab.com/acme/app/-/pipelines', from: 'history', visits: 40 });
    expect(c.suggest('grafana').map((s) => s.from)).toEqual(['bookmark']);
    expect(c.suggest('secret')).toEqual([]);
    expect(c.suggest('alert')).toEqual([]);
    expect(c.suggest('  ')).toEqual([]);
  });

  it('shows the bookmarks bar (folders opened), and nothing when there is no Chrome', () => {
    expect(new ChromeData({ roots: () => [chromeRoot()] }).bar().map((s) => s.title)).toEqual(['GitLab MRs', 'Grafana']);
    expect(new ChromeData({ roots: () => [] }).suggest('git')).toEqual([]);
  });
});

describe('profiles', () => {
  it("lists each profile with its browser's name for it; bookmarks and suggestions per profile, or all together", () => {
    const root = mkdtempSync(join(tmpdir(), 'cora-chrome-'));
    const make = (dir: string, bar: Array<[string, string]>) => {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { type: 'folder', children: bar.map(([name, url]) => ({ type: 'url', name, url })) } } }));
    };
    make('Default', [['Bank', 'https://bank.example/']]);
    make('Profile 2', [['Pipelines', 'https://gitlab.work.example/pipelines']]);
    writeFileSync(join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 2': { name: 'Work' } } } }));
    const c = new ChromeData({ roots: () => [root] });
    expect(c.profiles()).toEqual([{ id: 'chrome:Default', name: 'Personal' }, { id: 'chrome:Profile 2', name: 'Work' }]);
    expect(c.bar(24, 'chrome:Profile 2').map((b) => b.title)).toEqual(['Pipelines']);
    expect(c.bar(24, 'chrome:Default').map((b) => b.title)).toEqual(['Bank']);
    expect(c.bar().map((b) => b.title).sort()).toEqual(['Bank', 'Pipelines']);
    expect(c.suggest('bank', 8, 'chrome:Profile 2')).toEqual([]);
    expect(c.suggest('bank', 8, 'chrome:Default').map((s) => s.url)).toEqual(['https://bank.example/']);
  });
});
