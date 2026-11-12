import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttentionEdge, attnData } from '../src/components/AttentionEdges';

const root = { current: null };

describe("the rail's attention chips", () => {
  it('a row marks what it wants (counts; nothing when it wants nothing)', () => {
    expect(attnData(0, 0)).toEqual({});
    expect(attnData(1, 0)).toEqual({ 'data-need': 1 });
    expect(attnData(2, 3)).toEqual({ 'data-need': 2, 'data-done': 3 });
  });

  it('says how many need you and how many finished beyond that edge, needing you first', () => {
    const html = renderToStaticMarkup(createElement(AttentionEdge, { root, dir: 'up', side: { need: 2, done: 1 } }));
    expect(html).toContain('attn-chip need');
    expect(html).toMatch(/2 need you[\s\S]*1 done/);
    expect(html).toContain('title="2 need you, 1 finished since you looked above: go to the nearest"');
    const one = renderToStaticMarkup(createElement(AttentionEdge, { root, dir: 'down', side: { need: 1, done: 0 } }));
    expect(one).toContain('1 needs you');
    expect(one).not.toContain('done');
  });

  it('no chip while nothing beyond the edge wants you', () => {
    const html = renderToStaticMarkup(createElement(AttentionEdge, { root, dir: 'down', side: { need: 0, done: 0 } }));
    expect(html).not.toContain('attn-chip');
  });
});
