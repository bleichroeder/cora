import type { Debrief, DebriefScript, Playing } from '@cora/shared';

/** What the player steps through: the steps, and Teach me's quiz as one more page after them. */
export const nav = (d: Debrief) => ({ steps: [...d.steps, ...(d.quiz?.length ? [{ beats: d.quiz.map((q) => ({ text: q.q })) }] : [])] }) as Pick<DebriefScript, 'steps'>;

/** The Debrief button's ask, sent to a session. */
export const DEBRIEF_ASK = (depth: 'quick' | 'teach') => `Debrief me (${depth === 'teach' ? 'teach me' : 'quick'}) on your last piece of work`;

/**
 * Where an ask for a debrief has got to in the session's events: not taken yet (queued behind its work), being
 * written, or its turn over (with no debrief made, if it's still being waited for).
 */
export function askProgress(events: { kind: string; agentId?: string; ts: number; text?: string }[], since: number): 'queued' | 'writing' | 'ended' {
  const mine = events.filter((e) => (e.agentId ?? 'main') === 'main' && e.ts >= since - 1000);
  const p = mine.findIndex((e) => e.kind === 'prompt' && /^Debrief me \(/.test(e.text ?? ''));
  if (p < 0) return 'queued';
  return mine.slice(p + 1).some((e) => e.kind === 'turn_end') ? 'ended' : 'writing';
}

/** Where you are, as a question to the session gives it: `3/7 · server.ts:615-616`, or the quiz. */
export function debriefPlace(d: Debrief, at: Playing): string {
  if (at.step >= d.steps.length) return 'quiz';
  const st = d.steps[at.step];
  const file = st.path ? ` · ${st.path.split(/[\\/]/).pop()}${st.range ? `:${st.range[0]}${st.range[1] !== st.range[0] ? `-${st.range[1]}` : ''}` : ''}` : '';
  return `${at.step + 1}/${nav(d).steps.length}${file}`;
}

/** The session's answer to a question: its words in the turn after it (asides and explains left out). */
export function replyOf(events: { kind: string; agentId?: string; ts: number; text?: string }[], asked: string, since: number): string | null {
  const mine = events.filter((e) => (e.agentId ?? 'main') === 'main' && e.ts >= since - 1000);
  const p = mine.findIndex((e) => e.kind === 'prompt' && (e.text ?? '').includes(asked));
  if (p < 0) return null;
  const after = mine.slice(p + 1);
  const end = after.findIndex((e) => e.kind === 'turn_end');
  if (end < 0) return null;
  const words = after
    .slice(0, end)
    .filter((e) => e.kind === 'say' && e.text)
    .map((e) => e.text!.replace(/<!--[\s\S]*?-->/g, '').trim())
    .filter(Boolean);
  return words.join('\n\n') || '(no answer in words)';
}
