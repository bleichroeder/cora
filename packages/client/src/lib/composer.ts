/** The prompt composer's logic, kept free of React and the store so it can be tested. */

export type SlashCommand = { name: string; description: string; hint?: string; kind: 'builtin' | 'skill' | 'command'; source?: string };
/** A file going with the prompt: a path Claude can read (a pasted screenshot is saved by the server first). */
export type Attachment = { path: string; name: string; image: boolean };

/**
 * Claude Code's own commands that make sense from the composer mid-session (from its command list). Not /resume:
 * switching conversations inside a hosted terminal is done from Cora's list instead.
 */
export const BUILTIN_COMMANDS: SlashCommand[] = (
  [
    ['add-dir', 'Add a new working directory', '<path>'],
    ['btw', 'Ask a quick side question without interrupting the main conversation', '[question]'],
    ['clear', 'Start a new session with empty context (the old one stays resumable)'],
    ['compact', 'Free up context by summarizing the conversation so far', '[instructions for the summary]'],
    ['config', 'Open the settings'],
    ['context', 'Show what fills the context window'],
    ['doctor', 'Check the Claude Code install'],
    ['effort', 'Set the effort level', '[low|medium|high|xhigh|max]'],
    ['exit', 'Exit Claude Code'],
    ['export', 'Export the conversation to a file or the clipboard', '[filename]'],
    ['help', "Claude Code's help"],
    ['hooks', 'Manage hooks'],
    ['init', 'Write a CLAUDE.md with codebase documentation'],
    ['mcp', 'Manage MCP servers'],
    ['memory', 'Edit CLAUDE.md files and memory settings'],
    ['model', 'Set the model', '[model]'],
    ['permissions', 'Manage allow and deny rules for tools'],
    ['plan', 'Enable plan mode or view the current plan', '[open|<description>]'],
    ['rewind', 'Go back to an earlier point in the conversation (and code)'],
    ['security-review', 'Security review of the pending changes on this branch'],
    ['status', 'Version, model, account and connectivity'],
    ['tasks', 'View and manage everything running in the background'],
    ['usage', 'Session cost, plan usage and activity'],
  ] as Array<[string, string, string?]>
).map(([name, description, hint]) => ({ name, description, ...(hint ? { hint } : {}), kind: 'builtin' as const }));

/** The `/command` being typed: only at the very start, on the first line, before any space. */
export function slashQuery(text: string, caret: number): string | null {
  const m = /^\/([\w.:-]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  // the caret must be at the end of the command word (not editing its arguments)
  return /^[\w.:-]/.test(text.slice(caret)) ? null : m[1];
}

/** Commands for the menu: names starting with the query first (a plugin's too), then names containing it, then descriptions. */
export function filterCommands(list: SlashCommand[], query: string, max = 50): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return list.slice(0, max);
  const rank = (c: SlashCommand) => {
    const n = c.name.toLowerCase();
    const short = n.includes(':') ? n.slice(n.indexOf(':') + 1) : n;
    if (n === q || short === q) return 0;
    if (n.startsWith(q) || short.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    // a letter or two would match nearly every description
    if (q.length >= 3 && c.description.toLowerCase().includes(q)) return 3;
    return -1;
  };
  return list
    .map((c, i) => ({ c, r: rank(c), i }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.c.name.length - b.c.name.length || a.i - b.i)
    .slice(0, max)
    .map((x) => x.c);
}

/** Built-ins first-class, then the server's list (a skill can't hide a built-in of the same name). */
export function mergeCommands(builtins: SlashCommand[], extra: SlashCommand[]): SlashCommand[] {
  const seen = new Set(builtins.map((c) => c.name));
  return [...builtins, ...extra.filter((c) => !seen.has(c.name))].sort((a, b) => a.name.localeCompare(b.name));
}

export type EnterMode = 'enter' | 'ctrl-enter';
/** What a key press in the composer means: Enter sends (Shift+Enter is a new line), or the other way round. Ctrl+Enter always sends. */
export function keyAction(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing?: boolean }, mode: EnterMode): 'send' | 'newline' | null {
  if (e.key !== 'Enter' || e.isComposing || e.altKey) return null;
  if (e.ctrlKey || e.metaKey) return 'send';
  if (e.shiftKey) return 'newline';
  return mode === 'enter' ? 'send' : 'newline';
}

/** A path as it goes in a prompt: quoted when it has spaces. */
export const quotePath = (p: string) => (/\s/.test(p) ? `"${p}"` : p);

/** The text that's sent: what you wrote, then the attached files' paths, one per line (Claude reads them, images included). */
export function buildPrompt(text: string, attachments: Attachment[]): string {
  const body = text.replace(/\s+$/, '');
  if (!attachments.length) return body;
  const paths = attachments.map((a) => quotePath(a.path)).join('\n');
  return body.trim() ? `${body}\n\n${paths}` : paths;
}

export type Sent = { text: string; ts: number };
/**
 * Prompts ↑ can bring back, oldest first: the session's prompts from its transcript (typed anywhere), and those
 * sent from here that it doesn't show yet, in time order. Repeats in a row collapse.
 */
export function promptHistory(transcript: Sent[], sent: Sent[]): string[] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const have = new Set(transcript.map((p) => norm(p.text)));
  const out: string[] = [];
  const all = [...transcript, ...sent.filter((s) => !have.has(norm(s.text)))].sort((a, b) => a.ts - b.ts);
  for (const { text } of all) {
    if (!text.trim() || (out.length && norm(out[out.length - 1]) === norm(text))) continue;
    out.push(text);
  }
  return out;
}

/**
 * Step through the history with ↑ (-1) and ↓ (+1). `at` is where you are (null: not browsing, your own text).
 * Returns the new position (null: back to your own text), or undefined when there's nowhere to go.
 */
export function stepHistory(len: number, at: number | null, dir: -1 | 1): number | null | undefined {
  if (!len) return undefined;
  if (at == null) return dir === -1 ? len - 1 : undefined;
  const next = at + dir;
  if (next < 0) return undefined;
  return next >= len ? null : next;
}

/** Only the caret on the first line (↑) or the last line (↓) leaves the text for the history. */
export const caretOnEdge = (text: string, start: number, end: number, dir: -1 | 1) => (dir === -1 ? !text.slice(0, start).includes('\n') : !text.slice(end).includes('\n'));

/**
 * The terminal keys in the composer: Esc stops the session's work (a draft is never thrown away); Ctrl+C stops it
 * too, unless text is selected (then it copies, as in the terminal). One press, one thing.
 */
export function stopKey(
  e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing?: boolean },
  box: { selection: boolean },
): 'esc' | 'ctrl-c' | null {
  if (e.isComposing) return null;
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return 'esc';
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'c') return box.selection ? null : 'ctrl-c';
  return null;
}
