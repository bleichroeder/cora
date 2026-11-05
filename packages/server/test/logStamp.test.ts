import { afterEach, describe, expect, it } from 'vitest';
import { stampConsole, stamped } from '../src/logStamp';

describe('server.log lines carry their time', () => {
  const at = new Date('2026-11-03T19:49:16.465Z');
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  afterEach(() => Object.assign(console, saved));

  it('each line that says something, as the terminal host stamps its own (blank lines stay blank)', () => {
    expect(stamped('  orchestrator: resumed (d8a158e7)', at)).toBe('2026-11-03T19:49:16.465Z   orchestrator: resumed (d8a158e7)');
    expect(stamped('\n  Cora listening on http://127.0.0.1:4317\n', at)).toBe('\n2026-11-03T19:49:16.465Z   Cora listening on http://127.0.0.1:4317\n');
  });

  it('console.log and console.error, formatted as they would be, then stamped', () => {
    const out: string[] = [];
    console.log = (s: string) => void out.push(s);
    console.error = (s: string) => void out.push(s);
    stampConsole(() => at);
    console.log('  closed %d shells', 2);
    console.error('[cora] orchestrator feed', 'boom');
    expect(out).toEqual(['2026-11-03T19:49:16.465Z   closed 2 shells', '2026-11-03T19:49:16.465Z [cora] orchestrator feed boom']);
  });
});
