import { describe, expect, it } from 'vitest';
import { asksInCora, hashOf, readAction } from '../src/lib/explainActions';

describe("a dashboard's button, as its page posts it", () => {
  it('a prompt or an http(s) link with a label is an action; its words are tidied', () => {
    expect(readAction({ cora: 'action', id: 'a1', label: '  Retry the\nfailed tests ', prompt: ' retry them ' })).toEqual({ id: 'a1', label: 'Retry the failed tests', confirm: false, prompt: 'retry them' });
    expect(readAction({ cora: 'action', id: 'a2', label: 'MR', url: 'https://gitlab.example/x/-/merge_requests/1', confirm: true })).toEqual({ id: 'a2', label: 'MR', confirm: true, url: 'https://gitlab.example/x/-/merge_requests/1' });
  });
  it('anything else a page could post is nothing', () => {
    for (const m of [
      null,
      'action',
      { cora: 'scroll', y: 3 },
      { cora: 'action', id: 'a1', prompt: 'no label' },
      { cora: 'action', id: 'a1', label: 'x' },
      { cora: 'action', id: 'a1', label: 'x', prompt: '   ' },
      { cora: 'action', id: 'a1', label: 'x', prompt: 'y'.repeat(2001) },
      { cora: 'action', id: 'a1', label: 'x', url: 'javascript:alert(1)' },
      { cora: 'action', id: 'a1', label: 'x', url: 'file:///C:/secrets.txt' },
      { cora: 'action', id: 'a 1; drop', label: 'x', prompt: 'y' },
      { cora: 'action', label: 'x', prompt: 'y' },
    ])
      expect(readAction(m)).toBeNull();
  });
});

describe('whether Cora asks before acting', () => {
  it("never for its own page (a risky button asks in itself); always for a session's own page (it could post clicks by script)", () => {
    expect(asksInCora(true)).toBe(false);
    expect(asksInCora(false)).toBe(true);
  });
});

describe("a page's hash", () => {
  it('is the hex SHA-256 of its text (as the server hashes its kit page)', async () => {
    expect(await hashOf('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
