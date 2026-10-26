import { describe, expect, it } from 'vitest';
import { OnePassword, parseItem, parseItemList } from '../src/onepassword';

const LIST = JSON.stringify([
  { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'Rancher prod', vault: { id: 'v', name: 'Ops' }, category: 'LOGIN', additional_information: 'svc-deploy', urls: [{ primary: true, href: 'https://rancher.acme.io' }] },
  { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb', title: 'No site', vault: { name: 'Private' }, category: 'LOGIN' },
]);
const ITEM = JSON.stringify({
  id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
  fields: [
    { id: 'username', type: 'STRING', purpose: 'USERNAME', label: 'username', value: 'svc-deploy' },
    { id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', label: 'password', value: 's3cret!' },
    { id: 'notesPlain', type: 'STRING', purpose: 'NOTES', value: 'hi' },
    { id: 'totp', type: 'OTP', label: 'one-time password', value: 'otpauth://totp/x?secret=ABC', totp: '123456' },
  ],
});

describe('1Password through op', () => {
  it('lists logins without a secret among them', () => {
    expect(parseItemList(LIST)).toEqual([
      { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'Rancher prod', username: 'svc-deploy', vault: 'Ops', urls: ['https://rancher.acme.io'] },
      { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb', title: 'No site', username: '', vault: 'Private', urls: [] },
    ]);
  });

  it("takes a login's username and password by their purpose, and the current code", () => {
    expect(parseItem(ITEM)).toEqual({ username: 'svc-deploy', password: 's3cret!', totp: '123456' });
    expect(parseItem(JSON.stringify({ fields: [] }))).toEqual({});
  });

  it('keeps the list a minute; asks for one login only by its id', async () => {
    const calls: string[][] = [];
    let now = 0;
    const op = new OnePassword({ now: () => now, run: async (a) => (calls.push(a), a[0] === 'item' && a[1] === 'list' ? LIST : ITEM) });
    await op.logins();
    await op.logins();
    now = 61_000;
    await op.logins();
    expect(calls.filter((a) => a[1] === 'list')).toHaveLength(2);
    expect(await op.secrets('aaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ password: 's3cret!' });
    expect(calls.at(-1)).toEqual(['item', 'get', 'aaaaaaaaaaaaaaaaaaaaaaaaaa', '--format', 'json', '--reveal']);
    await expect(op.secrets('--vault x')).rejects.toThrow(/not a 1Password item/);
  });

  it('answers at once from the kept list once it is over a minute old (asking for a fresh one behind it), forgotten on lock', async () => {
    let lists = 0;
    let release: () => void = () => {};
    let now = 0;
    const op = new OnePassword({ now: () => now, run: (a) => (a[1] === 'list' ? (lists++, lists === 1 ? Promise.resolve(LIST) : new Promise((r) => (release = () => r(LIST)))) : Promise.resolve(ITEM)) });
    const first = await op.logins();
    now = 5 * 60_000;
    // stale: the kept one, straight away, while 1Password is still answering
    expect(await op.logins()).toBe(first);
    expect(lists).toBe(2);
    release();
    // too old (over half an hour): waits for a fresh one
    now = 40 * 60_000;
    const waiting = op.logins();
    release();
    expect(await waiting).toHaveLength(first.length);
    // Cora locked: nothing kept
    op.forget();
    const asked = lists;
    void op.logins().catch(() => {});
    expect(lists).toBe(asked + 1);
  });

  it('says what is missing: the command line, or its connection to the app', async () => {
    const none = new OnePassword({ appPath: 'C:/nope/1Password.exe', run: async () => Promise.reject(new Error('not found')) });
    expect(await none.status()).toEqual({ app: false, cli: false, connected: false });
    const unlinked = new OnePassword({ appPath: 'C:/nope/1Password.exe', run: async (a) => (a[0] === '--version' ? '2.30.0' : '[]') });
    expect(await unlinked.status()).toEqual({ app: false, cli: true, connected: false });
    const ready = new OnePassword({ appPath: 'C:/nope/1Password.exe', run: async (a) => (a[0] === '--version' ? '2.30.0' : JSON.stringify([{ url: 'my.1password.com', email: 'x' }])) });
    expect((await ready.status()).connected).toBe(true);
  });
});

describe('finding the 1Password app', () => {
  it("its own installer's folders, or the alias of the package winget installs", async () => {
    const { opAppPaths } = await import('@cora/shared');
    expect(opAppPaths({ LOCALAPPDATA: String.raw`C:\Users\a\AppData\Local`, ProgramFiles: String.raw`C:\Program Files` })).toEqual([
      String.raw`C:\Users\a\AppData\Local\1Password\app\8\1Password.exe`,
      String.raw`C:\Program Files\1Password\app\8\1Password.exe`,
      String.raw`C:\Users\a\AppData\Local\Microsoft\WindowsApps\1Password.exe`,
    ]);
  });
});
