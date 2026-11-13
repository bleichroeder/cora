import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BrainEvent } from '@cora/shared';
import { buildSteps } from '../src/lib/steps';
import { buildTurns } from '../src/lib/turns';
import { TurnView } from '../src/components/TurnView';

let seq = 0;
const E = (o: Partial<BrainEvent> & Pick<BrainEvent, 'kind'>): BrainEvent => ({
  id: `v${++seq}`, seq, sessionId: 's', agentId: 'main', ts: Date.parse('2026-11-13T15:00:00Z') + seq * 1000, icon: { name: 'FileText', family: 'look' }, source: 'transcript', ...o,
});
const read = (f: string) => {
  const id = `r${++seq}`;
  return [E({ kind: 'tool', phase: 'start', toolUseId: id, tool: { name: 'Read', input: {}, summary: f } }), E({ kind: 'tool', phase: 'end', toolUseId: id, tool: { name: 'Read', input: {}, summary: f } })];
};
const html = (live = false) => {
  const turns = buildTurns(
    buildSteps(
      [
        E({ kind: 'prompt', text: 'Why is the build red?' }),
        ...read('a.ts'), ...read('b.ts'),
        E({ kind: 'notice', notice: { type: 'error', text: 'API Error: Connection lost mid-response.' } }),
        E({ kind: 'notice', notice: { type: 'link', text: 'Merge request !8 · acme/ops', url: 'https://gitlab.com/acme/ops/-/merge_requests/8' } }),
        E({ kind: 'say', text: 'The test imported the wrong path; fixed.' }),
        E({ kind: 'turn_end', durationMs: 42_000 }),
        E({ kind: 'prompt', text: 'Thanks, ship it' }),
        E({ kind: 'say', text: 'Shipped.' }),
        E({ kind: 'turn_end', durationMs: 3_000 }),
      ],
      'all',
    ),
    live,
  );
  return { turns, out: turns.map((t) => renderToStaticMarkup(createElement(TurnView, { turn: t, sessionId: 's', hosted: false }))) };
};

describe('a turn on screen', () => {
  it('shows the prompt, the work as one closed line, the notice as a row, the answer, the link as a chip, how it ended', () => {
    const { out } = html();
    const first = out[0];
    expect(first).toContain('Why is the build red?');
    expect(first).toMatch(/Worked.*42.0s.*read 2 files/);
    // closed: its steps aren't drawn
    expect(first).not.toContain('t-steps');
    expect(first).toContain('API Error: Connection lost mid-response.');
    expect(first).toContain('The test imported the wrong path; fixed.');
    expect(first).toContain('Merge request !8 · acme/ops');
    expect(first).toMatch(/finished · 42.0s/);
  });


});
