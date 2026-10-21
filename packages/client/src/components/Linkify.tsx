import { Fragment, useState } from 'react';
import { desktop } from '../lib/desktop';
import { Icon } from './Icon';
import { JiraChip } from './JiraChip';
import { jiraLink, splitKeys } from '../lib/jira';
import { jiraAvailable, jiraSite, useJira, useKnownKey } from '../state/jira';

/** Web addresses in plain text (tool output, commands), without trailing punctuation or closing brackets. */
export const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g;

/** The first web address in a text, if any. */
export const firstUrl = (s: string): string | null => s.match(URL_RE)?.[0] ?? null;

/**
 * Plain text with its web addresses clickable (they open in the session's browser; Ctrl+click in your browser).
 * With `jira`, ticket keys and Jira issue links become chips (see JiraChip).
 */
export function Linkify({ text, jira = false, sessionId }: { text: string; jira?: boolean; sessionId?: string }) {
  const known = useKnownKey();
  const site = useJira((st) => jiraSite(st));
  const chips = jira && jiraAvailable();
  const parts: React.ReactNode[] = [];
  const plain = (s: string) => {
    if (chips && known) for (const p of splitKeys(s, known)) parts.push(typeof p === 'string' ? p : <JiraChip jref={p} sessionId={sessionId} />);
    else parts.push(s);
  };
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index ?? 0;
    if (i > last) plain(text.slice(last, i));
    const j = chips ? jiraLink(m[0], site) : null;
    parts.push(
      j ? (
        <JiraChip jref={j} sessionId={sessionId} />
      ) : (
        <a href={m[0]} target="_blank" rel="noopener noreferrer" className="autolink" onClick={(e) => e.stopPropagation()}>
          {m[0]}
        </a>
      ),
    );
    last = i + m[0].length;
  }
  if (!last && !chips) return <>{text}</>;
  if (last < text.length) plain(text.slice(last));
  if (parts.length === 1 && typeof parts[0] === 'string') return <>{text}</>;
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
}

export function copyText(s: string) {
  if (desktop?.writeClipboard) desktop.writeClipboard(s);
  else void navigator.clipboard?.writeText(s).catch(() => {});
}

/**
 * Copy `text` and `html` together: plain-text fields (a GitLab or GitHub comment box) paste the text, rich
 * editors (Jira, Slack, Docs) the HTML. Falls back to the text alone where the browser can't write HTML.
 */
export function copyRich(text: string, html: string) {
  if (desktop?.writeClipboard) return desktop.writeClipboard(text, html);
  const plain = () => void navigator.clipboard?.writeText(text).catch(() => {});
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return plain();
  const item = new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) });
  navigator.clipboard.write([item]).catch(plain);
}

/** A small button that copies `text` (with `getHtml`, also as rich text), then says so for a moment. */
export function CopyButton({ text, title = 'Copy', getText, getHtml }: { text: string; title?: string; getText?: () => string; getHtml?: () => string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`mini-btn${done ? ' done' : ''}`}
      title={done ? 'Copied' : title}
      onClick={(e) => {
        e.stopPropagation();
        const t = getText ? getText() : text;
        if (getHtml) copyRich(t, getHtml());
        else copyText(t);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      <Icon name={done ? 'Check' : 'Copy'} size={11} />
    </button>
  );
}

/** A small button that opens a web address in the session's browser. */
export function OpenButton({ url }: { url: string }) {
  return (
    <a className="mini-btn" href={url} target="_blank" rel="noopener noreferrer" title={`Open ${url}`} onClick={(e) => e.stopPropagation()}>
      <Icon name="ExternalLink" size={11} />
    </a>
  );
}
