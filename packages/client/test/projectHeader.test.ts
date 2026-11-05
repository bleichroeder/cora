import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { headerMeta } from '../src/components/ProjectView';

const at = (...dirs: string[]) => dirs.map((d) => ({ cwd: `C:\\code\\${d}` }));

describe("a project's header: its sessions line never pushes the name and buttons out of view", () => {
  it('a few folders: all of them; more: the first three and +N, every one in its title', () => {
    expect(headerMeta([])).toEqual({ text: '0 sessions', title: '0 sessions' });
    expect(headerMeta(at('cora'))).toEqual({ text: '1 session · cora', title: '1 session · cora' });
    // one folder, many sessions: said once
    expect(headerMeta(at('cora', 'cora', 'cora'))).toEqual({ text: '3 sessions · cora', title: '3 sessions · cora' });
    expect(headerMeta(at('a', 'b', 'c'))).toEqual({ text: '3 sessions · a, b, c', title: '3 sessions · a, b, c' });
    const many = at(...Array.from({ length: 12 }, (_, i) => `engineer-${i + 1}`));
    expect(headerMeta(many)).toEqual({ text: '12 sessions · engineer-1, engineer-2, engineer-3 +9', title: `12 sessions · ${many.map((m) => m.cwd.split('\\').pop()).join(', ')}` });
    // posix folders, and a trailing separator
    expect(headerMeta([{ cwd: '/home/x/web/' }, { cwd: '/home/x/api' }])).toEqual({ text: '2 sessions · web, api', title: '2 sessions · web, api' });
  });

  it('only the sessions line may shrink (cut with …); the name and the buttons keep their size', () => {
    const css = readFileSync(join(__dirname, '../src/components/projects.css'), 'utf8');
    expect(css).toMatch(/\.pjv-h > \* \{ flex: none; \}/);
    // the sessions line goes first (it shrinks twenty times as fast as the name), cut with …
    expect(css).toMatch(/\.pjv-h > \.pjv-meta \{ flex: 0 20 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;/);
    // then the name, never below 12ch
    expect(css).toMatch(/\.pjv-h > \.pjv-name \{ flex: 0 1 22ch; min-width: 12ch; \}/);
  });

  it("narrow (the Tester's 1100px window: the ⋯ menu ran 26px off), the buttons keep their icons and lose their words, so the menu fits", () => {
    const css = readFileSync(join(__dirname, '../src/components/projects.css'), 'utf8');
    expect(css).toMatch(/\.pjv-h \{ container: pjh \/ inline-size;/);
    const narrow = /@container pjh \(max-width: (\d+)px\) \{\s*\.pjv-h \.dl-btn \.bt-l \{ display: none; \}/.exec(css);
    expect(narrow).not.toBeNull();
    // at 1100 the header's content is about 1008px (1036 less its padding): below the line, so the words go. What's left
    // there (square, name, three toggles, three icon buttons, the menu, gaps) is about 895px
    expect(Number(narrow![1])).toBeGreaterThan(1008);
  });
});
