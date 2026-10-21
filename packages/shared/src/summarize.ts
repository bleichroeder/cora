/** One hunk of a unified diff, as Claude Code records it for Edit/Write ("structuredPatch"). */
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

/** What a file-changing tool did: the file, how, and the hunks (absent when too big to carry). */
export type FileChange = { path: string; kind: 'edit' | 'create' | 'update'; hunks?: Hunk[]; add: number; del: number };

export type ToolSummary = {
  summary: string;
  resultSummary?: string;
  preview?: string;
  resource?: string;
  failed?: boolean;
  change?: FileChange;
  background?: { taskId: string; outputFile?: string };
};

/** Hunks bigger than this (in lines) aren't carried on the event; the viewer fetches them from the transcript. */
export const MAX_CHANGE_LINES = 2000;

function fileChange(name: string, path: string, tur: any, input: any): FileChange | undefined {
  if (!path) return undefined;
  const kind: FileChange['kind'] = name === 'Write' ? (tur?.type === 'create' ? 'create' : 'update') : 'edit';
  let hunks: Hunk[] | undefined = Array.isArray(tur?.structuredPatch)
    ? tur.structuredPatch.filter((h: any) => h && Array.isArray(h.lines)).map((h: any) => ({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines.filter((l: unknown) => typeof l === 'string') }))
    : undefined;
  // a new file has no patch: its content is the change
  const content = typeof (tur?.content ?? input?.content) === 'string' ? (tur?.content ?? input?.content) : null;
  if (kind === 'create' && (!hunks || !hunks.length) && content != null) {
    const lines = content.replace(/\n$/, '').split('\n');
    hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l: string) => '+' + l) }];
  }
  if (!hunks) return { path, kind, add: 0, del: 0 };
  let add = 0;
  let del = 0;
  let n = 0;
  for (const h of hunks) for (const l of h.lines) {
    n++;
    if (l.startsWith('+')) add++;
    else if (l.startsWith('-')) del++;
  }
  return { path, kind, add, del, ...(n <= MAX_CHANGE_LINES ? { hunks } : {}) };
}

const MAX_SUMMARY = 120;
const MAX_PREVIEW = 4000;

const clip = (s: string, n = MAX_SUMMARY) => (s.length > n ? s.slice(0, n) + '…' : s);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function slash(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Path relative to cwd when inside it, otherwise the last 3 segments. */
export function displayPath(p: string, cwd?: string): string {
  const fp = slash(p);
  if (cwd) {
    const base = slash(cwd).replace(/\/+$/, '') + '/';
    if (fp.toLowerCase().startsWith(base.toLowerCase())) return fp.slice(base.length) || fp;
  }
  const parts = fp.split('/').filter(Boolean);
  return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : fp;
}

function fileResource(p: string | undefined, cwd?: string): string {
  if (!p) return 'files';
  const rel = displayPath(p, cwd);
  if (rel.startsWith('…') || /^[a-zA-Z]:\//.test(rel) || rel.startsWith('/')) return 'files';
  const segs = rel.split('/');
  return segs.length > 1 ? `files:${segs[0]}` : 'files';
}

/** Flatten a tool_result content (string | blocks[]) to text. */
export function resultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result
      .map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : ''))
      .join('\n');
  }
  if (typeof result === 'object' && typeof (result as any).text === 'string') return (result as any).text;
  return '';
}

function countLines(s: string): number {
  const t = s.replace(/\n+$/, '');
  return t ? t.split('\n').length : 0;
}

function patchStats(patch: any): string | undefined {
  if (!Array.isArray(patch)) return undefined;
  let add = 0;
  let del = 0;
  for (const h of patch) for (const l of h?.lines ?? []) {
    if (typeof l !== 'string') continue;
    if (l.startsWith('+')) add++;
    else if (l.startsWith('-')) del++;
  }
  return `+${add} −${del}`;
}

function patchPreview(patch: any): string | undefined {
  if (!Array.isArray(patch)) return undefined;
  return clip(patch.flatMap((h: any) => h?.lines ?? []).join('\n'), MAX_PREVIEW);
}

function hostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * One-line summary of a tool call and (optionally) its result.
 * @param result       tool_result content from the transcript (string | blocks)
 * @param toolUseResult structured result (transcript `toolUseResult` or hook `tool_response`)
 */
export function summarizeTool(
  name: string,
  input?: any,
  result?: unknown,
  toolUseResult?: any,
  cwd?: string,
  isError?: boolean,
): ToolSummary {
  const inp = input ?? {};
  const tur = toolUseResult && typeof toolUseResult === 'object' ? toolUseResult : undefined;
  const text = resultText(result);
  const failed = Boolean(isError || tur?.is_error || tur?.interrupted);
  const out: ToolSummary = { summary: '' };
  if (failed) out.failed = true;
  const failText = () => clip((text || resultText(tur?.stderr) || 'failed').split('\n')[0], 80);

  switch (name) {
    case 'Read': {
      out.summary = displayPath(inp.file_path ?? tur?.file?.filePath ?? '', cwd);
      out.resource = fileResource(inp.file_path, cwd);
      const n = tur?.file?.numLines ?? (text ? countLines(text) : undefined);
      if (tur?.type === 'image') out.resultSummary = 'image';
      else if (n != null && (tur || text)) out.resultSummary = plural(n, 'line');
      if (tur?.file?.content) out.preview = clip(tur.file.content, MAX_PREVIEW);
      break;
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const p = inp.file_path ?? inp.notebook_path ?? tur?.filePath ?? '';
      out.summary = displayPath(p, cwd);
      out.resource = fileResource(p, cwd);
      if (name === 'Write' && tur?.type === 'create') {
        out.resultSummary = `new file · ${plural(countLines(inp.content ?? tur?.content ?? ''), 'line')}`;
      } else {
        out.resultSummary = patchStats(tur?.structuredPatch);
      }
      out.preview = patchPreview(tur?.structuredPatch);
      if (!failed && tur) out.change = fileChange(name, p, tur, inp);
      break;
    }
    case 'Grep': {
      out.summary = `"${clip(String(inp.pattern ?? ''), 60)}"${inp.path ? ` in ${displayPath(inp.path, cwd)}` : ''}`;
      out.resource = fileResource(inp.path ? inp.path + '/x' : undefined, cwd);
      if (tur) {
        if (tur.mode === 'content' && tur.numLines != null) out.resultSummary = `${plural(tur.numLines, 'match')} in ${plural(tur.numFiles ?? 0, 'file')}`.replace('matchs', 'matches');
        else if (tur.numFiles != null) out.resultSummary = plural(tur.numFiles, 'file');
        if (tur.content) out.preview = clip(String(tur.content), MAX_PREVIEW);
        else if (Array.isArray(tur.filenames)) out.preview = clip(tur.filenames.join('\n'), MAX_PREVIEW);
      }
      break;
    }
    case 'Glob': {
      out.summary = clip(String(inp.pattern ?? ''));
      out.resource = fileResource(inp.path ? inp.path + '/x' : undefined, cwd);
      if (tur?.numFiles != null) out.resultSummary = plural(tur.numFiles, 'file');
      if (Array.isArray(tur?.filenames)) out.preview = clip(tur.filenames.join('\n'), MAX_PREVIEW);
      break;
    }
    case 'Bash':
    case 'PowerShell': {
      out.summary = clip(String(inp.command ?? '').replace(/\s+/g, ' ').trim());
      out.resource = 'shell';
      // only a call that asked for the background (its output may merely mention the phrase): the structured result
      // says so, or failing that the result starts with Claude Code's own line
      const bgId = inp.run_in_background === true ? (tur?.backgroundTaskId ?? text.trim().match(/^Command running in background with ID: (\w+)/)?.[1]) : undefined;
      if (bgId && !failed) {
        // sent to the background: it returns at once, and finishes later (a task-notification)
        const file = text.match(/Output is being written to: (.+?\.output)/)?.[1];
        out.background = { taskId: String(bgId), ...(file ? { outputFile: file } : {}) };
        out.resultSummary = 'running in background';
        break;
      }
      if (failed) out.resultSummary = failText();
      else if (tur) {
        const so = String(tur.stdout ?? '');
        out.resultSummary = so.trim() ? plural(countLines(so), 'line') : 'no output';
        out.preview = clip([so, tur.stderr].filter(Boolean).join('\n'), MAX_PREVIEW);
      } else if (text) {
        out.resultSummary = plural(countLines(text), 'line');
        out.preview = clip(text, MAX_PREVIEW);
      }
      break;
    }
    case 'WebFetch': {
      const url = String(inp.url ?? '');
      out.summary = clip(url.replace(/^https?:\/\//, ''));
      const h = hostname(url);
      out.resource = h ? `web:${h}` : 'web';
      if (tur?.bytes != null) out.resultSummary = `${Math.max(1, Math.round(tur.bytes / 1024))} KB`;
      if (tur?.result) out.preview = clip(String(tur.result), MAX_PREVIEW);
      else if (text) out.preview = clip(text, MAX_PREVIEW);
      break;
    }
    case 'WebSearch': {
      out.summary = `"${clip(String(inp.query ?? ''), 100)}"`;
      out.resource = 'web:search';
      const n = Array.isArray(tur?.results) ? tur.results.length : undefined;
      if (n != null) out.resultSummary = plural(n, 'result');
      if (text) out.preview = clip(text, MAX_PREVIEW);
      break;
    }
    case 'Agent':
    case 'Task': {
      out.summary = clip(String(inp.description ?? inp.subagent_type ?? 'subagent'));
      if (tur?.totalToolUseCount != null) out.resultSummary = `${plural(tur.totalToolUseCount, 'tool')}`;
      else if (tur?.isAsync || tur?.status === 'async_launched') out.resultSummary = 'launched';
      if (text) out.preview = clip(text, MAX_PREVIEW);
      break;
    }
    case 'TodoWrite':
      out.summary = plural(Array.isArray(inp.todos) ? inp.todos.length : 0, 'todo');
      break;
    case 'AskUserQuestion':
      out.summary = clip(String(inp.questions?.[0]?.question ?? 'question'));
      if (text) out.preview = clip(text, MAX_PREVIEW);
      break;
    case 'Skill':
      out.summary = String(inp.skill ?? '');
      break;
    case 'TaskCreate':
      out.summary = clip(String(inp.subject ?? ''), 120);
      break;
    case 'TaskUpdate':
      out.summary = `#${inp.taskId ?? '?'}${inp.status ? ` → ${String(inp.status).replace('_', ' ')}` : ''}${inp.subject ? ` · ${clip(String(inp.subject), 80)}` : ''}`;
      break;
    case 'mcp__cora__speak':
      // a line said out loud to the user: what was said, no resource (it touches nothing)
      out.summary = clip(String(inp.text ?? ''), 300);
      break;
    case 'mcp__cora__open_tab':
      out.summary = clip(String(inp.url ?? ''), 120);
      out.resource = 'browser';
      break;
    case 'mcp__cora__present':
    case 'mcp__agent-brain__present':
      out.summary = `${clip(String(inp.title ?? 'document'), 100)} · ${inp.format === 'html' ? 'HTML' : 'markdown'}`;
      break;
    default: {
      if (name.startsWith('mcp__')) {
        const server = name.split('__')[1] ?? 'mcp';
        out.resource = /^(playwright|chrome|claude-in-chrome|browser)/.test(server) ? 'browser' : `mcp:${server}`;
      }
      const j = input === undefined ? '' : JSON.stringify(input);
      out.summary = clip(j === '{}' ? '' : j);
      if (text) out.preview = clip(text, MAX_PREVIEW);
    }
  }
  if (failed && !out.resultSummary) out.resultSummary = failText();
  if (!out.preview && text && name !== 'Read') out.preview = clip(text, MAX_PREVIEW);
  return out;
}

/**
 * A reply's say-line: hosted sessions with spoken summaries end each turn's reply with `<!-- say: … -->`, a sentence or
 * two written to be heard. It costs no extra model call (a speak tool call at the end of a turn would). Only a line
 * that ends the reply counts (one quoted in the middle of a reply, say inside backticks, is just text). Returns the
 * reply without it, and the line.
 */
const SAY_LINE = /(?:^|\n)[ \t]*<!--\s*say:\s*((?:(?!-->)[\s\S])*?)\s*-->\s*$/i;
export function splitSay(text: string): { text: string; said?: string } {
  const m = text.match(SAY_LINE);
  const said = m?.[1].replace(/\s+/g, ' ').trim();
  if (!m || !said) return { text: text.trim() };
  return { text: text.slice(0, m.index).trim(), said };
}

/** An explain written inside a reply (between `<!-- cora:explain … -->` and `<!-- /cora:explain -->`). */
export type InlineExplain = { title: string; format: 'markdown' | 'html'; content: string };

// the opening marker starts a line (one quoted mid-sentence, say in backticks, is just text)
const EXPLAIN_BLOCK = /(?<=^|\n)[ \t]*<!--\s*cora:explain\b([\s\S]*?)-->([\s\S]*?)(?:<!--\s*\/\s*cora:explain\s*-->|$)/gi;

/**
 * The explains in a reply, taken out of it. Hosted sessions write explains this way rather than with the present tool:
 * a tool call needs another model request (over the whole conversation) for the model to see its result. Lenient: a
 * missing closing line runs to the end of the reply, and a document wrapped in one code fence is unwrapped.
 */
export function splitExplains(text: string): { text: string; explains: InlineExplain[] } {
  if (!/(?:^|\n)[ \t]*<!--\s*cora:explain\b/i.test(text)) return { text, explains: [] };
  const explains: InlineExplain[] = [];
  const body = text
    .replace(EXPLAIN_BLOCK, (_, attrs: string, inner: string) => {
      let content = inner.trim();
      const fenced = content.match(/^(`{3,}|~{3,})[\w-]*\n([\s\S]*?)\n\1$/);
      if (fenced) content = fenced[2];
      if (!content) return '';
      const rawTitle = attrs.match(/title\s*=\s*"((?:[^"\\]|\\.)*)"/i)?.[1] ?? attrs.match(/title\s*=\s*'([^']*)'/i)?.[1];
      const fmt = attrs.match(/format\s*=\s*["']?(markdown|html)/i)?.[1]?.toLowerCase();
      const html = fmt === 'html' || /^\s*(<!doctype html|<html[\s>])/i.test(content);
      explains.push({ title: (rawTitle ?? '').replace(/\\"/g, '"').trim() || 'Document', format: html ? 'html' : 'markdown', content });
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: body, explains };
}

/** A reply's first sentence (its "on it" line): up to the first stop on its first line, at most a short line. */
export function firstSentence(text: string): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  const m = line.match(/^.+?[.!?…](?=\s|$)/);
  return (m ? m[0] : line).slice(0, 300);
}
