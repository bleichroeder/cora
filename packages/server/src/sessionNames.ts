import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { displayName, hasOwnName, type SessionInfo } from '@cora/shared';
import { writeFileAtomic } from './fsx';

/** How many names it keeps (the newest). */
const KEEP = 3000;

/**
 * What sessions were called, kept past Cora's history (sessions it no longer lists still carry their name in Resume):
 * the ones with a name of their own (yours, their ticket's or issue's, Cora's suggestion), newest last.
 */
export class SessionNames {
  private names = new Map<string, string>();
  private file: string | null;
  constructor(dataDir: string | null) {
    this.file = dataDir ? join(dataDir, 'session-names.json') : null;
    try {
      if (this.file && existsSync(this.file)) for (const [id, n] of Object.entries(JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>)) this.names.set(id, n);
    } catch {
      /* start afresh */
    }
  }

  /** Note the names of these sessions (those that have one of their own); saved when anything changed. */
  remember(sessions: SessionInfo[]): void {
    let changed = false;
    for (const s of sessions) {
      if (!hasOwnName(s)) continue;
      const n = displayName(s);
      if (this.names.get(s.id) === n) continue;
      this.names.delete(s.id);
      this.names.set(s.id, n);
      changed = true;
    }
    if (!changed) return;
    while (this.names.size > KEEP) this.names.delete(this.names.keys().next().value!);
    try {
      if (this.file) writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.names)));
    } catch {
      /* not kept this time */
    }
  }

  get(id: string): string | undefined {
    return this.names.get(id);
  }
}
