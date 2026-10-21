import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { explainFrom, sandboxedHtml } from '../src/components/Viewer';

describe('sandboxedHtml', () => {
  it('wraps fragments in a document with the CSP', () => {
    const out = sandboxedHtml('<h1>Hi</h1>');
    expect(out).toMatch(/^<!doctype html>/);
    expect(out).toContain('http-equiv="Content-Security-Policy"');
    expect(out).toContain("connect-src 'none'");
    expect(out).toContain('<body><h1>Hi</h1></body>');
  });
  it('injects the CSP into an existing head, before any author content', () => {
    const out = sandboxedHtml('<!doctype html><html><head><script>fetch("x")</script></head><body></body></html>');
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<script>'));
  });
  it('adds a head when the document has none', () => {
    const out = sandboxedHtml('<html><body>x</body></html>');
    expect(out).toMatch(/<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/);
  });
});

describe('explainFrom', () => {
  const ev = (input: unknown): BrainEvent => ({
    id: 'tool:t1:start', seq: 1, sessionId: 's', agentId: 'main', ts: 1, kind: 'tool', phase: 'start', toolUseId: 't1',
    icon: { name: 'Presentation', family: 'plan' }, source: 'transcript', tool: { name: 'mcp__agent-brain__present', input, summary: '' },
  });
  it('recovers title and format from an input stored truncated (content is fetched later)', () => {
    const preview = JSON.stringify({ title: 'Soup "Island": Radar', format: 'html', content: '<!DOCTYPE html>' + 'x'.repeat(100) }).slice(0, 80) + '…[truncated]';
    expect(explainFrom(ev({ _truncated: true, preview }))).toMatchObject({ title: 'Soup "Island": Radar', format: 'html', content: undefined });
  });
  it('renders a full HTML document as HTML even when labelled markdown', () => {
    expect(explainFrom(ev({ title: 'x', format: 'markdown', content: '<!DOCTYPE html><html><body>hi</body></html>' }))?.format).toBe('html');
    expect(explainFrom(ev({ title: 'x', format: 'markdown', content: '# heading\n<b>inline html is fine</b>' }))?.format).toBe('markdown');
  });
});
