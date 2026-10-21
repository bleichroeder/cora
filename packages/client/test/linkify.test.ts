import { describe, expect, it } from 'vitest';
import { URL_RE, firstUrl } from '../src/components/Linkify';

describe('web addresses in plain text', () => {
  it('finds them without trailing punctuation or closing brackets', () => {
    expect(firstUrl('see https://gitlab.com/g/p/-/merge_requests/35.')).toBe('https://gitlab.com/g/p/-/merge_requests/35');
    expect(firstUrl('(https://acme.atlassian.net/browse/WEB-123)')).toBe('https://acme.atlassian.net/browse/WEB-123');
    expect(firstUrl('curl -s "https://api.x.io/v1/a?b=1&c=2" | jq')).toBe('https://api.x.io/v1/a?b=1&c=2');
    expect(firstUrl('no links here')).toBeNull();
    expect('a http://a.b/c and https://d.e/f'.match(URL_RE)).toEqual(['http://a.b/c', 'https://d.e/f']);
  });
});
