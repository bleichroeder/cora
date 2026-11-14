import { describe, expect, it } from 'vitest';
import { HttpAuth, plainText, siteKey, type AuthAsk, type Challenge, type Creds } from '../src/httpAuth';

const site = (o: Partial<Challenge> = {}): Challenge => ({ host: 'localhost', port: 3000, realm: 'dev', proxy: false, scheme: 'basic', url: 'http://localhost:3000/', ...o });
const setup = () => {
  const asked: AuthAsk[] = [];
  let t = 1000;
  const auth = new HttpAuth({ ask: (a) => asked.push(a), now: () => t });
  return { auth, asked, tick: (ms: number) => (t += ms) };
};
const ME: Creds = { username: 'dev', password: 'hunter2' };

describe('a page that wants an HTTP sign-in', () => {
  it("is asked about once: the page's other requests wait for the same answer", () => {
    const { auth, asked } = setup();
    const got: Array<Creds | null> = [];
    auth.challenge(site(), (c) => got.push(c));
    auth.challenge(site({ url: 'http://localhost:3000/app.js' }), (c) => got.push(c));
    auth.challenge(site({ url: 'http://localhost:3000/logo.png' }), (c) => got.push(c));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ host: 'localhost', port: 3000, realm: 'dev', failed: false, plain: false });
    expect(asked[0]).not.toHaveProperty('password');
    expect(auth.answer(asked[0].id, ME)).toBe(true);
    expect(got).toEqual([ME, ME, ME]);
    expect(auth.pending()).toEqual([]);
  });

  it('cancelled: the page gets nothing, and the next visit asks again', () => {
    const { auth, asked, tick } = setup();
    const got: Array<Creds | null> = [];
    auth.challenge(site(), (c) => got.push(c));
    auth.answer(asked[0].id, null);
    expect(got).toEqual([null]);
    tick(60_000);
    auth.challenge(site(), (c) => got.push(c));
    expect(asked).toHaveLength(2);
    expect(asked[1].failed).toBe(false);
  });

  it('an answer you asked it to keep is given again for that site (not for another), without asking', () => {
    const { auth, asked, tick } = setup();
    const got: Array<Creds | null> = [];
    auth.challenge(site(), (c) => got.push(c));
    auth.answer(asked[0].id, ME, true);
    tick(60_000);
    auth.challenge(site({ url: 'http://localhost:3000/later' }), (c) => got.push(c));
    expect(asked).toHaveLength(1);
    expect(got).toEqual([ME, ME]);
    auth.challenge(site({ port: 4000, url: 'http://localhost:4000/' }), (c) => got.push(c));
    auth.challenge(site({ realm: 'admin' }), (c) => got.push(c));
    expect(asked).toHaveLength(3);
  });

  it('one not kept is used once: the next visit asks', () => {
    const { auth, asked, tick } = setup();
    auth.challenge(site(), () => {});
    auth.answer(asked[0].id, ME);
    tick(60_000);
    auth.challenge(site(), () => {});
    expect(asked).toHaveLength(2);
  });

  it('a challenge straight back is the answer refused: what was kept goes, and you are asked again, told so', () => {
    const { auth, asked, tick } = setup();
    const got: Array<Creds | null> = [];
    auth.challenge(site(), (c) => got.push(c));
    auth.answer(asked[0].id, { username: 'dev', password: 'wrong' }, true);
    tick(300);
    auth.challenge(site(), (c) => got.push(c));
    auth.challenge(site({ url: 'http://localhost:3000/app.js' }), (c) => got.push(c));
    expect(asked).toHaveLength(2);
    expect(asked[1].failed).toBe(true);
    auth.answer(asked[1].id, ME, true);
    expect(got).toEqual([{ username: 'dev', password: 'wrong' }, ME, ME]);
    // and the right one is kept
    tick(60_000);
    auth.challenge(site(), (c) => got.push(c));
    expect(asked).toHaveLength(2);
    expect(got.at(-1)).toEqual(ME);
  });

  it('the window going away answers every open question with nothing', () => {
    const { auth } = setup();
    const got: Array<Creds | null> = [];
    auth.challenge(site(), (c) => got.push(c));
    auth.challenge(site({ host: 'other.test', url: 'https://other.test/' }), (c) => got.push(c));
    auth.cancelAll();
    expect(got).toEqual([null, null]);
    expect(auth.answer('auth1', ME)).toBe(false);
  });
});

describe('what the card is told', () => {
  it('a password that would cross the network readable: plain http to another machine (not this PC, not https, not a proxy)', () => {
    expect(plainText(site())).toBe(false);
    expect(plainText(site({ url: 'http://127.0.0.1:8080/' }))).toBe(false);
    expect(plainText(site({ host: 'staging.internal', url: 'http://staging.internal/' }))).toBe(true);
    expect(plainText(site({ host: 'staging.internal', url: 'https://staging.internal/' }))).toBe(false);
    expect(plainText(site({ proxy: true, host: 'proxy.corp', url: 'http://example.test/' }))).toBe(false);
  });
  it("a site is its host, port and realm; a proxy's sign-in is its own", () => {
    expect(siteKey(site({ host: 'LocalHost' }))).toBe(siteKey(site()));
    expect(siteKey(site({ proxy: true }))).not.toBe(siteKey(site()));
  });
});
