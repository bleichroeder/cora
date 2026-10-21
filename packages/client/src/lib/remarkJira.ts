import { splitKeys } from './jira';

type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> };

/** The element a ticket key in markdown becomes; Markdown renders it as a JiraChip. */
export const CHIP_TAG = 'jira-chip';

/**
 * A remark plugin: ticket keys in a reply's prose become chips. Only text nodes are looked at, so code (fenced or
 * inline, whose text is a value, not children) never is; nor is a link's text (a link can't hold a chip).
 */
export function remarkJira(opts: { known: ((key: string) => boolean) | null }) {
  return (tree: Node) => {
    if (opts?.known) walk(tree, opts.known);
  };
}

function walk(n: Node, known: (key: string) => boolean) {
  if (!n.children || n.type === 'link' || n.type === 'linkReference') return;
  const out: Node[] = [];
  for (const c of n.children) {
    if (c.type !== 'text' || !c.value) {
      walk(c, known);
      out.push(c);
      continue;
    }
    for (const p of splitKeys(c.value, known))
      out.push(typeof p === 'string' ? { type: 'text', value: p } : { type: 'jiraChip', data: { hName: CHIP_TAG, hProperties: { dataKey: p.key } }, children: [] });
  }
  n.children = out;
}
