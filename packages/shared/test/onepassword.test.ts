import { describe, expect, it } from 'vitest';
import { loginMatches, searchLogins, type OpLogin } from '../src/onepassword';

const login = (urls: string[], o: Partial<OpLogin> = {}): OpLogin => ({ id: 'i', title: 'Rancher prod', username: 'svc-deploy', vault: 'Ops', urls, ...o });

describe('1Password: which logins are for a page', () => {
  it("by the login's saved sites: the host, or a parent of it, any port", () => {
    expect(loginMatches(login(['https://rancher.acme.io']), 'https://rancher.acme.io/login')).toBe(true);
    expect(loginMatches(login(['acme.io']), 'https://rancher.acme.io:8443/dashboard')).toBe(true);
    expect(loginMatches(login(['https://rancher.acme.io/v3']), 'https://RANCHER.acme.io/')).toBe(true);
  });

  it('never a look-alike, a different site, or a page that is not a web page', () => {
    expect(loginMatches(login(['acme.io']), 'https://evil-acme.io/')).toBe(false);
    expect(loginMatches(login(['rancher.acme.io']), 'https://rancher.acme.io.evil.com/')).toBe(false);
    expect(loginMatches(login(['rancher.acme.io']), 'https://acme.io/')).toBe(false);
    expect(loginMatches(login(['acme.io']), 'file:///C:/acme.io')).toBe(false);
    expect(loginMatches(login([]), 'https://acme.io/')).toBe(false);
  });

  it('search: every word in the title or username, case aside', () => {
    const list = [login([], { id: 'a', title: 'Rancher prod', username: 'svc-deploy' }), login([], { id: 'b', title: 'Rancher dev', username: 'admin' }), login([], { id: 'c', title: 'Kibana', username: 'ro-user' })];
    expect(searchLogins(list, 'rancher').map((l) => l.id)).toEqual(['a', 'b']);
    expect(searchLogins(list, 'RANCHER admin').map((l) => l.id)).toEqual(['b']);
    expect(searchLogins(list, '  ')).toEqual([]);
  });
});
