import { describe, expect, it } from 'vitest';
import { TEST_CMD, testCounts } from '../src/lib/testRuns';

describe('test runs', () => {
  it('knows a test command', () => {
    for (const c of ['npx vitest run', 'npm test', 'npm run test:unit', 'pnpm test', 'pytest -q tests/', 'go test ./...', 'cargo test', 'yarn test --watch=false']) expect(TEST_CMD.test(c)).toBe(true);
    for (const c of ['npm run build', 'git status', 'ls tests/']) expect(TEST_CMD.test(c)).toBe(false);
  });

  it('reads the counts of each runner', () => {
    expect(testCounts(' Test Files  151 passed (151)\n      Tests  1 failed | 1027 passed (1028)\n')).toEqual({ pass: 1027, fail: 1, skip: 0 });
    expect(testCounts('Tests:       2 failed, 1 skipped, 30 passed, 33 total')).toEqual({ pass: 30, fail: 2, skip: 1 });
    expect(testCounts('==== 3 failed, 10 passed, 2 skipped in 1.20s ====')).toEqual({ pass: 10, fail: 3, skip: 2 });
    expect(testCounts('test result: ok. 12 passed; 0 failed; 1 ignored; 0 measured')).toEqual({ pass: 12, fail: 0, skip: 1 });
    expect(testCounts('ok  \texample.com/a\t0.01s\nFAIL\texample.com/b\t0.02s\n')).toEqual({ pass: 1, fail: 1, skip: 0 });
    expect(testCounts('\x1b[32m Tests \x1b[0m 5 passed (5)')).toEqual({ pass: 5, fail: 0, skip: 0 });
    expect(testCounts('nothing to see')).toBeNull();
  });
});
