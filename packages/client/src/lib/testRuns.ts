/** Test runs, read from the shell commands a session ran (the live board's Tests panel). */

/** A command that runs tests. */
export const TEST_CMD = /\b(vitest|jest|pytest|mocha|ava|playwright test|cypress run|go test|cargo test|dotnet test|phpunit|rspec|tox|nox|(npm|pnpm|yarn|bun)( run)? test(:\S+)?|npm t)\b/i;

/** What a test run printed, as counts (vitest, jest, pytest, cargo, go, and anything saying "N passed / N failed"). */
export function testCounts(text: string): { pass: number; fail: number; skip: number } | null {
  const t = text.replace(/\x1b\[[0-9;]*m/g, '');
  const n = (re: RegExp) => {
    const all = [...t.matchAll(re)];
    return all.length ? +all[all.length - 1][1] : null;
  };
  // vitest: "Tests  1 failed | 1027 passed (1028)"; jest: "Tests:  1 failed, 30 passed, 31 total"
  const line = t.match(/^\s*Tests:?\s+(.*)$/m)?.[1];
  if (line && /passed|failed/.test(line)) {
    const g = (w: string) => +(line.match(new RegExp(`(\\d+) ${w}`))?.[1] ?? 0);
    return { pass: g('passed'), fail: g('failed'), skip: g('skipped') + g('todo') };
  }
  // cargo: "test result: ok. 10 passed; 0 failed; 1 ignored"
  const cargo = t.match(/test result: \w+\. (\d+) passed; (\d+) failed(?:; (\d+) ignored)?/);
  if (cargo) return { pass: +cargo[1], fail: +cargo[2], skip: +(cargo[3] ?? 0) };
  // go: a line per package
  const okPk = (t.match(/^ok\s+\S+/gm) ?? []).length;
  const failPk = (t.match(/^(FAIL|--- FAIL)\s+\S+/gm) ?? []).length;
  if (okPk || failPk) return { pass: okPk, fail: failPk, skip: 0 };
  // pytest and the rest: the last "N passed" / "N failed"
  const pass = n(/(\d+) passed/g);
  const fail = n(/(\d+) failed/g);
  if (pass == null && fail == null) return null;
  return { pass: pass ?? 0, fail: fail ?? 0, skip: n(/(\d+) skipped/g) ?? 0 };
}
