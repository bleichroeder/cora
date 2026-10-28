import { describe, expect, it } from 'vitest';
import { inScope, jwtExpiry, mask, secretNameProblem } from '../src/secrets';

const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2lnbmF0dXJl`;

describe('secrets', () => {
  it('names: capitals, digits and underscores; the system and Cora keep theirs', () => {
    expect(secretNameProblem('GITHUB_PAT')).toBeNull();
    expect(secretNameProblem('github')).toMatch(/capitals/);
    expect(secretNameProblem('PATH')).toMatch(/taken/);
    expect(secretNameProblem('CORA_TOKEN')).toMatch(/taken/);
  });

  it("a JWT's expiry is read from it; anything else has none", () => {
    expect(jwtExpiry(jwt({ sub: 'x', exp: 1_900_000_000 }))).toBe(1_900_000_000_000);
    expect(jwtExpiry(jwt({ sub: 'x' }))).toBeNull();
    expect(jwtExpiry('ghp_0123456789abcdef')).toBeNull();
    expect(jwtExpiry('a.b.c')).toBeNull();
  });

  it('masks a value as it is, base64 and URL-encoded; short ones are left', () => {
    const v = 'ghp_s3cr3t/value+x';
    const text = `got ${v} and ${Buffer.from(v).toString('base64')} and ${encodeURIComponent(v)} and abc`;
    expect(mask(text, [v, 'abc'])).toBe('got •••• and •••• and •••• and abc');
  });

  it('scope: all sessions, or those in its folders (any case, either slash)', () => {
    expect(inScope({ scope: { all: true } }, 'C:/x')).toBe(true);
    const s = { scope: { folders: ['C:\\GitLab\\orion-services'] } };
    expect(inScope(s, 'c:/gitlab/orion-services/sub')).toBe(true);
    expect(inScope(s, 'C:\\gitlab\\orion-ui')).toBe(false);
  });
});
