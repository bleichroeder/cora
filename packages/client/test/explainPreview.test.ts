import { describe, expect, it } from 'vitest';
import { explainPreview } from '../src/lib/explainPreview';

describe("an explain's card preview", () => {
  it('skips the heading (the card shows the title) and keeps paragraphs apart', () => {
    const md = "# Why Monday's 6 am setpoint was skipped\n\nThe weekly schedule is keyed by **day**.\nIt was taken from UTC.\n\n## The fix\n\n```ts\nconst day = zonedDay(now);\n```\n\nAdded a test.";
    expect(explainPreview(md, 'markdown')).toBe('The weekly schedule is keyed by day. It was taken from UTC. · Added a test.');
  });
  it('reads a table row by row, and a list item by item', () => {
    const md = '# Fields\n\n| Field | On |\n|---|---|\n| `agent_id` | subagent hooks |\n\n- [x] Version bumped\n- [ ] Image pushed';
    expect(explainPreview(md, 'markdown')).toBe('Field, On · agent_id, subagent hooks · Version bumped · Image pushed');
  });
  it('html: text only, no headings or styles; long ones are cut at a word', () => {
    expect(explainPreview('<style>p{}</style><h1>Plan</h1><p>First &amp; foremost.</p><ul><li>One</li><li>Two</li></ul>', 'html')).toBe('First & foremost. · One · Two');
    const long = explainPreview('word '.repeat(80), 'markdown', 30);
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(31);
  });
});
