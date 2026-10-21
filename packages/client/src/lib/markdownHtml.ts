import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Markdown as HTML for the clipboard: the same GitHub-flavoured rendering the transcript shows, without its chrome
 * (code-block copy buttons), so a reply pasted into Jira, Slack or Docs keeps its bold, lists, code and tables.
 * Raw HTML in the source stays text, as on screen.
 */
export function markdownHtml(md: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, md));
}
