import { memo, useMemo, useRef } from 'react';
import { CopyButton, copyText } from './Linkify';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { jiraLink } from '../lib/jira';
import { CHIP_TAG, remarkJira } from '../lib/remarkJira';
import { jiraAvailable, jiraSite, useJira, useKnownKey } from '../state/jira';
import { JiraChip } from './JiraChip';

/** A link's text, flattened (to tell a bare address, autolinked, from a link with words of its own). */
const textOf = (c: React.ReactNode): string => (typeof c === 'string' || typeof c === 'number' ? String(c) : Array.isArray(c) ? c.map(textOf).join('') : '');

/**
 * GitHub-flavoured markdown. Raw HTML in the source is NOT rendered (react-markdown default). Ticket keys and bare
 * Jira links become chips (not in code); `chips={false}` for a static copy where chips can't work.
 */
export const Markdown = memo(function Markdown({ text, className = '', chips = true, onTask }: { text: string; className?: string; chips?: boolean; /** task boxes (`- [ ]`) can be ticked: the line (1-based) clicked */ onTask?: (line: number) => void }) {
  const known = useKnownKey();
  const site = useJira((st) => jiraSite(st));
  const on = chips && jiraAvailable();
  const plugins = useMemo(() => (on && known ? [remarkGfm, [remarkJira, { known }]] : [remarkGfm]), [on, known]);
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const j = on && href ? jiraLink(href, site) : null;
        const t = textOf(children).trim();
        if (j && (t === href || t === j.key)) return <JiraChip jref={j} />;
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      // tickable tasks: the box says where its line is (the innermost item takes the click)
      ...(onTask
        ? {
            input: ({ type, checked }: { type?: string; checked?: boolean }) => (type === 'checkbox' ? <input type="checkbox" className="md-task" checked={!!checked} onChange={() => {}} /> : <input type={type} />),
            li: ({ node, className, children }: { node?: { position?: { start: { line: number } } }; className?: string; children?: React.ReactNode }) => (
              <li
                className={className}
                onClick={(e) => {
                  if (!(e.target as HTMLElement).classList.contains('md-task')) return;
                  e.stopPropagation();
                  if (node?.position) onTask(node.position.start.line);
                }}
              >
                {children}
              </li>
            ),
          }
        : {}),
      // the element remarkJira turns a key into
      ...({ [CHIP_TAG]: ({ node }: { node?: { properties?: { dataKey?: unknown } } }) => <JiraChip jref={{ key: String(node?.properties?.dataKey ?? '') }} /> } as Components),
    }),
    [on, site, onTask],
  );
  return (
    <div
      className={`md ${className}`}
      onClick={(e) => {
        // inline `code` (a command, a path) copies on click
        const el = e.target as HTMLElement;
        if (el.tagName !== 'CODE' || el.parentElement?.tagName === 'PRE') return;
        copyText(el.textContent ?? '');
        el.classList.add('copied');
        setTimeout(() => el.classList.remove('copied'), 900);
      }}
    >
      <ReactMarkdown remarkPlugins={plugins as never} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** A code block with a copy button (top right, on hover). */
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  return (
    <div className="codeblock">
      <pre ref={pre}>{children}</pre>
      <span className="cb-copy">
        <CopyButton text="" title="Copy" getText={() => pre.current?.textContent ?? ''} />
      </span>
    </div>
  );
}
