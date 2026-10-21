import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { rollLog } from './fsx';

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

/** Append-only JSONL log of every Needs-you decision. Inputs are stored as a hash only. */
export class Audit {
  private n = 0;
  constructor(private file: string | null) {
    if (file) rollLog(file, 5_000_000);
  }

  log(e: AuditEntry): void {
    if (!this.file) return;
    // looked at now and then: past about 5 MB the older half moves to audit.log.1
    if (++this.n % 500 === 0) rollLog(this.file, 5_000_000);
    const { input, ...rest } = e;
    const inputHash = createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex');
    try {
      appendFileSync(this.file, JSON.stringify({ ...rest, inputHash }) + '\n');
    } catch {
      /* audit must never break the request path */
    }
  }
}
