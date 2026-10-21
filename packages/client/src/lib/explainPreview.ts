/**
 * An explain's first words, for its card in the transcript: what it says, not its markup. Headings (the card shows
 * the title already) and code are left out; paragraphs, list items and table rows are kept apart with " · ".
 */
export function explainPreview(content: string, format: 'markdown' | 'html', max = 160): string {
  const blocks =
    format === 'html'
      ? content
          .replace(/<(style|script|head|title|h[1-6]|pre)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
          .split(/<\/(?:p|li|tr|div|blockquote)>|<br\s*\/?>/i)
          .map((b) => b.replace(/<[^>]+>/g, ' '))
      : content
          .replace(/```[\s\S]*?(```|$)/g, '\n\n')
          .split(/\n\s*\n/)
          .flatMap((b) => b.split('\n').filter((l) => !/^\s*#/.test(l) && !/^\s*\|?[\s:|-]+\|?\s*$/.test(l)).join('\n'))
          .flatMap((b) => (/^\s*([-*+]|\d+\.|\|)/m.test(b) ? b.split('\n') : [b]))
          .map((b) =>
            b
              .replace(/^\s*([-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+|>\s?)/, '')
              .replace(/^\s*\||\|\s*$/g, '')
              .replace(/\s*\|\s*/g, ', ')
              .replace(/\*\*|__|`/g, '')
              // emphasis (*so* or _so_), not the underscores in a name (agent_id)
              .replace(/(^|[^\w])[*_]([^*_]+)[*_](?=[^\w]|$)/g, '$1$2'),
          );
  const text = blocks
    .map((b) => b.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text;
}
