/**
 * What Cora runs inside a web page (in its isolated world: the page can't see or touch it) for 1Password: is there a
 * login form, and filling one. Plain script text, so the bundler can't add anything the page wouldn't have; the same
 * text is tested against a fake page.
 */

/** Shared: visible, enabled inputs, in the page's order. */
const INPUTS = `
  var visible = function (el) {
    return !el.disabled && String(el.type || '').toLowerCase() !== 'hidden' && !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));
  };
  var inputs = Array.prototype.slice.call(doc.querySelectorAll('input')).filter(visible);
  var kind = function (el) { return String(el.type || 'text').toLowerCase(); };
  var said = function (el) { return [el.name, el.id, el.getAttribute && el.getAttribute('autocomplete'), el.placeholder, el.getAttribute && el.getAttribute('aria-label')].join(' ').toLowerCase(); };
`;

/** Body of `(doc) => boolean`: a visible password field. */
export const HAS_LOGIN_FORM_JS = `${INPUTS}
  return inputs.some(function (el) { return kind(el) === 'password'; });
`;

/**
 * Body of `(doc, c) => { username, password, totp }`: fill what the page has. The username field: one marked for it
 * (autocomplete username/email, or named user/email/login), else the nearest text field before the password; the
 * one-time code: one marked one-time-code or named otp/code/2fa. Each gets `input` and `change` (React forms see them:
 * from the isolated world the value goes in through the browser's own setter, around React's).
 */
export const FILL_LOGIN_JS = `${INPUTS}
  var set = function (el, v) {
    try { el.focus && el.focus(); } catch (e) {}
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  var out = { username: false, password: false, totp: false };
  var pw = inputs.filter(function (el) { return kind(el) === 'password'; })[0];
  var otp = inputs.filter(function (el) {
    return el !== pw && (/one-time-code/.test(said(el)) || /(^|[^a-z])(otp|totp|2fa|mfa|one.?time|verification|passcode|code)([^a-z]|$)/.test(said(el)));
  })[0];
  var texts = inputs.filter(function (el) { return ['text', 'email', 'tel'].indexOf(kind(el)) >= 0 && el !== otp; });
  var user = texts.filter(function (el) { return /username|email/.test(String(el.getAttribute && el.getAttribute('autocomplete'))); })[0]
    || texts.filter(function (el) { return /user|e-?mail|login|account/.test(said(el)); })[0]
    || (pw ? texts.filter(function (el) { return inputs.indexOf(el) < inputs.indexOf(pw); }).pop() : texts.length === 1 ? texts[0] : undefined);
  if (c.username && user) { set(user, c.username); out.username = true; }
  if (c.password && pw) { set(pw, c.password); out.password = true; }
  if (c.totp && otp) { set(otp, c.totp); out.totp = true; }
  return out;
`;

/** Script text that runs `body` in the page (`doc` is its document) with these arguments. */
export const inPage = (body: string, ...args: unknown[]) => `(function (doc, c) {${body}})(document${args.map((a) => `, ${JSON.stringify(a)}`).join('')})`;

/**
 * Body of `(doc, nonce) => void`: the key in the page's own login fields. When a password field (or the username field
 * of a page that has one) is focused, a small key shows at its right edge; clicking it asks for 1Password's menu
 * there. Focus and blur are told too (the menu can suggest logins at the field). It talks to Cora through the console,
 * each line marked with this page's nonce (made in Cora, known only to this isolated world: the page can't fake one);
 * the key lives in a closed shadow root. Installed once per document.
 */
export const FIELD_KEY_JS = `
  if (window.__coraOpKey) return;
  window.__coraOpKey = true;
  var say = function (m) { try { console.debug(c + JSON.stringify(m)); } catch (e) {} };
  var kind = function (el) { return String(el.type || 'text').toLowerCase(); };
  var said = function (el) { return [el.name, el.id, el.getAttribute && el.getAttribute('autocomplete'), el.placeholder, el.getAttribute && el.getAttribute('aria-label')].join(' ').toLowerCase(); };
  var hasPassword = function () { return !!doc.querySelector('input[type="password" i]'); };
  var isLogin = function (el) {
    if (!el || el.tagName !== 'INPUT' || el.disabled || el.readOnly) return false;
    if (kind(el) === 'password') return true;
    if (['text', 'email', 'tel', ''].indexOf(kind(el)) < 0) return false;
    return hasPassword() && (/username|email/.test(String(el.getAttribute('autocomplete'))) || /user|e-?mail|login|account/.test(said(el)));
  };
  var rectOf = function (el) { var r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  var host = doc.createElement('cora-op-key');
  var root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>button{all:initial;position:fixed;z-index:2147483647;display:none;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;cursor:pointer;background:#1b2130;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14),0 2px 6px rgba(0,0,0,.35);color:#dbe4ff}button:hover{background:#26304a;color:#fff}svg{width:13px;height:13px}</style>'
    + '<button title="1Password (Ctrl+\\\\)" aria-label="Fill from 1Password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg></button>';
  var btn = root.querySelector('button');
  var cur = null;
  var place = function () {
    if (!cur || !cur.isConnected) { btn.style.display = 'none'; return; }
    var r = cur.getBoundingClientRect();
    if (!r.width || !r.height) { btn.style.display = 'none'; return; }
    btn.style.left = Math.round(r.right - 22 - Math.min(6, (r.height - 22) / 2 + 2)) + 'px';
    btn.style.top = Math.round(r.top + (r.height - 22) / 2) + 'px';
    btn.style.display = 'flex';
  };
  var take = function (el) {
    cur = el;
    if (!host.isConnected) (doc.body || doc.documentElement).appendChild(host);
    place();
    say({ k: 'focus', r: rectOf(el) });
  };
  doc.addEventListener('focusin', function (e) { if (isLogin(e.target)) take(e.target); }, true);
  doc.addEventListener('focusout', function (e) {
    if (e.target !== cur) return;
    setTimeout(function () { if (doc.activeElement !== cur) { cur = null; place(); say({ k: 'blur' }); } }, 150);
  }, true);
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);
  btn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
  btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (cur) say({ k: 'open', r: rectOf(cur) }); }, true);
  if (isLogin(doc.activeElement)) take(doc.activeElement);
`;
