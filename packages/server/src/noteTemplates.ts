/**
 * Note templates: markdown with optional front matter (`fill: cora`, `window: since-last|today|24h|week`,
 * `title: … {date}`) and `<!-- cora: … -->` hints where Cora writes. The four made on first run are below; the user
 * edits them (and adds more) as notes.
 */

export type TemplateWindow = 'since-last' | 'today' | '24h' | 'week';
export type Template = { fill: boolean; window: TemplateWindow; title: string; body: string };

const HINT = /^[ \t]*<!--\s*cora:[\s\S]*?-->[ \t]*\r?\n?/gm;

export function parseTemplate(text: string, name: string): Template {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const head = m ? m[1] : '';
  const get = (k: string) => new RegExp(`^${k}\\s*:\\s*(.+?)\\s*(#.*)?$`, 'm').exec(head)?.[1]?.trim();
  const w = get('window');
  return {
    fill: get('fill') === 'cora',
    window: w === 'today' || w === '24h' || w === 'week' || w === 'since-last' ? w : 'since-last',
    title: get('title') ?? `${name} · {date}`,
    body: m ? text.slice(m[0].length) : text,
  };
}

/** The template's text with its hints taken out (a note started without a draft). */
export const stripHints = (body: string) => body.replace(HINT, '').replace(/\n{3,}/g, '\n\n');

/** `{date}` as "Sat Oct 18". */
export const fillDate = (s: string, at: Date) => s.replace(/\{date\}/g, at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', ''));

export const DEFAULT_TEMPLATES: Array<{ name: string; text: string }> = [
  {
    name: 'Standup',
    text: `---
fill: cora
window: since-last
title: Standup · {date}
---
## Yesterday
<!-- cora: what I got done, grouped by repo: tickets, merge requests, merges, deploys, fixes. One line each. -->

## Today
<!-- cora: what's still in progress and the obvious next steps. -->

## Blockers
<!-- cora: anything waiting on someone, failing, or stuck. "None" if nothing. -->
`,
  },
  {
    name: 'Meeting',
    text: `---
fill: cora
window: week
title: Meeting · {date}
---
## Context
<!-- cora: a short recap of my recent work in these repos that's relevant to talk about: what shipped, what's open, open questions. -->

## Notes


## Actions
- [ ]
`,
  },
  {
    name: 'Weekly review',
    text: `---
fill: cora
window: week
title: Week of {date}
---
## Shipped
<!-- cora: what got merged, deployed or finished this week, grouped by repo. -->

## In progress
<!-- cora: what's started but not done, and where it stands. -->

## Problems and lessons
<!-- cora: what failed, got stuck or took longer than it should; anything worth remembering. -->

## Next week
<!-- cora: the obvious next steps. -->
`,
  },
  {
    name: 'Bug report',
    text: `---
title: Bug · {date}
---
## What happens


## What should happen


## Steps to reproduce
1.

## Where
- Environment:
- Version / tag:
- Ticket:
`,
  },
];
