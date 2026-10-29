/** Longest prompt the input route types into a terminal: a composer prompt can carry a whole pasted log, diff or file,
 * as Claude Code itself takes (it folds a big paste into "[Pasted text]"); well under the request limit (20 MB). */
export const MAX_INPUT = 1_000_000;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * What to write into a hosted Claude Code for a prompt sent from the dashboard. One line is typed as is, so slash
 * commands, `!` and `#` behave as if you'd typed them. Several lines go as one bracketed paste (Claude Code turns
 * on bracketed paste and reads the block as a paste; it sends its own replies the same way), each line break as
 * the CR a terminal sends; typed, a newline would be Enter and submit the first line.
 *
 * Every control character is dropped (ESC included, so the text can never close the paste early or send keys of
 * its own); in a paste tabs stay (indentation), when typed they'd be Tab (autocomplete) so they become spaces.
 */
export function terminalInput(raw: string): { data: string; paste: boolean } | { error: string } {
  const text = String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, '')
    // blank lines around it and trailing spaces go; the first line's indentation stays (pasted code)
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/\s+$/, '');
  if (!text.trim() || text.length > MAX_INPUT) return { error: `text must be 1 to ${MAX_INPUT} characters` };
  if (!text.includes('\n')) return { data: text.replace(/\t/g, '  ').trim(), paste: false };
  return { data: PASTE_START + text.replace(/\n/g, '\r') + PASTE_END, paste: true };
}
