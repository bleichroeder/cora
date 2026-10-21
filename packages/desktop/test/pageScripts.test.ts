import { describe, expect, it } from 'vitest';
import { FILL_LOGIN_JS, HAS_LOGIN_FORM_JS, inPage } from '../src/pageScripts';

type Input = { type?: string; name?: string; id?: string; autocomplete?: string; placeholder?: string; hidden?: boolean; disabled?: boolean; value: string; events: string[] };
const input = (p: Partial<Input>): Input => ({ value: '', events: [], ...p });

/** A page of inputs, as much of the DOM as the scripts use. */
function page(inputs: Input[]) {
  const els = inputs.map((i) => ({
    get type() { return i.type ?? 'text'; },
    get name() { return i.name ?? ''; },
    get id() { return i.id ?? ''; },
    get placeholder() { return i.placeholder ?? ''; },
    get disabled() { return !!i.disabled; },
    get offsetWidth() { return i.hidden ? 0 : 200; },
    get offsetHeight() { return i.hidden ? 0 : 30; },
    getClientRects: () => (i.hidden ? [] : [{}]),
    getAttribute: (k: string) => (k === 'autocomplete' ? (i.autocomplete ?? null) : null),
    focus: () => {},
    set value(v: string) { i.value = v; },
    get value() { return i.value; },
    dispatchEvent: (e: Event) => (i.events.push(e.type), true),
  }));
  return { querySelectorAll: () => els };
}
const run = (body: string, doc: unknown, c?: unknown) => new Function('doc', 'c', body)(doc, c);

describe('in the page', () => {
  it('a login form is a visible password field', () => {
    expect(run(HAS_LOGIN_FORM_JS, page([input({ name: 'q' }), input({ type: 'password' })]))).toBe(true);
    expect(run(HAS_LOGIN_FORM_JS, page([input({ type: 'password', hidden: true }), input({ name: 'q' })]))).toBe(false);
  });

  it('fills the username, the password and the code, each with input and change', () => {
    const search = input({ name: 'search', placeholder: 'Search' });
    const user = input({ name: 'loginName', autocomplete: 'username' });
    const pw = input({ type: 'password', name: 'pass' });
    const otp = input({ name: 'totp', autocomplete: 'one-time-code' });
    const out = run(FILL_LOGIN_JS, page([search, user, pw, otp]), { username: 'svc-deploy', password: 's3cret!', totp: '123456' });
    expect(out).toEqual({ username: true, password: true, totp: true });
    expect([user.value, pw.value, otp.value, search.value]).toEqual(['svc-deploy', 's3cret!', '123456', '']);
    expect(pw.events).toEqual(['input', 'change']);
  });

  it('with nothing marked, the username is the text field nearest before the password', () => {
    const a = input({ name: 'f1' });
    const b = input({ name: 'f2' });
    const pw = input({ type: 'password' });
    run(FILL_LOGIN_JS, page([a, b, pw]), { username: 'u', password: 'p' });
    expect([a.value, b.value, pw.value]).toEqual(['', 'u', 'p']);
  });

  it('a page asking for the username first (no password yet) gets just that', () => {
    const email = input({ type: 'email', name: 'identifier' });
    expect(run(FILL_LOGIN_JS, page([email]), { username: 'me@acme.io', password: 'p' })).toEqual({ username: true, password: false, totp: false });
    expect(email.value).toBe('me@acme.io');
  });

  it('runs as page script text with its arguments', () => {
    expect(inPage(HAS_LOGIN_FORM_JS)).toMatch(/^\(function \(doc, c\) \{[\s\S]*\}\)\(document\)$/);
    expect(inPage(FILL_LOGIN_JS, { password: 'a"b' })).toContain('(document, {"password":"a\\"b"})');
  });
});
