import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { on: () => {} }, BrowserWindow: {}, desktopCapturer: {}, dialog: {}, session: {}, shell: {} }));
const { keepLogins, keepable } = await import('../src/browser');

type C = { name: string; value: string; domain: string; path: string; session: boolean; hostOnly: boolean; secure: boolean; httpOnly: boolean; sameSite: string };
const cookie = (name: string, value: string, domain = 'gitlab.example.com'): C => ({ name, value, domain, path: '/', session: true, hostOnly: true, secure: true, httpOnly: true, sameSite: 'lax' });

/** A cookie store: what's in it now, what Cora set, and its "changed" listener. */
function jar() {
  const now = new Map<string, C>();
  const set: Array<{ name: string; value: string; expirationDate?: number }> = [];
  let changed: (e: unknown, c: C, cause: string, removed: boolean) => void = () => {};
  const ses = {
    cookies: {
      on: (_: string, f: typeof changed) => void (changed = f),
      get: async ({ name }: { name: string }) => (now.has(name) ? [now.get(name)!] : []),
      set: async (d: { name: string; value: string; expirationDate?: number }) => void set.push(d),
      flushStore: async () => {},
    },
  };
  keepLogins(ses as never, 20);
  const page = (c: C) => (now.set(c.name, c), changed({}, c, 'explicit', false));
  return { set, page };
}
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('staying signed in across restarts', () => {
  it("a session cookie gets an expiry, but only while it's still the value just set (a newer one isn't set back)", async () => {
    const j = jar();
    j.page(cookie('_gitlab_session', 'v1'));
    j.page(cookie('_gitlab_session', 'v2')); // set again before the first was kept
    await settle();
    expect(j.set.map((s) => s.value)).toEqual(['v2']);
    // removed meanwhile: nothing kept
    j.page(cookie('_xsrf', 'a'));
    j.page({ ...cookie('_xsrf', 'a'), session: false });
    await settle();
    expect(j.set.map((s) => s.name)).toEqual(['_gitlab_session']);
    expect(j.set[0].expirationDate).toBeGreaterThan(Date.now() / 1000);
  });

  it("Google's account cookies are left as they are", async () => {
    const j = jar();
    j.page(cookie('__Host-GAPS', 'x', 'accounts.google.com'));
    j.page(cookie('SMSV', 'y', '.google.com'));
    await settle();
    expect(j.set).toEqual([]);
    expect(keepable('.google.com')).toBe(false);
    expect(keepable('accounts.google.com')).toBe(false);
    expect(keepable('gitlab.example.com')).toBe(true);
    expect(keepable('notgoogle.com')).toBe(true);
  });
});
