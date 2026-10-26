import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_MAIL_RULES, addressAllowed, type GmailStatus, type MailHit, type MailRule, type MailWatch } from '@cora/shared';
import { authentic, type MailWatches } from './mailWatches';
import { writeFileAtomic } from './fsx';
import { readSecret, writeSecret } from './secrets';

/**
 * Gmail for Cora, through the user's own Google app (a "Desktop app" OAuth client in their Google Cloud project: the
 * JSON at ~/.cora/google-client.json). Sign-in is Google's, in their browser, back to Cora's local address (PKCE).
 * The refresh token stays in ~/.cora/gmail.json. Cora reads mail and writes drafts; it never sends on its own.
 */

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'];
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
/** A sign-in started in the browser must come back within this. */
const PENDING_MS = 10 * 60_000;
/** How often Cora looks for new mail; more often while an email is being waited for. */
export const MAIL_POLL_MS = 60_000;
export const MAIL_WATCH_POLL_MS = 30_000;

/** An email as read in full. */
export type Mail = MailHit & { cc: string; body: string; messageId: string; references: string; replyTo: string; auth: string };
/** Gmail's tabs that aren't for the user: never "important" here, whatever Gmail thinks. */
const NOT_FOR_YOU = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];
const MAX_BODY = 12_000;

export type GoogleClient = { clientId: string; clientSecret: string; projectId?: string; authUri: string; tokenUri: string };
type Stored = { refresh: string; email: string; historyId?: string; watch?: boolean; rules?: MailRule[]; important?: boolean; drafts?: boolean; draftTo?: string[]; send?: boolean };
/** What the user set: what Cora watches for, and who its drafts may go to. */
export type MailConfig = { rules?: MailRule[]; important?: boolean; drafts?: boolean; draftTo?: string[]; send?: boolean };

export class GmailError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

/** The Google app's JSON (from the Cloud console): a Desktop app's, or why it won't do. */
export function parseClient(text: string): GoogleClient | { error: string } {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    return { error: "That isn't the JSON file from Google (it doesn't parse)." };
  }
  if (j?.web && !j?.installed) return { error: 'That is a "Web application" client. Cora needs a "Desktop app" client: create one under Clients and download its JSON.' };
  const c = j?.installed;
  if (!c?.client_id || !c?.client_secret) return { error: "That JSON has no Desktop app client in it (no installed.client_id)." };
  // Google's own sign-in addresses, whatever the file says: the code, the secret and the refresh token go only to Google
  // (a doctored file could send them anywhere: docs/audit-2026-10-20.md S16)
  return { clientId: String(c.client_id), clientSecret: String(c.client_secret), ...(c.project_id ? { projectId: String(c.project_id) } : {}), authUri: GOOGLE_AUTH, tokenUri: GOOGLE_TOKEN };
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
/** A header value without line breaks (no header of its own can be smuggled in). */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
/** A header in UTF-8 when it needs to be (RFC 2047). */
const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

type Header = { name: string; value: string };
const header = (hs: Header[] | undefined, name: string) => hs?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
/** "Ana Ruiz <ana@x.com>" → the address. */
export const addressOf = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

/** A message's text: its plain part (or its HTML, flattened). */
export function bodyText(payload: any): string {
  const parts: any[] = [];
  const walk = (p: any) => {
    if (!p) return;
    parts.push(p);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data);
  if (plain) return unb64(plain.body.data);
  const html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data);
  if (!html) return '';
  return unb64(html.body.data)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** A message as a hit (from its metadata). */
export function hitOf(m: any): MailHit {
  const hs: Header[] = m.payload?.headers ?? [];
  const labels: string[] = m.labelIds ?? [];
  return {
    id: String(m.id),
    threadId: String(m.threadId ?? m.id),
    from: header(hs, 'From'),
    to: header(hs, 'To'),
    subject: header(hs, 'Subject') || '(no subject)',
    at: Number(m.internalDate) || Date.parse(header(hs, 'Date')) || 0,
    snippet: String(m.snippet ?? '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
    labels,
    unread: labels.includes('UNREAD'),
    important: labels.includes('IMPORTANT'),
  };
}

/** New mail worth telling the user about: unread, in the inbox, Gmail calls it important, not a promotions-like tab, not their own. */
export function worthTelling(h: MailHit, me: string): boolean {
  return h.labels.includes('INBOX') && h.unread && h.important && !h.labels.some((l) => NOT_FOR_YOU.includes(l)) && addressOf(h.from) !== me.toLowerCase();
}

/** One line for a hit: `[when] From · "Subject": snippet (id)`. */
export function mailLine(h: MailHit, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - h.at) / 60_000));
  const when = mins < 60 ? `${mins}m ago` : mins < 48 * 60 ? `${Math.round(mins / 60)}h ago` : new Date(h.at).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const snip = h.snippet.length > 160 ? `${h.snippet.slice(0, 159)}…` : h.snippet;
  return `[${when}] ${oneLine(h.from)} · "${oneLine(h.subject)}"${h.unread ? ' (unread)' : ''}${h.why ? ` [${oneLine(h.why)}]` : ''}: ${oneLine(snip)} (id ${h.id})`;
}

/** The raw RFC 2822 message for a draft. */
export function mime(d: { to: string; cc?: string; subject: string; body: string; inReplyTo?: string; references?: string }): string {
  const lines = [
    `To: ${oneLine(d.to)}`,
    ...(d.cc?.trim() ? [`Cc: ${oneLine(d.cc)}`] : []),
    `Subject: ${encWord(oneLine(d.subject))}`,
    ...(d.inReplyTo ? [`In-Reply-To: ${oneLine(d.inReplyTo)}`, `References: ${oneLine(`${d.references ?? ''} ${d.inReplyTo}`)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    (Buffer.from(d.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'),
  ];
  return lines.join('\r\n');
}

/** A Gmail search for what Cora watches for: the rules (any of them), Gmail's important if on; important when nothing is set. */
export function watchQuery(s: Pick<Stored, 'rules' | 'important'> | null): string {
  const imp = 'is:important -category:promotions -category:social -category:updates -category:forums';
  const parts = [...(s?.rules ?? []).map((r) => `(${r.query})`), ...(s?.important ? [`(${imp})`] : [])];
  return parts.length ? (parts.length === 1 ? parts[0] : `{${parts.join(' ')}}`) : imp;
}

/** The rules and the allowed recipients, checked (or why not). */
export function checkConfig(c: MailConfig): MailConfig {
  const out: MailConfig = {};
  if (c.rules !== undefined) {
    if (!Array.isArray(c.rules) || c.rules.length > MAX_MAIL_RULES) throw new GmailError('bad_config', `At most ${MAX_MAIL_RULES} things to watch for.`);
    out.rules = c.rules.map((r, i) => {
      const label = oneLine(String(r?.label ?? '')).slice(0, 40);
      const query = oneLine(String(r?.query ?? '')).slice(0, 300);
      if (!query) throw new GmailError('bad_config', 'Each thing to watch for needs a Gmail search.');
      return { id: String(r?.id ?? '').slice(0, 40) || `r${Date.now().toString(36)}${i}`, label: label || query.slice(0, 40), query };
    });
  }
  if (c.important !== undefined) out.important = !!c.important;
  if (c.drafts !== undefined) out.drafts = !!c.drafts;
  if (c.send !== undefined) out.send = !!c.send;
  if (c.draftTo !== undefined) {
    if (!Array.isArray(c.draftTo) || c.draftTo.length > 50) throw new GmailError('bad_config', 'At most 50 addresses or domains.');
    out.draftTo = c.draftTo.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    const bad = out.draftTo.find((x) => !/^@?[\w.+-]+(@[\w-]+(\.[\w-]+)+)?$/.test(x) || (!x.includes('@') && !x.includes('.')));
    if (bad) throw new GmailError('bad_config', `"${bad}" isn't an address or a domain (like ana@example.com or @example.com).`);
  }
  return out;
}

export class Gmail {
  private pending = new Map<string, { verifier: string; redirect: string; at: number }>();
  private access: { token: string; until: number } | null = null;
  private stored: Stored | null = null;
  /** what you set before disconnecting (a reconnect keeps it) */
  private kept: Stored | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastError: string | undefined;
  private lastCheck: number | undefined;
  private checking = false;

  constructor(private o: { dataDir: string; fetchFn?: typeof fetch; now?: () => number; onMail?: (hits: MailHit[]) => void; onChange?: () => void; log?: (m: string) => void; watches?: MailWatches; onWatch?: (w: MailWatch, mail: Mail, trust: { ok: boolean; why?: string }) => void }) {
    try {
      this.stored = JSON.parse(readSecret(this.tokenPath));
    } catch {
      this.stored = null;
    }
  }

  private get clientPath() {
    return join(this.o.dataDir, 'google-client.json');
  }
  private get tokenPath() {
    return join(this.o.dataDir, 'gmail.json');
  }
  private now = () => this.o.now?.() ?? Date.now();
  private get fetch() {
    return this.o.fetchFn ?? fetch;
  }

  /** The user's Google app (null: not set up yet, or not a Desktop app). */
  client(): GoogleClient | null {
    try {
      const c = parseClient(readSecret(this.clientPath));
      return 'error' in c ? null : c;
    } catch {
      return null;
    }
  }

  /** Settings: the Google app's JSON, pasted. */
  setClient(text: string): GoogleClient {
    const c = parseClient(text);
    if ('error' in c) throw new GmailError('bad_client', c.error);
    writeSecret(this.clientPath, text.trim() + '\n');
    this.o.onChange?.();
    return c;
  }

  status(): GmailStatus {
    const c = this.client();
    return {
      client: !!c,
      ...(c?.projectId ? { project: c.projectId } : {}),
      connected: !!this.stored,
      ...(this.stored ? { email: this.stored.email } : {}),
      watch: this.stored?.watch !== false,
      rules: this.stored?.rules ?? [],
      important: !!this.stored?.important,
      drafts: !!this.stored?.drafts,
      draftTo: this.stored?.draftTo ?? [],
      send: !!this.stored?.send,
      watches: this.o.watches?.list() ?? [],
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(this.lastCheck ? { lastCheck: this.lastCheck } : {}),
    };
  }
  connected = () => !!this.stored;
  email = () => this.stored?.email ?? null;

  /** Google's sign-in page for this app, coming back to `redirect` (Cora's local address). */
  authUrl(redirect: string): string {
    const c = this.client();
    if (!c) throw new GmailError('no_client', "Cora doesn't have your Google app yet (Settings → Gmail).");
    const now = this.now();
    for (const [k, p] of this.pending) if (now - p.at > PENDING_MS) this.pending.delete(k);
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    this.pending.set(state, { verifier, redirect, at: now });
    const q = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: GMAIL_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    });
    return `${c.authUri}?${q}`;
  }

  /** Google sent the browser back: the code becomes a refresh token (once per sign-in; anything else is refused). */
  async finish(state: string, code: string): Promise<string> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || this.now() - p.at > PENDING_MS) throw new GmailError('bad_state', 'That sign-in is unknown or too old: start it again from Settings → Gmail.');
    const c = this.client();
    if (!c) throw new GmailError('no_client');
    const r = await this.fetch(c.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: p.redirect, grant_type: 'authorization_code', code_verifier: p.verifier }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new GmailError('token', `Google refused the sign-in: ${j.error_description ?? j.error ?? r.status}`);
    if (!j.refresh_token) throw new GmailError('no_refresh', "Google didn't give Cora a lasting sign-in. Remove Cora at myaccount.google.com/permissions and connect again.");
    this.access = { token: j.access_token, until: this.now() + (Number(j.expires_in) || 3600) * 1000 - 60_000 };
    const granted = String(j.scope ?? '');
    if (granted && !granted.includes('gmail.readonly')) throw new GmailError('scope', 'Cora needs permission to read your mail: tick it on the sign-in page.');
    const prof: any = await this.apiWith(j.access_token, '/profile');
    const keep = this.stored ?? this.kept;
    this.stored = { refresh: j.refresh_token, email: String(prof.emailAddress ?? ''), historyId: String(prof.historyId ?? ''), watch: keep?.watch, rules: keep?.rules, important: keep?.important, drafts: keep?.drafts, draftTo: keep?.draftTo, send: keep?.send };
    this.save();
    this.lastError = undefined;
    this.o.onChange?.();
    return this.stored.email;
  }

  /** Disconnect: Google forgets Cora's access, and so does Cora. */
  async disconnect(): Promise<void> {
    const s = this.stored;
    this.kept = s;
    this.stored = null;
    this.access = null;
    this.stop();
    try {
      rmSync(this.tokenPath, { force: true });
    } catch {}
    if (s) await this.fetch(`${REVOKE}?token=${encodeURIComponent(s.refresh)}`, { method: 'POST' }).catch(() => {});
    this.o.onChange?.();
  }

  setWatch(on: boolean): void {
    if (!this.stored) return;
    this.stored.watch = on;
    this.save();
    // the check keeps running either way: email watches don't depend on this (it's for the rules)
    this.start();
    this.o.onChange?.();
  }

  /** What Cora watches for, and who its drafts may go to. */
  setConfig(c: MailConfig): void {
    if (!this.stored) throw new GmailError('not_connected', "Gmail isn't connected to Cora (Settings → Gmail).");
    Object.assign(this.stored, checkConfig(c));
    this.save();
    this.o.onChange?.();
  }
  /** Is anything being watched for? */
  watching(): boolean {
    return !!this.stored && this.stored.watch !== false && (!!this.stored.rules?.length || !!this.stored.important);
  }

  private save(): void {
    if (this.stored) writeSecret(this.tokenPath, JSON.stringify(this.stored, null, 2) + '\n');
  }

  private async token(): Promise<string> {
    if (this.access && this.access.until > this.now()) return this.access.token;
    const c = this.client();
    if (!this.stored) throw new GmailError('not_connected', "Gmail isn't connected to Cora (Settings → Gmail).");
    if (!c) throw new GmailError('no_client', "Cora's Google app is missing (Settings → Gmail).");
    const r = await this.fetch(c.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: this.stored.refresh, grant_type: 'refresh_token' }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      const why = j.error === 'invalid_grant' ? 'Google ended Cora\'s sign-in: connect Gmail again in Settings → Gmail.' : `Google: ${j.error_description ?? j.error ?? r.status}`;
      this.lastError = why;
      this.o.onChange?.();
      throw new GmailError(j.error === 'invalid_grant' ? 'signed_out' : 'token', why);
    }
    this.access = { token: j.access_token, until: this.now() + (Number(j.expires_in) || 3600) * 1000 - 60_000 };
    return j.access_token;
  }

  private async apiWith(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<any> {
    const r = await this.fetch(`${API}${path}`, {
      method: init?.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new GmailError(String(r.status), `Gmail: ${j.error?.message ?? r.status}`);
    return j;
  }
  private async api(path: string, init?: { method?: string; body?: unknown }): Promise<any> {
    try {
      return await this.apiWith(await this.token(), path, init);
    } catch (e) {
      // a token Google stopped taking early: once more with a fresh one
      if (e instanceof GmailError && e.code === '401') {
        this.access = null;
        return this.apiWith(await this.token(), path, init);
      }
      throw e;
    }
  }

  private async meta(id: string): Promise<MailHit> {
    return hitOf(await this.api(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`));
  }

  /** Gmail's own search (from:, subject:, is:unread, newer_than:2d …), newest first. */
  async search(q: string, max = 10): Promise<MailHit[]> {
    const r = await this.api(`/messages?${new URLSearchParams({ q, maxResults: String(Math.min(25, Math.max(1, max))) })}`);
    return Promise.all(((r.messages ?? []) as Array<{ id: string }>).map((m) => this.meta(m.id)));
  }

  /** What Cora watches for (the rules, Gmail's important if on), in the inbox since a time; Gmail's important when nothing is set. */
  inbox(since: number): Promise<MailHit[]> {
    return this.search(`in:inbox after:${Math.floor(since / 1000)} ${watchQuery(this.stored)}`, 20);
  }

  /** One message: who, when, what it says. */
  async read(id: string): Promise<Mail> {
    const m = await this.api(`/messages/${encodeURIComponent(id)}?format=full`);
    const hs: Header[] = m.payload?.headers ?? [];
    const body = bodyText(m.payload);
    return { ...hitOf(m), cc: header(hs, 'Cc'), body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n…(cut)` : body, messageId: header(hs, 'Message-ID') || header(hs, 'Message-Id'), references: header(hs, 'References'), replyTo: header(hs, 'Reply-To'), auth: header(hs, 'Authentication-Results') };
  }

  /** A draft in the user's Gmail (a reply goes in its thread). Never sent: the user sends it. */
  /**
   * A draft in the user's Gmail. `byUser`: they wrote it themselves (the Inbox's reply), so Cora's own limits on drafts
   * (whether it may write any, and to whom) don't apply (audit B12).
   */
  async draft(d: { to?: string; cc?: string; subject?: string; body: string; replyTo?: string; byUser?: boolean }): Promise<{ id: string; messageId: string; link: string; to: string; subject: string; threadId?: string; inReplyTo?: string; references?: string }> {
    if (!d.byUser && !this.stored?.drafts) throw new GmailError('drafts_off', "The user hasn't let Cora write email drafts (Settings → Gmail → Drafts is off). Tell them; don't try again.");
    let to = d.to?.trim() ?? '';
    let subject = d.subject?.trim() ?? '';
    let threadId: string | undefined;
    let inReplyTo: string | undefined;
    let references: string | undefined;
    if (d.replyTo) {
      const o = await this.read(d.replyTo);
      threadId = o.threadId;
      inReplyTo = o.messageId || undefined;
      references = o.references || undefined;
      to ||= o.replyTo || o.from;
      subject ||= /^re:/i.test(o.subject) ? o.subject : `Re: ${o.subject}`;
    }
    if (!to) throw new GmailError('no_to', 'A draft needs someone to send it to (to), or a message to reply to (reply_to).');
    const allowed = this.stored?.draftTo ?? [];
    const blocked = d.byUser ? [] : [to, d.cc ?? ''].join(',').split(',').map(addressOf).filter((a) => a && !addressAllowed(a, allowed));
    if (blocked.length) throw new GmailError('not_allowed', `The user only lets Cora write to ${allowed.join(', ')} (Settings → Gmail), so no draft to ${blocked.join(', ')}. Tell them.`);
    if (!subject) throw new GmailError('no_subject', 'A new email needs a subject.');
    const raw = b64url(Buffer.from(mime({ to, ...(d.cc ? { cc: d.cc } : {}), subject, body: d.body, ...(inReplyTo ? { inReplyTo } : {}), ...(references ? { references } : {}) }), 'utf8'));
    const r = await this.api('/drafts', { method: 'POST', body: { message: { raw, ...(threadId ? { threadId } : {}) } } });
    const messageId = String(r.message?.id ?? '');
    const thread = String(r.message?.threadId ?? '');
    // the account's first slot (/u/0): Google turns away a link naming the account in its path ("account temporarily
    // unavailable") in Cora's browser (Settings > Tools > Gmail opens as picks the profile signed in to it). The draft by
    // its conversation: Gmail's ?compose= wants an id of its own, not the API's (it only opened the Drafts folder)
    return { id: String(r.id), messageId, link: `https://mail.google.com/mail/u/0/#drafts${/^[0-9a-f]+$/i.test(thread) ? `/${thread}` : ''}`, to, subject, ...(thread ? { threadId: thread } : {}), ...(inReplyTo ? { inReplyTo } : {}), ...(references ? { references } : {}) };
  }

  /** May sessions ask for an email to be sent (Settings → Gmail)? It still waits for the user's Send. */
  sendAllowed(): boolean {
    return !!this.stored?.send;
  }

  /** Send a draft (the user said Send, in Cora's outbox). */
  async sendDraft(id: string): Promise<{ id: string; threadId: string }> {
    const r = await this.api('/drafts/send', { method: 'POST', body: { id } });
    return { id: String(r.id ?? ''), threadId: String(r.threadId ?? '') };
  }

  /** A draft as the user changed it (in Cora's outbox, before sending): same thread, same reply headers. */
  async updateDraft(id: string, d: { to: string; cc?: string; subject: string; body: string; threadId?: string; inReplyTo?: string; references?: string }): Promise<void> {
    const raw = b64url(Buffer.from(mime({ to: d.to, ...(d.cc ? { cc: d.cc } : {}), subject: d.subject, body: d.body, ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}), ...(d.references ? { references: d.references } : {}) }), 'utf8'));
    await this.api(`/drafts/${encodeURIComponent(id)}`, { method: 'PUT', body: { id, message: { raw, ...(d.threadId ? { threadId: d.threadId } : {}) } } });
  }

  /** Delete a draft (the user discarded the email). */
  async deleteDraft(id: string): Promise<void> {
    await this.api(`/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /**
   * Email watches: of what just arrived, what a watch waits for (its thread; or its search, from its sender), each
   * checked for really coming from that sender before anything is done with it.
   */
  private async checkWatches(added: Map<string, string>, me: string): Promise<void> {
    const ws = this.o.watches!;
    const myDomain = me.split('@')[1] ?? '';
    for (const w of ws.list()) {
      let ids: string[];
      if (w.thread) ids = [...added].filter(([, t]) => t === w.thread).map(([id]) => id);
      else {
        const found = await this.api(`/messages?${new URLSearchParams({ q: `in:inbox newer_than:2d from:(${w.from.replace(/^@/, '')}) ${w.query ?? ''}`, maxResults: '20' })}`).catch(() => null);
        ids = ((found?.messages ?? []) as Array<{ id: string }>).map((m) => m.id).filter((id) => added.has(id));
      }
      for (const id of ids) {
        const m = await this.read(id).catch(() => null);
        if (!m || addressOf(m.from) === me.toLowerCase()) continue;
        const trust = authentic(m.from, m.auth, w.from, myDomain);
        this.o.onWatch?.(w, m, trust);
        if (!trust.ok) continue;
        ws.hit(w.id, m.threadId);
        if (w.mode === 'once') break;
      }
    }
  }

  // ---------------------------------------------------------------- watching for important mail
  /** Look for new mail now and then: for the rules (when watching is on) and for email watches (always). */
  start(): void {
    if (this.timer || !this.stored) return;
    const next = (ms: number) => {
      this.timer = setTimeout(async () => {
        await this.check();
        if (this.timer) next(this.o.watches?.any() ? MAIL_WATCH_POLL_MS : MAIL_POLL_MS);
      }, ms);
    };
    next(5000);
  }
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** What's new since the last look (Gmail's history), and of that what's worth telling. */
  async check(): Promise<MailHit[]> {
    const s = this.stored;
    if (!s || this.checking) return [];
    this.checking = true;
    try {
      if (!s.historyId) {
        s.historyId = String((await this.api('/profile')).historyId ?? '');
        this.save();
        return [];
      }
      let r: any;
      try {
        r = await this.api(`/history?${new URLSearchParams({ startHistoryId: s.historyId, historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: '100' })}`);
      } catch (e) {
        // too old (Gmail keeps about a week): start again from now
        if (e instanceof GmailError && e.code === '404') {
          s.historyId = String((await this.api('/profile')).historyId ?? '');
          this.save();
          return [];
        }
        throw e;
      }
      const added = new Map<string, string>();
      for (const h of (r.history ?? []) as any[]) for (const a of h.messagesAdded ?? []) if (a.message?.id) added.set(String(a.message.id), String(a.message.threadId ?? a.message.id));
      const ids = [...added.keys()];
      if (r.historyId) s.historyId = String(r.historyId);
      this.save();
      this.lastCheck = this.now();
      if (this.lastError) (this.lastError = undefined), this.o.onChange?.();
      if (ids.length && this.o.watches?.any()) await this.checkWatches(added, s.email);
      if (!ids.length || !this.watching() || s.watch === false) return [];
      const fresh = new Set(ids);
      const why = new Map<string, string>();
      // each rule: Gmail's own search over the last day, kept to what just arrived
      for (const r of s.rules ?? []) {
        const found = await this.api(`/messages?${new URLSearchParams({ q: `in:inbox newer_than:1d (${r.query})`, maxResults: '50' })}`).catch(() => null);
        for (const m of (found?.messages ?? []) as Array<{ id: string }>) if (fresh.has(m.id) && !why.has(m.id)) why.set(m.id, r.label);
      }
      const look = s.important ? ids.slice(-30) : [...why.keys()];
      const hits = (await Promise.all(look.map((id) => this.meta(id).catch(() => null)))).filter((h): h is MailHit => !!h);
      const worth = hits
        .map((h): MailHit | null => (why.has(h.id) ? { ...h, why: why.get(h.id)! } : s.important && worthTelling(h, s.email) ? { ...h, why: 'important' } : null))
        .filter((h): h is MailHit => !!h && addressOf(h.from) !== s.email.toLowerCase());
      if (worth.length) this.o.onMail?.(worth);
      return worth;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== this.lastError) this.o.log?.(`gmail: ${msg}`);
      this.lastError = msg;
      this.o.onChange?.();
      return [];
    } finally {
      this.checking = false;
    }
  }
}
