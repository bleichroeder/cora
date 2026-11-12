/** Longest prompt the input route types into a terminal: a composer prompt can carry a whole pasted log, diff or file,
 * as Claude Code itself takes (it folds a big paste into "[Pasted text]"); well under the request limit (20 MB). */
export const MAX_INPUT = 1_000_000;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** The text without control characters (ESC included: it can never close a paste or send keys of its own), and
 * without the blank lines around it or trailing spaces (the first line's indentation stays: pasted code). */
function cleaned(raw: string): string {
  return String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, '')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/\s+$/, '');
}
const tooLong = { error: `text must be 1 to ${MAX_INPUT} characters` };
const asPaste = (text: string) => PASTE_START + text.replace(/\n/g, '\r') + PASTE_END;

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
  const text = cleaned(raw);
  if (!text.trim() || text.length > MAX_INPUT) return tooLong;
  if (!text.includes('\n')) return { data: text.replace(/\t/g, '  ').trim(), paste: false };
  return { data: asPaste(text), paste: true };
}

/** Longest prompt typed key by key; a longer one goes as a paste (typed, it would take too long to arrive). */
export const MAX_TYPED = 20_000;
/** Typed in pieces this long, this far apart: Claude Code takes a big burst of input for a paste. */
export const TYPED_CHUNK = 200;
export const TYPED_GAP_MS = 25;
const NEW_LINE = '\x1b\r';

/**
 * A prompt from anyone but you at the keyboard (Cora, a project member's wake, a guest, a Slack reply, a new
 * session's brief), typed as keys so it arrives as a plain prompt. Claude Code marks a paste it folds (a long one) as
 * pasted text, which a session rightly treats as not its user's own words: a message from Cora with a list in it
 * came as pasted text, and the session wouldn't act on it. Line breaks are Alt+Enter (ESC CR: a new line, not a
 * submit), and the text goes in pieces small enough that Claude Code never takes them for a paste (a piece never
 * splits the ESC from its CR). Tabs become spaces (typed, a Tab is autocomplete). Longer than MAX_TYPED: a paste.
 */
export function typedInput(raw: string): { chunks: string[]; paste: boolean } | { error: string } {
  const text = cleaned(raw);
  if (!text.trim() || text.length > MAX_INPUT) return tooLong;
  if (text.length > MAX_TYPED) return { chunks: [asPaste(text)], paste: true };
  const keys = text.replace(/\t/g, '  ').trim().replace(/\n/g, NEW_LINE);
  const chunks: string[] = [];
  for (let i = 0; i < keys.length; ) {
    let j = Math.min(i + TYPED_CHUNK, keys.length);
    if (keys[j - 1] === '\x1b') j++;
    chunks.push(keys.slice(i, j));
    i = j;
  }
  return { chunks, paste: false };
}

/** What sendTyped writes into: the terminals (its own set of them each). */
export type TypedTarget = { write(terminalId: string, data: string): unknown };
/** When each terminal's typing is done (per set of terminals): a second prompt into it waits for the first, so their pieces never mix. */
const laneSets = new WeakMap<TypedTarget, Map<string, number>>();
const MAX_LANE_WAIT_MS = 10_000;
/**
 * Types it (from typedInput) into the terminal, then Enter a beat after the last piece. Returns how long until that
 * Enter (ms from now).
 */
export function sendTyped(ptys: TypedTarget, terminalId: string, input: { chunks: string[]; paste: boolean }): number {
  const lanes = laneSets.get(ptys) ?? new Map<string, number>();
  laneSets.set(ptys, lanes);
  const lane = terminalId;
  const write = (data: string) => void ptys.write(terminalId, data);
  const now = Date.now();
  // (a wait longer than the longest typing can take means the clock moved: no wait)
  const wait = (lanes.get(lane) ?? 0) - now;
  const start = wait > 0 && wait < MAX_LANE_WAIT_MS ? wait : 0;
  input.chunks.forEach((c, i) => {
    const at = start + i * TYPED_GAP_MS;
    if (at === 0) write(c);
    else setTimeout(() => write(c), at);
  });
  const last = start + (input.chunks.length - 1) * TYPED_GAP_MS;
  // a paste takes Claude Code longer to read in
  const enter = last + (input.paste ? Math.min(3000, 150 + Math.round(input.chunks[0].length / 2000)) : 150);
  setTimeout(() => write('\r'), enter);
  // the next one starts once this one is sent
  lanes.set(lane, now + enter + TYPED_GAP_MS);
  for (const [k, until] of lanes) if (until < now) lanes.delete(k);
  return enter;
}

/** A prompt carrying an image file's path (a screenshot or picture attached in the composer). */
export const carriesImage = (text: string) => /\.(png|jpe?g|gif|webp|bmp)["']?\s*$/im.test(text);

/**
 * Enter, once Claude Code has taken the prompt in. A prompt carrying an image's path makes Claude Code stop and read
 * the image in (it attaches it): an Enter on a fixed beat landed while it was still at it and was lost, leaving the
 * prompt in its box until you pressed Enter in the terminal. So: wait at least `first`, then until its screen has
 * held still for two looks in a row, at most `max`, then Enter.
 */
export async function enterWhenSettled(o: { screen(): string[]; enter(): void; first: number; max: number; every?: number; sleep?: (ms: number) => Promise<void> }): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const every = o.every ?? 100;
  await sleep(o.first);
  let last: string | null = null;
  let still = 0;
  for (let waited = 0; waited < o.max; waited += every) {
    const now = o.screen().join('\n');
    if (now === last) {
      if (++still >= 2) break;
    } else {
      still = 0;
      last = now;
    }
    await sleep(every);
  }
  o.enter();
}
