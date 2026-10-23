import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MemeTemplate } from '@cora/shared';
import { Memes, matchTemplate } from '../src/memes';
import { nudgeFor } from '../src/hosted';
import { DEFAULT_SETTINGS, svgProblem } from '@cora/shared';
import { existsSync, readFileSync } from 'node:fs';

const T = (id: string, name: string): MemeTemplate => ({ id, name, url: `https://i.imgflip.com/${id}.jpg`, width: 500, height: 400, boxes: 2 });
const LIST = [T('1', 'Drake Hotline Bling'), T('2', 'Distracted Boyfriend'), T('3', 'This Is Fine'), T('4', 'Two Buttons'), T('5', 'Woman Yelling At Cat')];

describe('memes', () => {
  it('match a template by name: the same, the start of it, part of it, or most words in common', () => {
    expect(matchTemplate(LIST, 'this is fine')?.id).toBe('3');
    expect(matchTemplate(LIST, 'Drake')?.id).toBe('1');
    expect(matchTemplate(LIST, 'yelling at cat')?.id).toBe('5');
    expect(matchTemplate(LIST, 'the distracted boyfriend meme')?.id).toBe('2');
    expect(matchTemplate(LIST, 'galaxy brain')).toBeNull();
  });

  it("read Imgflip's popular list once a day, and GIFs only with a key (the first PG-13 match)", async () => {
    let calls: string[] = [];
    const fetch = async (u: string) => {
      calls.push(u);
      if (u.includes('imgflip')) return { ok: true, status: 200, json: async () => ({ data: { memes: [{ id: '3', name: 'This Is Fine', url: 'https://i.imgflip.com/3.jpg', width: 1, height: 1, box_count: 2 }] } }) };
      return { ok: true, status: 200, json: async () => ({ data: [{ title: 'party', url: 'https://giphy.com/gifs/x', images: { downsized: { url: 'https://media.giphy.com/media/x/giphy.gif' } } }] }) };
    };
    const m = new Memes({ dataDir: mkdtempSync(join(tmpdir(), 'cora-memes-')), fetch });
    expect((await m.templates()).map((t) => t.name)).toEqual(['This Is Fine']);
    await m.templates();
    expect(calls.filter((u) => u.includes('imgflip'))).toHaveLength(1);
    await expect(m.gif('party')).rejects.toThrow('no-key');
    m.setGiphyKey('abc123');
    expect(m.giphyKey()).toBe('abc123');
    calls = [];
    expect(await m.gif('party')).toEqual({ url: 'https://media.giphy.com/media/x/giphy.gif', title: 'party', page: 'https://giphy.com/gifs/x' });
    expect(calls[0]).toContain('rating=pg-13');
  });

  it("keep each session's posts (and drop them with the rest of history)", () => {
    let now = 1000;
    const dir = mkdtempSync(join(tmpdir(), 'cora-memes-'));
    const m = new Memes({ dataDir: dir, now: () => now });
    m.post('s1', { kind: 'meme', url: 'u', template: 'This Is Fine', top: 'tests', bottom: 'all red' });
    now = 5000;
    m.post('s1', { kind: 'gif', url: 'g', query: 'party' });
    expect(new Memes({ dataDir: dir }).list('s1').map((p) => p.kind)).toEqual(['meme', 'gif']);
    m.prune(3000);
    expect(m.list('s1').map((p) => p.kind)).toEqual(['gif']);
  });

  it("are offered to sessions only when the user wants them", () => {
    expect(nudgeFor(DEFAULT_SETTINGS.explains)).not.toMatch(/Meme panel/);
    expect(nudgeFor(DEFAULT_SETTINGS.explains, undefined, 'sometimes')).toMatch(/`meme` tool \(.*draw yourself as an SVG.*\), at most one every several turns/);
  });
});

describe('memes Claude draws', () => {
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><rect width="600" height="400" fill="#123"/><text x="20" y="60" fill="#fff">ME</text></svg>';
  it('are shown only if they are one safe SVG', () => {
    expect(svgProblem(ok)).toBeNull();
    expect(svgProblem('<?xml version="1.0"?>\n' + ok)).toBeNull();
    expect(svgProblem('<div>hi</div>')).toMatch(/whole <svg>/);
    expect(svgProblem(ok.replace('<text', '<script>alert(1)</script><text'))).toMatch(/scripts/);
    expect(svgProblem(ok.replace('<rect', '<rect onload="x()"'))).toMatch(/event handlers/);
    expect(svgProblem(ok.replace('<text', '<image href="https://evil.example/x.png"/><text'))).toMatch(/outside/);
    expect(svgProblem(ok.replace('fill="#123"', 'fill="url(https://x.example/a)"'))).toMatch(/outside/);
    expect(svgProblem('<svg>' + 'x'.repeat(31_000) + '</svg>')).toMatch(/KB/);
  });
  it("live in memory only: listed with the session's others, never written to disk", () => {
    let now = 1000;
    const dir = mkdtempSync(join(tmpdir(), 'cora-memes-'));
    const m = new Memes({ dataDir: dir, now: () => now });
    m.post('s1', { kind: 'gif', url: 'g', query: 'party' });
    now = 2000;
    m.post('s1', { kind: 'svg', url: '', svg: ok, why: 'mine' });
    expect(m.list('s1').map((p) => p.kind)).toEqual(['gif', 'svg']);
    expect(readFileSync(join(dir, 'memes.json'), 'utf8')).not.toContain('<svg');
    // a restart: the drawn one is gone
    expect(new Memes({ dataDir: dir }).list('s1').map((p) => p.kind)).toEqual(['gif']);
    expect(existsSync(join(dir, 'memes.json'))).toBe(true);
  });
});
