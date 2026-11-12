import { describe, expect, it } from 'vitest';
import { asFileRef, findFileRefs, splitPrompt } from '../src/lib/filePaths';

describe('file paths in the transcript', () => {
  it('knows a path when it is one: Windows, POSIX, home, relative with an extension, with a line', () => {
    expect(asFileRef('C:\\Users\\David\\.cora\\attachments\\s1\\shot.png')).toEqual({ path: 'C:\\Users\\David\\.cora\\attachments\\s1\\shot.png' });
    expect(asFileRef('"C:\\My Files\\a b.txt"')).toEqual({ path: 'C:\\My Files\\a b.txt' });
    expect(asFileRef('packages/server/src/app.ts:3270')).toEqual({ path: 'packages/server/src/app.ts', line: 3270 });
    expect(asFileRef('src/vpn.ts:12:4')).toEqual({ path: 'src/vpn.ts', line: 12 });
    expect(asFileRef('~/.kube/config')).toEqual({ path: '~/.kube/config' });
    expect(asFileRef('/etc/hosts')).toEqual({ path: '/etc/hosts' });
    expect(asFileRef('./docs/spec.md')).toEqual({ path: './docs/spec.md' });
  });

  it("and when it isn't: commands, words, web addresses, a bare name", () => {
    for (const s of ['npm run build', 'kubectl get pods', 'https://example.com/a/b.png', 'app.ts', 'feat/whiteboard', 'mcp__cora__board_draw', '/api/boards', '3.14'])
      expect(asFileRef(s), s).toBeNull();
  });

  it('finds the paths inside a sentence, not inside web addresses', () => {
    const t = 'See packages/client/src/lib/filePaths.ts:10 and C:\\tmp\\out.log, not https://x.io/a/b.ts.';
    expect(findFileRefs(t).map((r) => [r.path, r.line])).toEqual([
      ['packages/client/src/lib/filePaths.ts', 10],
      ['C:\\tmp\\out.log', undefined],
    ]);
  });

  it("a prompt's attached pictures come out of its text as images", () => {
    const p = 'testing testing\n\nC:\\Users\\David\\.cora\\attachments\\s1\\20261112-scratch.png\n"C:\\My Pics\\a b.jpg"';
    expect(splitPrompt(p)).toEqual({ text: 'testing testing', images: ['C:\\Users\\David\\.cora\\attachments\\s1\\20261112-scratch.png', 'C:\\My Pics\\a b.jpg'] });
    expect(splitPrompt('look at src/app.ts\nplease')).toEqual({ text: 'look at src/app.ts\nplease', images: [] });
  });
});
