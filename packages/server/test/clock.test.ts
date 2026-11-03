import { describe, expect, it } from 'vitest';
import { nowLine } from '../src/clock';

/** Sessions (and Cora) know the time, not just the date Claude Code gives them once (David's notes). */
describe('nowLine', () => {
  it('the weekday, date and time where you are, with the zone', () => {
    const at = new Date('2026-11-01T17:42:00Z');
    expect(nowLine(at, 'UTC')).toBe("From Cora: it's Sunday, November 1, 2026 at 5:42 PM (UTC).");
    expect(nowLine(at, 'America/New_York')).toBe("From Cora: it's Sunday, November 1, 2026 at 12:42 PM (America/New_York).");
  });
  it('past midnight it is the next day', () => {
    expect(nowLine(new Date('2026-11-02T00:05:00Z'), 'UTC')).toContain('Monday, November 2, 2026 at 12:05 AM');
  });
  it('without a zone: this machine’s', () => {
    expect(nowLine(new Date())).toContain(`(${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  });
});

describe('sessions hear the time', () => {
  it("on a session's first prompt, then not again until ten minutes have passed", async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { vi } = await import('vitest');
    const { loadConfig } = await import('../src/config');
    const { startServer } = await import('../src/server');
    const { TIME_EVERY_MS } = await import('../src/clock');
    vi.useFakeTimers({ now: new Date('2026-11-01T17:42:00Z'), toFake: ['Date'] });
    const srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'cora-clock-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope-client') }), { tail: false, listen: false });
    try {
      const prompt = (n: number) => srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: 'sess-clock-1', cwd: 'C:/work/x', prompt: 'hi', prompt_id: `c-${n}` } });
      const first = await prompt(1);
      expect(first.json().hookSpecificOutput.additionalContext).toContain('November 1, 2026');
      expect((await prompt(2)).statusCode).toBe(204);
      vi.setSystemTime(Date.now() + TIME_EVERY_MS);
      expect((await prompt(3)).json().hookSpecificOutput.additionalContext).toMatch(/^From Cora: it's Sunday, November 1, 2026 at /);
    } finally {
      vi.useRealTimers();
      await srv.close();
    }
  });
});
