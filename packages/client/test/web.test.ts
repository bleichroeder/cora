import { describe, expect, it } from 'vitest';
import { addRecent, toUrl } from '../src/lib/web';

describe('toUrl', () => {
  it('keeps links, adds https to hosts (http for local), searches anything else', () => {
    expect(toUrl(' https://gitlab.com/a/b/-/pipelines ')).toBe('https://gitlab.com/a/b/-/pipelines');
    expect(toUrl('gitlab.com/group/proj/-/pipelines/123')).toBe('https://gitlab.com/group/proj/-/pipelines/123');
    expect(toUrl('acme.atlassian.net')).toBe('https://acme.atlassian.net');
    expect(toUrl('localhost:4317/x')).toBe('http://localhost:4317/x');
    expect(toUrl('why is my pipeline red')).toBe('https://www.google.com/search?q=why%20is%20my%20pipeline%20red');
    expect(toUrl('')).toBe('');
  });
});

describe('addRecent', () => {
  it('puts the newest first, once per address', () => {
    const l = addRecent(addRecent([], { url: 'https://a/x', title: 'A' }), { url: 'https://b', title: 'B' });
    expect(addRecent(l, { url: 'https://a/x#top', title: 'A2' })).toEqual([
      { url: 'https://a/x#top', title: 'A2' },
      { url: 'https://b', title: 'B' },
    ]);
  });
});
