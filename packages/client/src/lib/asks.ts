import { shortToolName, type PendingRequest } from '@cora/shared';

/** What a tool asking permission wants to do, in words: "wants to run a command", "wants to change a file"… */
export function wantsTo(tool: string): string {
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return 'wants to run a command';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'wants to change a file';
    case 'Write':
      return 'wants to write a file';
    case 'Read':
      return 'wants to read a file';
    case 'WebFetch':
      return 'wants to fetch a page';
    case 'WebSearch':
      return 'wants to search the web';
    case 'Glob':
    case 'Grep':
      return 'wants to search files';
  }
  if (tool.startsWith('mcp__')) return `wants to use ${tool.split('__')[1]}`;
  return 'wants permission';
}

/** The thing itself: the command, the file, the page, the search (empty when there's nothing short to show). */
export function askTarget(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'notebook_path', 'url', 'query', 'pattern']) if (typeof i[k] === 'string' && i[k]) return (i[k] as string).replace(/\s+/g, ' ').trim();
  return '';
}

/** One line for a toast: "Bash · docker push …", "A question: Which …", or an MCP server's message. */
export function askLine(p: Pick<PendingRequest, 'kind' | 'toolName' | 'toolInput' | 'elicitation'>): string {
  if (p.kind === 'question') {
    const q = ((p.toolInput as { questions?: Array<{ question?: string }> } | null)?.questions ?? [])[0]?.question;
    return q ? `A question: ${q}` : 'A question';
  }
  if (p.kind === 'elicitation') return p.elicitation?.message || `${shortToolName(p.toolName)} needs input`;
  const what = askTarget(p.toolInput);
  return what ? `${shortToolName(p.toolName)} · ${what}` : `${shortToolName(p.toolName)} ${wantsTo(p.toolName)}`;
}

/** A notification's body: "Bash wants to run a command: docker push …". */
export function askSentence(p: Pick<PendingRequest, 'kind' | 'toolName' | 'toolInput' | 'elicitation'>): string {
  if (p.kind !== 'permission') return askLine(p);
  const what = askTarget(p.toolInput);
  return `${shortToolName(p.toolName)} ${wantsTo(p.toolName)}${what ? `: ${what}` : ''}`;
}

/**
 * One question's answer, as Claude Code takes it: the option picked, several joined with ", " (multi-select), and
 * what you wrote under Other in place of (or, multi-select, after) them. Empty: not answered yet.
 */
export function askAnswer(picked: string[], other: string, multi: boolean): string {
  const own = other.trim();
  if (!multi) return own || picked[0] || '';
  return [...picked, ...(own ? [own] : [])].join(', ');
}

type FormSchema = { properties?: Record<string, { type?: string; title?: string }>; required?: string[] };

/** An MCP server's form: the required fields still empty (their titles), and the values to send (numbers as numbers). */
export function formCheck(schema: FormSchema, vals: Record<string, unknown>): { missing: string[]; content: Record<string, unknown> } {
  const content: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    const v = vals[k];
    if (v === undefined || v === '') continue;
    if (s.type === 'number' || s.type === 'integer') {
      const n = Number(v);
      if (Number.isFinite(n)) content[k] = s.type === 'integer' ? Math.trunc(n) : n;
    } else content[k] = v;
  }
  const missing = (schema.required ?? []).filter((k) => content[k] === undefined && schema.properties?.[k]?.type !== 'boolean').map((k) => schema.properties?.[k]?.title ?? k);
  return { missing, content };
}
