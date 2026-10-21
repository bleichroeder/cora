import { createReadStream, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { isSafeId, resultText } from '@cora/shared';

const MAX_RESULT = 200_000;

export type ToolDetail = { input: unknown; result: string; toolUseResult?: unknown; isError?: boolean };

/** Subagent transcripts live next to the main one: <dir>/<sessionId>/subagents/agent-<id>.jsonl */
export function transcriptFor(mainPath: string, sessionId: string, agentId: string): string {
  if (agentId === 'main') return mainPath;
  if (!isSafeId(sessionId) || !isSafeId(agentId)) throw new Error('not an agent id');
  return join(dirname(mainPath), sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

/** Re-read a transcript to recover the full (untruncated) input and result of one tool call. */
export async function readToolDetail(file: string, toolUseId: string): Promise<ToolDetail | null> {
  if (!existsSync(file)) return null;
  const needle = `"${toolUseId}"`;
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
