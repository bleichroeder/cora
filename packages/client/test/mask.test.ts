import { describe, expect, it } from 'vitest';
import { maskSecrets } from '../src/lib/mask';

describe('maskSecrets', () => {
  it.each([
    ['export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456', 'export GITHUB_TOKEN=••••••'],
    ['curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def" x', 'curl -H "Authorization: Bearer ••••••" x'],
    ['aws key AKIAIOSFODNN7EXAMPLE here', 'aws key •••••• here'],
    ['API_KEY: "s3cr3tvalue"', 'API_KEY: "••••••"'],
    ['use sk-ant-api03-abcdefghijklmnopqrstuvwx', 'use ••••••'],
    ['password=hunter22', 'password=••••••'],
  ])('%s', (input, out) => {
    const r = maskSecrets(input);
    expect(r.text).toBe(out);
    expect(r.masked).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    expect(maskSecrets('git status && npm test')).toEqual({ text: 'git status && npm test', masked: false });
  });
});
