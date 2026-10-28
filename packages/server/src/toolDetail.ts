import { createReadStream, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { isSafeId, resultText } from '@cora/shared';
import { bangOutput } from './transcript/parse';

const MAX_RESULT = 200_000;

export type ToolDetail = { input: unknown; result: string; toolUseResult?: unknown; isError?: boolean };

/** Subagent transcripts live next to the main one: <dir>/<sessionId>/subagents/agent-<id>.jsonl */
export function transcriptFor(mainPath: string, sessionId: string, agentId: string): string {
  if (agentId === 'main') return mainPath;
  if (!isSafeId(sessionId) || !isSafeId(agentId)) throw new Error('not an agent id');
  return join(dirname(mainPath), sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

/**
 * Re-read a transcript to recover the full (untruncated) input and result of one tool call. A command you ran yourself
 * (`bang:<uuid>`, transcript/parse.ts) is that line and the output line after it.
 */
export async function readToolDetail(file: string, toolUseId: string): Promise<ToolDetail | null> {
  if (!existsSync(file)) return null;
  const bang = toolUseId.startsWith('bang:') ? toolUseId.slice('bang:'.length) : null;
  const needle = `"${bang ?? toolUseId}"`;
  let out: ToolDetail | null = null;
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes(needle)) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (bang) {
      const text = typeof obj.message?.content === 'string' ? obj.message.content : '';
      const command = obj.uuid === bang ? text.match(/^<bash-input>([\s\S]*?)<\/bash-input>/)?.[1] : undefined;
      if (command != null) out = { ...(out ?? { result: '' }), input: { command: command.trim() } };
      if (obj.parentUuid === bang && /^<bash-(stdout|stderr)>/.test(text)) {
        const o = bangOutput(text);
        out = { ...(out ?? { input: null }), result: o.out.length > MAX_RESULT ? o.out.slice(0, MAX_RESULT) + '\n…[truncated]' : o.out, isError: o.refused };
      }
      continue;
    }
    for (const b of obj.message?.content ?? []) {
      if (b?.type === 'tool_use' && b.id === toolUseId) out = { ...(out ?? { result: '' }), input: b.input };
      if (b?.type === 'tool_result' && b.tool_use_id === toolUseId) {
        const text = resultText(b.content);
        out = { ...(out ?? { input: null }), result: text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + '\n…[truncated]' : text, toolUseResult: obj.toolUseResult, isError: Boolean(b.is_error) };
      }
    }
  }
  rl.close();
  return out;
}
