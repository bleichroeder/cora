import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { rollLog } from './fsx';
import type { CopyCost } from './orchestrator/copy';

export type AuditEntry = {
  ts: number;
  sessionId: string;
  agentId: string;
  kind: string;
  tool: string;
  input: unknown;
  decision: string;
  edited: boolean;
  via: 'dashboard' | 'timeout' | 'terminal' | 'no-client' | 'orchestrator';
  /** decided by the orchestrator's mandate: the rule that did */
  rule?: string;
};

/**
 * Append-only JSONL log of every Needs-you decision (inputs are stored as a hash only), and of what each of Cora's side
 * questions to a copy of a session cost (`kind: 'copy'`).
 */
export class Audit {
  private n = 0;
  constructor(private file: string | null) {
    if (file) rollLog(file, 5_000_000);
  }

  log(e: AuditEntry): void {
    const { input, ...rest } = e;
    const inputHash = createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex');
    this.append({ ...rest, inputHash });
  }

  /** A side question's run: which session it copied, what it read and wrote, what it cost. */
  copy(c: CopyCost, ts = Date.now()): void {
    this.append({ ts, kind: 'copy', ...c });
  }

  private append(line: object): void {
    if (!this.file) return;
    // looked at now and then: past about 5 MB the older half moves to audit.log.1
    if (++this.n % 500 === 0) rollLog(this.file, 5_000_000);
    try {
      appendFileSync(this.file, JSON.stringify(line) + '\n');
    } catch {
      /* audit must never break the request path */
    }
  }
}
