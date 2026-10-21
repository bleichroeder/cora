import { appendFileSync } from 'node:fs';

export type StageName = 'host' | 'tx' | 'listen' | 'cora' | 'note';
export type StageEvent = {
  s: StageName;
  e: 'start' | 'done' | 'skip' | 'progress' | 'warn';
  done?: number;
  total?: number;
  /** the terminal host: how many sessions kept running in it (after a restart or an update) */
  kept?: number;
  /** transcripts read: how many sessions, and how many are live */
  sessions?: number;
  live?: number;
  /** Cora's agent: still running, or started */
  how?: 'kept' | 'started' | 'error';
  /** a note the splash shows under the stages */
  key?: 'hooks' | 'nohost';
};

let lastProgress = 0;

/**
 * Startup progress for the desktop app's splash: JSON lines appended to $CORA_STAGE_FILE when it's set
 * (a file, not stdout: the server must not depend on the app that launched it staying alive).
 */
export function stage(s: StageName, e: StageEvent['e'], extra: Omit<StageEvent, 's' | 'e'> = {}): void {
  const file = process.env.CORA_STAGE_FILE ?? process.env.AGENT_BRAIN_STAGE_FILE;
  if (!file) return;
  if (e === 'progress') {
    const now = Date.now();
    if (now - lastProgress < 100) return;
    lastProgress = now;
  }
  try {
    appendFileSync(file, JSON.stringify({ s, e, ...extra } satisfies StageEvent) + '\n');
  } catch {
    /* the splash is cosmetic; never let it break startup */
  }
}
