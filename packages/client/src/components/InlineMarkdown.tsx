import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const INLINE = ['p', 'strong', 'em', 'del', 'code', 'a'];

/** Markdown flattened to one inline run (bold, italics, code, links); blocks like lists and headings become text. */
export const InlineMarkdown = memo(function InlineMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      allowedElements={INLINE}
      unwrapDisallowed
      components={{
        p: ({ children }) => <span>{children} </span>,
        a: ({ children }) => <span className="lnk">{children}</span>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
});
