import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseSlackLink, rankByName, slackWebUrl, toMrkdwn, type SlackAction, type SlackDraft, type SlackStatus, type SlackTarget, UNDO_MS, type SlackSent, type SlackGrant, type SlackAttachment } from '@cora/shared';
import { writeFileAtomic } from './fsx';
import { readSecret, writeSecret } from './secrets';

/**
 * Slack as you: your own Slack app's user token (pasted once in Settings, kept in the data folder), looking people
 * and channels up, reading a conversation, and posting. Sessions never post directly: their messages wait in the
 * Outbox until you send, change or discard them in the dashboard.
 */

/** The user scopes Cora's Slack app asks for (see slackManifest). */
export const SLACK_SCOPES = [
  'chat:write',
  'users:read',
  'users:read.email',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'im:write',
  'mpim:write',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  // what's waiting for you (DMs and mentions) in Cora's briefs
  'search:read',
  // files on messages: reading them (a screenshot someone posted) and sending them (a session's attachments)
  'files:read',
  'files:write',
];

/** Message events Cora's live connection hears (on your behalf: what you can see), for threads sessions watch. */
export const SLACK_USER_EVENTS = ['message.channels', 'message.groups', 'message.im', 'message.mpim'];

/** Cora's own bot: it DMs you as itself (its messages ping, its buttons answer prompts) and hears what you write it. */
export const SLACK_BOT_SCOPES = ['chat:write', 'im:history', 'im:read', 'im:write', 'reactions:write'];
export const SLACK_BOT_EVENTS = ['message.im'];

/**
 * The app to create at api.slack.com/apps ("From a manifest"): your user scopes (Cora as you), and a bot user (Cora
 * as itself). Socket Mode on, with your message events and the bot's DMs, and interactivity (its buttons), for live
 * replies (that also needs an app-level token: Basic Information → App-Level Tokens).
 */
export function slackManifest(): object {
  return {
    display_information: { name: 'Cora', description: 'Lets Cora (your Claude Code dashboard) work with Slack as you (messages it drafts are sent when you confirm), and as itself: it DMs you while you are away, with buttons to answer prompts, and takes instructions in that DM.' },
    features: { bot_user: { display_name: 'Cora', always_online: true }, app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false } },
    oauth_config: { scopes: { user: SLACK_SCOPES, bot: SLACK_BOT_SCOPES } },
    settings: { event_subscriptions: { user_events: SLACK_USER_EVENTS, bot_events: SLACK_BOT_EVENTS }, interactivity: { is_enabled: true }, org_deploy_enabled: false, socket_mode_enabled: true, token_rotation_enabled: false },
  };
}

/** Text as a Slack quote: every line, the blank ones too (so its bar runs unbroken). */
export const quoted = (text: string) =>
  text
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');

type Block = Record<string, unknown>;
const MAX_BLOCKS = 45;
const FIELD_RE = /^\s*(?:[-*•]\s+)?\*\*([^*\n]{1,60}?):?\*\*:?\s+(\S.*)$/;

/**
 * A message laid out in Slack's own blocks, from its markdown, for a structured message (a report, a rundown, release
 * notes): `# Title` (or `##`) a header, `---` a divider, two or more `**Label:** value` lines in a row a grid of facts
 * (two columns), `-# note` small grey text; the rest as it is. Code blocks are left alone. Null when there's no such
 * structure (an ordinary message: sections, as ever) or when it would take more blocks than Slack allows.
 */
export function richBlocks(md: string): Block[] | null {
  const lines = md.split('\n');
  const out: Block[] = [];
  let text: string[] = [];
  let rich = false;
  let fence = false;
  const flush = () => {
    const t = text.join('\n').replace(/^\n+|\n+$/g, '');
    if (t.trim()) out.push(...sections(toMrkdwn(t)));
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) fence = !fence;
    if (fence || /^\s*```/.test(l)) {
      text.push(l);
      continue;
    }
    const h = /^#{1,2}\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) {
      flush();
      out.push({ type: 'header', text: { type: 'plain_text', text: plainText(h[1]).slice(0, 150) || ' ', emoji: true } });
      rich = true;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) {
      flush();
      out.push({ type: 'divider' });
      rich = true;
      continue;
    }
    const note = /^-#\s+(.+)$/.exec(l);
    if (note) {
      flush();
      out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: toMrkdwn(note[1]).slice(0, 3000) }] });
      rich = true;
      continue;
    }
    // facts: two or more label lines in a row
    let j = i;
    while (j < lines.length && FIELD_RE.test(lines[j])) j++;
    if (j - i >= 2) {
      flush();
      const fields = lines.slice(i, j).map((x) => {
        const m = FIELD_RE.exec(x)!;
        return { type: 'mrkdwn', text: `*${m[1].trim()}*\n${toMrkdwn(m[2])}`.slice(0, 2000) };
      });
      for (let k = 0; k < fields.length; k += 10) out.push({ type: 'section', fields: fields.slice(k, k + 10) });
      rich = true;
      i = j - 1;
      continue;
    }
    text.push(l);
  }
  flush();
  return rich && out.length <= MAX_BLOCKS ? out : null;
}

/** Markdown as plain words (a header takes no formatting). */
const plainText = (s: string) =>
  s
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/<[^|>]+\|([^>]+)>/g, '$1')
    .replace(/[*_~`]/g, '')
    .trim();

/** A message's text as section blocks: Slack takes at most 3000 characters a section. */
export function sections(text: string): Array<{ type: 'section'; text: { type: 'mrkdwn'; text: string } }> {
  const out: string[] = [];
  let rest = text;
  while (rest.length > 2900) {
    // between paragraphs where it can, else between lines, else where it must
    const para = rest.lastIndexOf('\n\n', 2900);
    const line = rest.lastIndexOf('\n', 2900);
    const at = para > 1000 ? para : line > 1000 ? line : 2900;
    out.push(rest.slice(0, at).replace(/\n+$/, ''));
    rest = rest.slice(at).replace(/^\n+/, '');
  }
  if (rest.trim()) out.push(rest);
  return out.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } }));
}

export class SlackError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export type SlackApi = (method: string, params?: Record<string, unknown>) => Promise<any>;

/** A Slack Web API caller for a token (form-encoded POSTs; one wait-and-retry when rate-limited). */
export function slackApi(token: string, base = process.env.CORA_SLACK_API ?? 'https://slack.com/api', fetchFn: typeof fetch = fetch): SlackApi {
  return async (method, params = {}) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
      if (token) headers.authorization = `Bearer ${token}`;
      const r = await fetchFn(`${base}/${method}`, { method: 'POST', headers, body });
      if (r.status === 429 && attempt === 0) {
        const wait = Math.min(10, Number(r.headers.get('retry-after') ?? 1)) * 1000;
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      const j = (await r.json().catch(() => ({ ok: false, error: `http_${r.status}` }))) as any;
      if (!j.ok) throw new SlackError(String(j.error ?? 'unknown_error'));
      return j;
    }
  };
}

/** A file on a Slack message (an image Claude can be shown, or any other kind it's only told about). */
export type SlackFile = { name: string; mimetype: string; size: number; url: string; ts: string };
/** Images Claude can look at, and how big one may be. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const IMAGE_MAX = 3.5 * 1024 * 1024;
export const isImage = (f: Pick<SlackFile, 'mimetype'>) => IMAGE_TYPES.has(f.mimetype);
/** A message's files, as Slack lists them. */
export function filesOf(m: any): SlackFile[] {
  return (Array.isArray(m?.files) ? m.files : [])
    .filter((f: any) => f && f.mode !== 'tombstone' && f.mode !== 'hidden_by_limit')
    .map((f: any) => ({ name: String(f.name ?? f.title ?? 'file'), mimetype: String(f.mimetype ?? ''), size: Number(f.size ?? 0), url: String(f.url_private_download ?? f.url_private ?? ''), ts: String(m.ts ?? '') }));
}
/** A message's files, said in a line: ` [image: shot.png] [file: notes.pdf]`. */
export const filesLine = (files: SlackFile[]) => files.map((f) => ` [${isImage(f) ? 'image' : 'file'}: ${f.name}]`).join('');

/** A message found in Slack. */
/** Slack's markup as plain words: mentions by name, channels by #name, links by their label (and address). */
export function slackPlain(text: string, nameOf: (id: string) => string): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => `@${nameOf(id)}`)
    .replace(/<#([CG][A-Z0-9]+)\|([^>]*)>/g, '#$2')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1');
}

export type SlackHit = { where: string; channel: string; who: string; user: string; ts: string; text: string; link: string };
const TALK_MS = 10 * 60_000;
/** how many times to look for the message files were posted in */
const SHARE_TRIES = 8;
/** tries at posting with Cora's banner before going without it */
const BANNER_TRIES = 4;
/** A hit as one line: `[when] where · who: text (link)`. */
export function hitLine(h: SlackHit): string {
  const d = new Date(Number(h.ts) * 1000);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const when = d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${t}`;
  return `[${when}] ${h.where} · ${h.who}: ${h.text}${h.link ? ` (${h.link})` : ''}`;
}

/** A group DM's name (`mpdm-dana--david--sam-1`) as who's in it. */
const groupLabel = (name: string) => name.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').join(', ');

type Auth = {
  token: string;
  team: string;
  teamId: string;
  user: string;
  userId: string;
  url: string;
  /** token rotation: the refresh token and the app's credentials, and when the access token runs out (ms) */
  refresh?: string;
  clientId?: string;
  clientSecret?: string;
  expires?: number;
};
/** The app-level token (live events): as given, or rotating like the user token. */
type AppAuth = { token: string; refresh?: string; clientId?: string; clientSecret?: string; expires?: number };
/** The app's credentials, for a token that rotates. */
export type SlackRotation = { clientId: string; clientSecret: string };
/** Renew an access token this long before it runs out. */
const RENEW_MS = 10 * 60_000;
const DEAD = ['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed', 'invalid_refresh_token', 'invalid_client_id', 'bad_client_secret', 'not_allowed_token_type'];
type Person = { id: string; handle: string; name: string; real: string; email: string; names: string[] };
type Channel = { id: string; name: string; isPrivate: boolean; isGroup: boolean; names: string[] };
type Directory = { people: Person[]; channels: Channel[]; at: number };

const DIRECTORY_MS = 15 * 60_000;

/** Your Slack connection and what it knows about people and channels. */
export class Slack {
  private auth: Auth | null = null;
  private dir: Directory | null = null;
  private loading: Promise<Directory> | null = null;
  private lastError: string | undefined;
  /** can this token search (search:read)? unknown until checked */
  private searchOk: boolean | undefined;

  constructor(
    private o: { dataDir: string; api?: (token: string) => SlackApi; onChange?: () => void; /** for files (a fake in tests) */ fetch?: typeof fetch; /** between looks for a sent file's message */ shareWaitMs?: number },
  ) {
    const f = this.file();
    if (existsSync(f)) {
      try {
        this.auth = JSON.parse(readSecret(f)) as Auth;
      } catch {
        this.auth = null;
      }
    }
  }

  private file() {
    return join(this.o.dataDir, 'slack.json');
  }
  private call(): SlackApi {
    if (!this.auth) throw new SlackError('not_connected');
    if (!this.auth.refresh) return (this.o.api ?? slackApi)(this.auth.token);
    // a rotating token: renewed before it runs out, and once more if Slack says it has
    return async (method, params) => {
      await this.fresh();
      try {
        return await (this.o.api ?? slackApi)(this.auth!.token)(method, params);
      } catch (e) {
        if (!(e instanceof SlackError) || e.code !== 'token_expired') throw e;
        await this.fresh(true);
        return (this.o.api ?? slackApi)(this.auth!.token)(method, params);
      }
    };
  }

  /** Renew a rotating access token when it's close to running out (one renewal at a time). */
  private renewing: Promise<void> | null = null;
  private async fresh(force = false): Promise<void> {
    const a = this.auth;
    if (!a?.refresh || (!force && (a.expires ?? 0) - Date.now() > RENEW_MS)) return;
    this.renewing ??= this.renew(a).finally(() => (this.renewing = null));
    return this.renewing;
  }
  private async renew(a: Auth): Promise<void> {
    let t: { token: string; refresh: string; expires: number };
    try {
      t = await this.exchange(a.refresh!, { clientId: a.clientId!, clientSecret: a.clientSecret! });
    } catch (e) {
      this.check(e);
    }
    if (this.auth !== a) return;
    this.auth = { ...a, ...t };
    writeSecret(this.file(), JSON.stringify(this.auth));
  }
  /** A refresh token for a new access token (and the refresh token to use next time). */
  private async exchange(refresh: string, r: SlackRotation): Promise<{ token: string; refresh: string; expires: number }> {
    const j = await (this.o.api ?? slackApi)('')('oauth.v2.access', { client_id: r.clientId, client_secret: r.clientSecret, grant_type: 'refresh_token', refresh_token: refresh });
    // a user token comes back at the top level, or under authed_user
    const u = j.authed_user?.access_token ? j.authed_user : j;
    const token = String(u.access_token ?? '');
    if (!token) throw new SlackError('no_access_token');
    return { token, refresh: String(u.refresh_token ?? refresh), expires: Date.now() + Number(u.expires_in ?? 43_200) * 1000 };
  }

  status(): SlackStatus {
    const a = this.auth;
    return a ? { connected: true, team: a.team, teamId: a.teamId, user: a.user, userId: a.userId, url: a.url, ...(this.searchOk != null ? { search: this.searchOk } : {}) } : { connected: false, ...(this.lastError ? { error: this.lastError } : {}) };
  }

  /**
   * Check a user token and keep it: a User OAuth Token (xoxp-…), or with token rotation on, the Refresh Token
   * (xoxe-…) and the app's Client ID and Client Secret, which Cora uses to keep getting new access tokens.
   */
  async connect(token: string, rotation?: SlackRotation): Promise<SlackStatus> {
    const t = token.trim();
    let r: Pick<Auth, 'refresh' | 'clientId' | 'clientSecret' | 'expires'> = {};
    let access = t;
    if (/^xoxe-/.test(t)) {
      const clientId = rotation?.clientId?.trim() ?? '';
      const clientSecret = rotation?.clientSecret?.trim() ?? '';
      if (!clientId || !clientSecret) throw new SlackError("a refresh token needs the app's Client ID and Client Secret (on its Basic Information page)");
      const x = await this.exchange(t, { clientId, clientSecret });
      // both refresh tokens look alike: an app-level one (now used up) is kept for live events, where it belongs
      if (/^xoxe\.xapp-/.test(x.token)) {
        writeSecret(this.appFile(), JSON.stringify({ token: x.token, refresh: x.refresh, clientId, clientSecret, expires: x.expires }));
        this.o.onChange?.();
        throw new SlackError("that was the app-level token's refresh token: Cora has kept it for Live events. Here, paste the Refresh Token from OAuth & Permissions (the user token's)");
      }
      if (!/^xoxe\.xoxp-/.test(x.token)) throw new SlackError("that refresh token isn't for a user token: use the one on OAuth & Permissions");
      access = x.token;
      r = { refresh: x.refresh, clientId, clientSecret, expires: x.expires };
    } else if (/^xoxe\.xoxp-/.test(t)) throw new SlackError('that access token runs out in 12 hours: with token rotation on, paste the Refresh Token (xoxe-1-…) and the Client ID and Secret');
    else if (/^(xoxe\.)?xapp-/.test(t)) throw new SlackError("that's the app-level token: it goes under Live events. Here, Cora needs the user token (OAuth & Permissions)");
    else if (!/^xoxp-/.test(t)) throw new SlackError(t.startsWith('xoxb-') ? 'that is a bot token: Cora needs the User OAuth Token (xoxp-…), so messages go out as you' : 'not a Slack user token (it starts with xoxp-, or xoxe- for a refresh token)');
    const j = await (this.o.api ?? slackApi)(access)('auth.test');
    const auth: Auth = { token: access, team: String(j.team ?? ''), teamId: String(j.team_id ?? ''), user: String(j.user ?? ''), userId: String(j.user_id ?? ''), url: String(j.url ?? ''), ...r };
    writeSecret(this.file(), JSON.stringify(auth));
    this.auth = auth;
    this.dir = null;
    this.lastError = undefined;
    this.searchOk = undefined;
    this.o.onChange?.();
    void this.checkSearch();
    return this.status();
  }

  /** Your first name on Slack (your profile's real name, else your handle), for the line under messages Cora sends. */
  async firstName(): Promise<string> {
    if (!this.auth) return '';
    const me = (await this.directory().catch(() => null))?.people.find((p) => p.id === this.auth!.userId);
    return ((me?.real || me?.name || this.auth.user || '').trim().split(/\s+/)[0] ?? '').slice(0, 40);
  }

  private outsideKnown = new Map<string, { v: boolean; at: number }>();
  /**
   * Does a message here go beyond your company? A channel
   * shared with another organisation, a person from another workspace, a guest. Not knowing counts as yes. Kept an hour.
   */
  async outside(to: SlackTarget): Promise<boolean> {
    const hit = this.outsideKnown.get(to.id);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.v;
    let v = true;
    try {
      const api = this.call();
      let user = to.kind === 'person' && !to.id.startsWith('D') ? to.id : null;
      if (!user) {
        const c = (await api('conversations.info', { channel: to.id })).channel;
        if (!c) throw new Error('no such conversation');
        // a DM: whoever it's with
        if (c.is_im && c.user) user = String(c.user);
        else v = !!(c.is_ext_shared || c.is_pending_ext_shared || (c.is_shared && !c.is_org_shared));
      }
      if (user) {
        const u = (await api('users.info', { user })).user;
        if (!u) throw new Error('no such person');
        v = !!(u.is_restricted || u.is_ultra_restricted || u.is_stranger || (u.team_id && this.auth?.teamId && u.team_id !== this.auth.teamId));
      }
    } catch {
      v = true;
    }
    this.outsideKnown.set(to.id, { v, at: Date.now() });
    return v;
  }

  /** Can the app search (for what's waiting in briefs)? One tiny search tells. */
  async checkSearch(): Promise<boolean | undefined> {
    if (!this.auth) return undefined;
    try {
      await this.call()('search.messages', { query: 'cora', count: 1 });
      this.searchOk = true;
    } catch (e) {
      const code = e instanceof SlackError ? e.code : '';
      if (code === 'missing_scope') this.searchOk = false;
      else if (DEAD.includes(code)) {
        try {
          this.check(e);
        } catch {
          /* forgotten: Settings says to connect again */
        }
        return undefined;
      }
    }
    this.o.onChange?.();
    return this.searchOk;
  }

  disconnect(): void {
    rmSync(this.file(), { force: true });
    this.auth = null;
    this.dir = null;
    this.o.onChange?.();
  }

  /** A call failed because the token is no good any more (revoked, the app removed): forget it. */
  private check(e: unknown): never {
    const code = e instanceof SlackError ? e.code : '';
    if (DEAD.includes(code)) {
      this.lastError = `Slack said ${code}: connect again in Settings → Slack`;
      this.disconnect();
    }
    throw e;
  }

  /** People and channels (cached a while; refreshed when stale). */
  async directory(): Promise<Directory> {
    if (this.dir && Date.now() - this.dir.at < DIRECTORY_MS) return this.dir;
    if (!this.loading) {
      this.loading = this.loadDirectory().finally(() => (this.loading = null));
    }
    return this.loading;
  }

  private async loadDirectory(): Promise<Directory> {
    const api = this.call();
    const people: Person[] = [];
    const channels: Channel[] = [];
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 30; page++) {
        const j = await api('users.list', { limit: 200, cursor });
        for (const u of j.members ?? []) {
          if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
          const p = u.profile ?? {};
          const name = String(p.display_name || p.real_name || u.name || u.id);
          const real = String(p.real_name || u.real_name || '');
          const email = String(p.email || '');
          people.push({ id: u.id, handle: String(u.name ?? ''), name, real, email, names: [name, real, String(u.name ?? ''), email.split('@')[0]] });
        }
        cursor = j.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      cursor = undefined;
      for (let page = 0; page < 30; page++) {
        const j = await api('conversations.list', { types: 'public_channel,private_channel,mpim', exclude_archived: true, limit: 1000, cursor });
        for (const c of j.channels ?? []) {
          const name = String(c.name ?? c.id);
          channels.push({ id: c.id, name, isPrivate: Boolean(c.is_private), isGroup: Boolean(c.is_mpim), names: [name] });
        }
        cursor = j.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
    } catch (e) {
      this.check(e);
    }
    this.dir = { people, channels, at: Date.now() };
    return this.dir;
  }

  private personTarget(p: Person): SlackTarget {
    return { kind: 'person', id: p.id, label: p.name, detail: [p.real !== p.name ? p.real : '', p.handle ? `@${p.handle}` : '', p.email].filter(Boolean).join(' · ') };
  }
  private channelTarget(c: Channel): SlackTarget {
    return { kind: c.isGroup ? 'group' : 'channel', id: c.id, label: c.isGroup ? groupLabel(c.name) : `#${c.name}`, ...(c.isPrivate && !c.isGroup ? { detail: 'private' } : c.isGroup ? { detail: 'group DM' } : {}) };
  }

  /** People and channels matching a name (or part of one). */
  async find(query: string, limit = 8): Promise<SlackTarget[]> {
    const d = await this.directory();
    const q = query.trim();
    const wantChannel = q.startsWith('#');
    const wantPerson = q.startsWith('@') || q.includes('@');
    const people = wantChannel ? [] : rankByName(d.people, q.includes('@') && !q.startsWith('@') ? q.split('@')[0] : q, limit).map((p) => this.personTarget(p));
    const chans = wantPerson ? [] : rankByName(d.channels, q, limit).map((c) => this.channelTarget(c));
    // exact name matches first, then people before channels
    const exact = (t: SlackTarget) => t.label.toLowerCase().replace(/^#/, '') === q.toLowerCase().replace(/^[#@]/, '');
    // exact name matches first; then people, channels, and group DMs last
    const order = { person: 0, channel: 1, group: 2 } as const;
    return [...people, ...chans].sort((a, b) => Number(exact(b)) - Number(exact(a)) || order[a.kind] - order[b.kind]).slice(0, limit);
  }

  /**
   * Who `to` means: an id (C…/G…/D…/U…/W…), #channel, @handle, an email, or a name. Ambiguous or unknown names are an
   * error naming the candidates (the session should ask, or use slack_find).
   */
  /** An image on a message, to show Claude (base64), or null when it's too big, not an image, or can't be had. */
  async image(f: SlackFile): Promise<{ data: string; mimeType: string } | null> {
    if (!isImage(f) || f.size > IMAGE_MAX || !/^https:\/\/[\w.-]+\.slack\.com\//.test(f.url) || !this.auth) return null;
    try {
      await this.fresh();
      const r = await (this.o.fetch ?? fetch)(f.url, { headers: { authorization: `Bearer ${this.auth.token}` } });
      const type = (r.headers.get('content-type') ?? '').split(';')[0].trim();
      // without the files:read scope Slack answers with its sign-in page, not the file
      if (!r.ok || !IMAGE_TYPES.has(type)) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return buf.length > IMAGE_MAX ? null : { data: buf.toString('base64'), mimeType: type };
    } catch {
      return null;
    }
  }

  /** A conversation's name for people: #channel, "DM with Dana", or its id. */
  async where(channel: string): Promise<string> {
    if (channel.startsWith('D')) {
      try {
        const j = await this.call()('conversations.info', { channel });
        if (j.channel?.user) return `DM with ${await this.personName(String(j.channel.user))}`;
      } catch {
        /* just a DM */
      }
      return 'a DM';
    }
    return (await this.resolve(channel).catch(() => null))?.label ?? channel;
  }

  /**
   * Messages since a time (ms) that could answer a thread: its replies, and in a DM, the conversation too (in a DM
   * people answer below, not in the thread). Oldest first, as Slack's events would have had them.
   */
  async since(channel: string, threadTs: string, atMs: number): Promise<any[]> {
    const oldest = (atMs / 1000 - 1).toFixed(6);
    const out: any[] = [];
    const r = await this.call()('conversations.replies', { channel, ts: threadTs, oldest, limit: 50 }).catch(() => null);
    for (const m of r?.messages ?? []) if (m.ts !== threadTs) out.push({ ...m, thread_ts: m.thread_ts ?? threadTs });
    if (channel.startsWith('D')) {
      const h = await this.call()('conversations.history', { channel, oldest, limit: 50 });
      for (const m of h.messages ?? []) if (!m.thread_ts || m.thread_ts === m.ts) out.push({ ...m, channel_type: 'im' });
    }
    return out.sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  async resolve(to: string): Promise<SlackTarget> {
    const t = to.trim();
    const d = await this.directory();
    // an id it knows (any length), else one shaped like an id
    const knownP = d.people.find((x) => x.id === t);
    if (knownP) return this.personTarget(knownP);
    const knownC = d.channels.find((x) => x.id === t);
    if (knownC) return this.channelTarget(knownC);
    if (/^[CGD][A-Z0-9]{6,}$/.test(t)) {
      const c = d.channels.find((x) => x.id === t);
      return c ? this.channelTarget(c) : { kind: t.startsWith('D') ? 'person' : 'channel', id: t, label: t };
    }
    if (/^[UW][A-Z0-9]{6,}$/.test(t)) {
      const p = d.people.find((x) => x.id === t);
      if (p) return this.personTarget(p);
      throw new SlackError(`no person with id ${t}`);
    }
    const q = t.replace(/^[#@]/, '').toLowerCase();
    if (t.includes('@') && !t.startsWith('@')) {
      const p = d.people.find((x) => x.email.toLowerCase() === t.toLowerCase());
      if (p) return this.personTarget(p);
    }
    const people = t.startsWith('#') ? [] : d.people.filter((p) => [p.handle, p.name, p.real].some((n) => n.toLowerCase() === q));
    const chans = t.startsWith('@') ? [] : d.channels.filter((c) => c.name.toLowerCase() === q);
    const exact = [...people.map((p) => this.personTarget(p)), ...chans.map((c) => this.channelTarget(c))];
    if (exact.length === 1) return exact[0];
    const options = exact.length ? exact : await this.find(t, 6);
    if (options.length === 1 && !exact.length && options[0].label.toLowerCase().replace(/^#/, '').startsWith(q)) return options[0];
    throw new SlackError(
      options.length
        ? `"${t}" could mean: ${options.map((o) => `${o.label} (${o.id}${o.detail ? `, ${o.detail}` : ''})`).join('; ')}. Pass the id.`
        : `no person or channel called "${t}" (try slack_find)`,
    );
  }

  /** The conversation to post in for a target (a person's DM is opened if needed). */
  async conversation(to: SlackTarget): Promise<string> {
    if (to.kind !== 'person') return to.id;
    if (to.id.startsWith('D')) return to.id;
    try {
      const j = await this.call()('conversations.open', { users: to.id });
      return String(j.channel?.id);
    } catch (e) {
      return this.check(e);
    }
  }

  /** @Name in the text as a real mention, when it's exactly someone's handle or display name. */
  private async mentions(text: string): Promise<string> {
    if (!text.includes('@')) return text;
    const d = await this.directory();
    return text.replace(/(^|[\s(])@([\w.-]{2,40})/g, (m, pre: string, name: string) => {
      const n = name.toLowerCase();
      const hits = d.people.filter((p) => p.handle.toLowerCase() === n || p.name.toLowerCase() === n);
      return hits.length === 1 ? `${pre}<@${hits[0].id}>` : m;
    });
  }

  /**
   * Post as you. Returns the message's link. `footer`: a small grey line under it (Slack's context block), so whoever
   * reads it knows Cora sent it for you; the message's own text stays as it is (notifications, search).
   */
  async post(to: SlackTarget, text: string, threadTs?: string, o: { footer?: string; banner?: Uint8Array | null; /** lay a structured message out in blocks (richBlocks; default on): off for what you typed */ rich?: boolean } = {}): Promise<{ channel: string; ts: string; link: string; /** the banner's file (Undo deletes it too) */ fileIds?: string[] }> {
    try {
      const { footer, banner } = o;
      const channel = await this.conversation(to);
      const raw = await this.mentions(text);
      const body = toMrkdwn(raw);
      // a structured message in Slack's blocks (headers, dividers, a grid of facts); else sections, as ever
      let rich = o.rich !== false ? richBlocks(raw) : null;
      // Cora's banner on top: uploaded privately, then shown
      // by its file (Slack plays it as a GIF; whoever reads the message sees it)
      const file = banner?.length ? await this.uploadImage(banner, 'cora.gif').catch(() => null) : null;
      const images: object[] = file ? [{ type: 'image', slack_file: { id: file }, alt_text: 'Cora' }] : [];
      let k = 0;
      const postIt = () => {
        const img = images[k];
        // under the banner a plain message is quoted: the banner's bar and the quote's run down as one column (a laid
        // out one isn't: its headers and grids can't be)
        const content = rich ?? sections(img ? quoted(body) : body);
        const blocks = footer || img || rich ? [...(img ? [img] : []), ...content, ...(footer ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] }] : [])] : undefined;
        return this.call()('chat.postMessage', { channel, text: body, ...(blocks ? { blocks } : {}), ...(threadTs ? { thread_ts: threadTs } : {}) });
      };
      let j: any;
      for (let i = 0; ; i++) {
        try {
          j = await postIt();
          break;
        } catch (e) {
          if (!(e instanceof SlackError) || !/^(invalid_blocks|invalid_slack_file|file_not_found)/.test(e.code)) throw e;
          // Slack may not have the image ready a moment after it's uploaded: a moment more, then without it
          if (k < images.length) {
            if (i >= BANNER_TRIES - 1) (k++, (i = -1));
            else await new Promise((r) => setTimeout(r, this.o.shareWaitMs ?? 1000));
            continue;
          }
          // blocks Slack won't take: the message as plain sections
          if (!rich) throw e;
          rich = null;
        }
      }
      const ts = String(j.ts);
      const p = await this.call()('chat.getPermalink', { channel, message_ts: ts }).catch(() => null);
      return { channel, ts, link: p?.permalink ? String(p.permalink) : '', ...(file ? { fileIds: [file] } : {}) };
    } catch (e) {
      return this.check(e);
    }
  }

  /**
   * A message with files (Slack's external upload: an upload URL per file, the bytes, then one completing call that
   * posts them with the text). The message's ts comes from the files' shares, which Slack fills in a moment later.
   */
  async postFiles(to: SlackTarget, text: string, files: SlackAttachment[], threadTs?: string): Promise<{ channel: string; ts?: string; link: string; fileIds: string[] }> {
    try {
      const channel = await this.conversation(to);
      const ids: string[] = [];
      for (const f of files) {
        const buf = readFileSync(f.path);
        const u = await this.call()('files.getUploadURLExternal', { filename: f.name, length: buf.length });
        const r = await (this.o.fetch ?? fetch)(String(u.upload_url), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf });
        if (!r.ok) throw new SlackError(`uploading ${f.name} failed (${r.status})`);
        ids.push(String(u.file_id));
      }
      const body = text.trim() ? await this.mentions(toMrkdwn(text)) : '';
      await this.call()('files.completeUploadExternal', { files: JSON.stringify(ids.map((id, i) => ({ id, title: files[i].name }))), channel_id: channel, ...(body ? { initial_comment: body } : {}), ...(threadTs ? { thread_ts: threadTs } : {}) });
      let ts: string | undefined;
      let fileLink = '';
      for (let i = 0; i < SHARE_TRIES && !ts; i++) {
        const info = await this.call()('files.info', { file: ids[0] }).catch(() => null);
        const sh = info?.file?.shares;
        ts = sh?.public?.[channel]?.[0]?.ts ?? sh?.private?.[channel]?.[0]?.ts;
        fileLink = String(info?.file?.permalink ?? fileLink);
        if (!ts && i < SHARE_TRIES - 1) await new Promise((r) => setTimeout(r, this.o.shareWaitMs ?? 400));
      }
      const p = ts ? await this.call()('chat.getPermalink', { channel, message_ts: ts }).catch(() => null) : null;
      return { channel, ...(ts ? { ts: String(ts) } : {}), link: p?.permalink ? String(p.permalink) : fileLink, fileIds: ids };
    } catch (e) {
      return this.check(e);
    }
  }

  /** An image uploaded to Slack without sharing it anywhere (yours alone until a message shows it): its file id. */
  private async uploadImage(bytes: Uint8Array, filename: string): Promise<string> {
    const u = await this.call()('files.getUploadURLExternal', { filename, length: bytes.length });
    const r = await (this.o.fetch ?? fetch)(String(u.upload_url), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
    if (!r.ok) throw new SlackError(`uploading ${filename} failed (${r.status})`);
    const id = String(u.file_id);
    await this.call()('files.completeUploadExternal', { files: JSON.stringify([{ id, title: 'Cora' }]) });
    return id;
  }

  /** Delete files you just sent (Undo). */
  async removeFiles(ids: string[]): Promise<void> {
    for (const file of ids) await this.call()('files.delete', { file }).catch(() => {});
  }

  /** Where to open a conversation (or a thread in it) in Slack's web app. */
  /** Take back a message you just sent (Undo). */
  async remove(channel: string, ts: string): Promise<void> {
    try {
      await this.call()('chat.delete', { channel, ts });
    } catch (e) {
      this.check(e);
    }
  }

  /**
   * What's waiting for you since a time: messages sent to you (DMs) and messages that mention you, newest first, as
   * `[when] where · who: text (link)`. Slack search, so the app needs search:read (without it: missing_scope).
   */
  async inbox(sinceMs: number, limit = 30): Promise<string[]> {
    const a = this.auth;
    if (!a) throw new SlackError('not_connected');
    // `after:` takes a day and leaves it out: from the day before, then by the exact time
    const after = new Date(sinceMs - 86_400_000).toISOString().slice(0, 10);
    const seen = new Set<string>();
    const hits: any[] = [];
    for (const query of [`to:me after:${after}`, `<@${a.userId}> after:${after}`]) {
      let j: any;
      try {
        j = await this.call()('search.messages', { query, count: 40, sort: 'timestamp', sort_dir: 'desc' });
      } catch (e) {
        this.check(e);
      }
      for (const m of j?.messages?.matches ?? []) {
        const key = `${m.channel?.id}:${m.ts}`;
        if (Number(m.ts) * 1000 < sinceMs || m.user === a.userId || seen.has(key)) continue;
        seen.add(key);
        hits.push(m);
      }
    }
    return (await this.describe(hits.sort((x, y) => Number(y.ts) - Number(x.ts)).slice(0, limit))).map(hitLine);
  }

  /** A person's name (their real name, else their handle) by id. */
  async personName(id: string): Promise<string> {
    const p = (await this.directory()).people.find((x) => x.id === id);
    return p?.real || p?.name || id;
  }

  /** Search Slack's messages (what the user can see), best matches first: the hits, described. */
  async search(query: string, limit = 15, sort: 'score' | 'timestamp' = 'score'): Promise<SlackHit[]> {
    if (!this.auth) throw new SlackError('not_connected');
    let j: any;
    try {
      j = await this.call()('search.messages', { query, count: Math.min(50, limit), sort, sort_dir: 'desc' });
    } catch (e) {
      this.check(e);
    }
    return this.describe((j?.messages?.matches ?? []).slice(0, limit));
  }

  /** Where a ticket key comes up in Slack: per conversation, how often and its newest message (cached a while). */
  async ticketTalk(key: string): Promise<Array<{ where: string; channel: string; count: number; link: string; ts: string }>> {
    const k = key.toUpperCase();
    const c = this.talk.get(k);
    if (c && Date.now() - c.at < TALK_MS) return c.groups;
    const hits = await this.search(`"${k}"`, 40, 'timestamp');
    const by = new Map<string, { where: string; channel: string; count: number; link: string; ts: string }>();
    for (const h of hits) {
      const g = by.get(h.channel);
      if (g) g.count++;
      else by.set(h.channel, { where: h.where, channel: h.channel, count: 1, link: h.link, ts: h.ts });
    }
    const groups = [...by.values()].sort((x, y) => y.count - x.count || Number(y.ts) - Number(x.ts));
    this.talk.set(k, { at: Date.now(), groups });
    return groups;
  }
  private talk = new Map<string, { at: number; groups: Array<{ where: string; channel: string; count: number; link: string; ts: string }> }>();

  /** Search matches as hits: where (#channel, DM, group DM), who (their name), when, the text on one line, the link. */
  private async describe(matches: any[]): Promise<SlackHit[]> {
    if (!matches.length) return [];
    const dir = await this.directory().catch(() => null);
    const nameOf = (id: string, handle?: string) => {
      const p = dir?.people.find((x) => x.id === id);
      return p?.real || p?.name || handle || id;
    };
    return matches.map((m) => {
      const c = m.channel ?? {};
      return {
        where: c.is_im ? 'DM' : c.is_mpim ? `group DM (${groupLabel(String(c.name ?? ''))})` : `#${c.name ?? c.id}`,
        channel: String(c.id ?? ''),
        who: nameOf(String(m.user ?? ''), m.username),
        user: String(m.user ?? ''),
        ts: String(m.ts),
        text: `${String(m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)}${filesLine(filesOf(m))}`,
        link: String(m.permalink ?? ''),
      };
    });
  }

  // ---------------------------------------------------------------- Cora's own bot (xoxb-): Cora as itself
  private botFile() {
    return join(this.o.dataDir, 'slack-bot.json');
  }
  private bot: { token: string; userId: string; name: string; dm?: string } | null | undefined;
  private readBot() {
    if (this.bot !== undefined) return this.bot;
    try {
      const b = JSON.parse(readSecret(this.botFile()));
      this.bot = b?.token ? b : null;
    } catch {
      this.bot = null;
    }
    return this.bot;
  }
  /** The bot, when its token is set: its user id and name. */
  botInfo(): { userId: string; name: string } | null {
    const b = this.readBot();
    return b ? { userId: b.userId, name: b.name } : null;
  }
  /** Keep the bot's token (a Bot User OAuth Token, xoxb-…), checked with Slack. Empty takes it away. */
  async setBotToken(token: string | null): Promise<{ name: string }> {
    const t = token?.trim();
    if (!t) {
      rmSync(this.botFile(), { force: true });
      this.bot = null;
      this.o.onChange?.();
      return { name: '' };
    }
    if (!/^xoxb-/.test(t)) throw new SlackError("not a bot token (it starts with xoxb-: OAuth & Permissions → Bot User OAuth Token)");
    const who = await (this.o.api ?? slackApi)(t)('auth.test');
    if (this.auth && who.team_id && who.team_id !== this.auth.teamId) throw new SlackError("that bot is in another workspace than your Slack connection");
    const b = { token: t, userId: String(who.user_id ?? ''), name: String(who.user ?? 'cora') };
    writeSecret(this.botFile(), JSON.stringify(b));
    this.bot = b;
    this.o.onChange?.();
    return { name: b.name };
  }
  /** The bot's DM with you (opened once, then remembered). */
  async botDm(): Promise<string> {
    const b = this.readBot();
    if (!b) throw new SlackError('no_bot');
    if (b.dm) return b.dm;
    if (!this.auth?.userId) throw new SlackError('not_connected');
    const j = await (this.o.api ?? slackApi)(b.token)('conversations.open', { users: this.auth.userId });
    b.dm = String(j.channel?.id ?? '');
    writeSecret(this.botFile(), JSON.stringify(b));
    return b.dm;
  }
  /** Post in the bot's DM with you, as Cora (text is the notification's; blocks, what's shown). */
  async postAsCora(text: string, blocks?: unknown[]): Promise<{ channel: string; ts: string }> {
    const b = this.readBot();
    if (!b) throw new SlackError('no_bot');
    const channel = await this.botDm();
    const j = await (this.o.api ?? slackApi)(b.token)('chat.postMessage', { channel, text: text.slice(0, 3000), ...(blocks ? { blocks } : {}), unfurl_links: false });
    return { channel, ts: String(j.ts) };
  }
  /** Cora reacts to a message in its DM (👀 when it starts on what you wrote, ✅ when it's answered); `remove` takes one off. */
  async reactAsCora(channel: string, ts: string, name: string, remove = false): Promise<void> {
    const b = this.readBot();
    if (!b) return;
    await (this.o.api ?? slackApi)(b.token)(remove ? 'reactions.remove' : 'reactions.add', { channel, timestamp: ts, name });
  }

  /** Change one of Cora's messages (a prompt answered). */
  async updateAsCora(channel: string, ts: string, text: string, blocks?: unknown[]): Promise<void> {
    const b = this.readBot();
    if (!b) return;
    await (this.o.api ?? slackApi)(b.token)('chat.update', { channel, ts, text: text.slice(0, 3000), blocks: blocks ?? [] });
  }

  // ---------------------------------------------------------------- live events (Socket Mode): an app-level token
  private appFile() {
    return join(this.o.dataDir, 'slack-app.json');
  }
  private readApp(): AppAuth | null {
    try {
      const a = JSON.parse(readSecret(this.appFile())) as AppAuth;
      return a.token ? a : null;
    } catch {
      return null;
    }
  }
  /** Is there an app-level token for live events? */
  hasAppToken(): boolean {
    return !!this.readApp();
  }
  /**
   * The app-level token for live events: as given (xapp-…), or with token rotation on, a current one (renewed with
   * its refresh token when it's close to running out, or when Slack says it has: `force`).
   */
  async appToken(force = false): Promise<string | null> {
    const a = this.readApp();
    if (!a?.refresh || (!force && (a.expires ?? 0) - Date.now() > RENEW_MS)) return a?.token ?? null;
    this.appRenewing ??= this.exchange(a.refresh, { clientId: a.clientId!, clientSecret: a.clientSecret! })
      .then((t) => {
        writeSecret(this.appFile(), JSON.stringify({ ...a, ...t }));
        return t.token;
      })
      .finally(() => (this.appRenewing = null));
    return this.appRenewing;
  }
  private appRenewing: Promise<string> | null = null;
  /**
   * Keep the app-level token: an xapp-… token, or with token rotation on, its Refresh Token (xoxe-…) and the app's
   * Client ID and Secret (the ones the user token was connected with, unless given). Empty takes it away.
   */
  async setAppToken(token: string | null, rotation?: SlackRotation): Promise<void> {
    const t = token?.trim();
    if (!t) rmSync(this.appFile(), { force: true });
    else if (/^xapp-/.test(t)) writeSecret(this.appFile(), JSON.stringify({ token: t }));
    else if (/^xoxe\.xapp-/.test(t)) throw new SlackError('that token runs out in 12 hours: paste its Refresh Token (xoxe-1-…) instead');
    else if (/^xoxe-/.test(t)) {
      const clientId = rotation?.clientId?.trim() || this.auth?.clientId || '';
      const clientSecret = rotation?.clientSecret?.trim() || this.auth?.clientSecret || '';
      if (!clientId || !clientSecret) throw new SlackError("a refresh token needs the app's Client ID and Client Secret (on its Basic Information page)");
      const x = await this.exchange(t, { clientId, clientSecret });
      if (!/^xoxe\.xapp-/.test(x.token)) throw new SlackError("that's not an app-level token's refresh token: use the one from Basic Information → App-Level Tokens");
      writeSecret(this.appFile(), JSON.stringify({ token: x.token, refresh: x.refresh, clientId, clientSecret, expires: x.expires }));
    } else throw new SlackError('not an app-level token (it starts with xapp-, or xoxe- for its refresh token)');
    this.o.onChange?.();
  }

  async webUrl(to: SlackTarget, threadTs?: string): Promise<string> {
    const channel = await this.conversation(to);
    return slackWebUrl(this.auth?.teamId ?? '', channel, threadTs);
  }

  /** A conversation's recent messages, or a thread, as lines for a session to read. */
  async read(o: { to?: string; link?: string; limit?: number }): Promise<{ where: SlackTarget; thread?: string; lines: string[]; files: SlackFile[] }> {
    const limit = Math.max(1, Math.min(50, o.limit ?? 20));
    const d = await this.directory();
    const who = (id: string) => d.people.find((p) => p.id === id)?.name ?? id;
    const clean = (t: string) => slackPlain(t, who).slice(0, 1500);
    const files: SlackFile[] = [];
    const line = (m: any) => {
      const fs = filesOf(m);
      files.push(...fs);
      return `[${new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ')}] ${m.user ? who(m.user) : m.username ?? 'bot'}: ${clean(String(m.text ?? ''))}${filesLine(fs)}${m.reply_count ? ` (${m.reply_count} replies, thread ${m.ts})` : ''}`;
    };
    try {
      if (o.link) {
        const l = parseSlackLink(o.link);
        if (!l) throw new SlackError('not a Slack message link');
        const where = await this.resolve(l.channel).catch(() => ({ kind: 'channel' as const, id: l.channel, label: l.channel }));
        const j = await this.call()('conversations.replies', { channel: l.channel, ts: l.threadTs ?? l.ts, limit });
        return { where, thread: l.threadTs ?? l.ts, lines: (j.messages ?? []).map(line), files };
      }
      if (!o.to) throw new SlackError('say which conversation (to) or give a message link');
      const where = await this.resolve(o.to);
      const channel = await this.conversation(where);
      const j = await this.call()('conversations.history', { channel, limit });
      return { where, lines: (j.messages ?? []).reverse().map(line), files };
    } catch (e) {
      return this.check(e);
    }
  }
}

export type DraftOutcome =
  | { sent: true; link: string; text: string; to: SlackTarget; edited: boolean }
  | { sent: false; why: 'discarded' | 'opened' | 'waiting' | 'error'; error?: string; text?: string; to?: SlackTarget };

type Held = { draft: SlackDraft; answer: (o: DraftOutcome) => void; answered: boolean };

/** How long a session waits for your answer before it's told the draft is waiting in Cora (it still is). */
export const DRAFT_WAIT_MS = 10 * 60_000;

/**
 * Messages sessions want to send, until you answer: send (as written or as you changed it), take it to Slack to finish
 * yourself, or discard. The session waits a while for the answer, then carries on knowing the draft waits for you.
 */
export class Outbox {
  private held = new Map<string, Held>();
  /** recent slack_send calls seen in sessions' events (by text), for drafts whose MCP call didn't say which session */
  private seen: Array<{ sessionId: string; text: string; ts: number }> = [];

  /** messages Cora sent straight away because you asked, while they can still be undone */
  private sentNow = new Map<string, SlackSent & { channel: string; ts?: string; fileIds?: string[] }>();

  /** conversations you let Cora carry on by itself, until when */
  private grantList: SlackGrant[] = [];

  /** each waiting draft's banner, made as it arrives (so Send doesn't wait for it) */
  private banners = new Map<string, Promise<Uint8Array | null>>();

  constructor(private o: { slack: Slack; onChange: () => void; waitMs?: number; onUndo?: (s: SlackSent) => void; /** where grants are kept */ file?: string; /** where drafts waiting for you are kept (across a restart) */ draftsFile?: string; /** the sign-off on messages Cora sends for you ('' : none) */ sign?: () => string; /** Cora's banner for a message it sends for you (a GIF; which session wrote it), or none. `reviewed`: you see it before it goes (a draft, your own DM) */ banner?: (d: { sessionId: string | null; text: string; to: SlackTarget; reviewed: boolean }) => Promise<Uint8Array | null>; /** what that banner will say, for the draft card to show before it goes */ bannerPreview?: (d: { sessionId: string | null; text: string; to: SlackTarget; reviewed: boolean }) => Promise<Record<string, string> | null>; /** a session wrote it, not Cora herself (its sign-off says so) */ bySession?: (sessionId: string | null) => boolean }) {
    try {
      if (o.file && existsSync(o.file)) this.grantList = (JSON.parse(readFileSync(o.file, 'utf8')) as SlackGrant[]).filter((g) => g.until > Date.now());
    } catch {
      this.grantList = [];
    }
    // drafts from before a restart are still yours to send or discard; the session that asked moved on long ago, so
    // nobody waits on the answer (docs/audit-2026-10-20.md U3)
    try {
      if (o.draftsFile && existsSync(o.draftsFile))
        for (const d of JSON.parse(readFileSync(o.draftsFile, 'utf8')) as SlackDraft[]) if (d?.id && d.to && typeof d.text === 'string') this.held.set(d.id, { draft: { ...d, waiting: false }, answered: true, answer: () => {} });
    } catch {
      /* none kept */
    }
  }

  /** Something changed: the drafts are kept, and the dashboards hear. */
  private changed(): void {
    try {
      if (this.o.draftsFile) writeFileAtomic(this.o.draftsFile, JSON.stringify(this.list()));
    } catch {
      /* kept for this run */
    }
    this.o.onChange();
  }

  // ---------------------------------------------------------------- conversations Cora may carry on by itself
  grants(): SlackGrant[] {
    const now = Date.now();
    return this.grantList.filter((g) => g.until > now);
  }
  /** May Cora write in this conversation without asking (you let it)? */
  allowed(channel: string): boolean {
    return this.grants().some((g) => g.channel === channel);
  }
  /** Let Cora carry on a conversation by itself for a while (at most a day). */
  allow(g: { channel: string; label: string; about?: string; hours?: number }): SlackGrant {
    const at = Date.now();
    const grant: SlackGrant = { channel: g.channel, label: g.label, ...(g.about ? { about: g.about } : {}), at, until: at + Math.min(24, Math.max(0.25, g.hours ?? 4)) * 3_600_000 };
    this.grantList = [...this.grants().filter((x) => x.channel !== g.channel), grant];
    this.saveGrants();
    return grant;
  }
  /** Stop: one conversation, or all of them. What was stopped. */
  stop(channel?: string): SlackGrant[] {
    const gone = this.grants().filter((g) => !channel || g.channel === channel);
    if (!gone.length) return [];
    this.grantList = this.grants().filter((g) => !gone.includes(g));
    this.saveGrants();
    return gone;
  }
  private saveGrants() {
    try {
      if (this.o.file) writeFileAtomic(this.o.file, JSON.stringify(this.grantList));
    } catch {
      /* not kept */
    }
    this.changed();
  }

  sent(): SlackSent[] {
    return [...this.sentNow.values()].map(({ channel: _c, ts: _t, fileIds: _f, ...s }) => s);
  }
  /** A file on a draft or a just-sent message (for its preview). */
  attachment(kind: 'draft' | 'sent', id: string, i: number): SlackAttachment | undefined {
    const files = kind === 'draft' ? this.held.get(id)?.draft.files : this.sentNow.get(id)?.files;
    return files?.[i];
  }

  /**
   * The line under a message Cora sends for you: your sign-off (the user's setting, e.g. :cora:) and who it's for.
   * None when the sign-off is turned off.
   */
  private async footer(sessionId: string | null = null): Promise<string | undefined> {
    const sign = this.o.sign?.().trim();
    if (!sign) return undefined;
    const name = await this.o.slack.firstName().catch(() => '');
    // a session's: it says so
    return `${sign}  Sent from ${this.o.bySession?.(sessionId) ? 'a Cora session' : 'Cora'}${name ? ` on ${name}'s behalf` : ''}`;
  }

  /** A message with files, signed at its end (their message takes no line under it): once. */
  private signed(text: string): string {
    const sign = this.o.sign?.().trim();
    return sign && !text.trimEnd().endsWith(sign) ? `${text.trimEnd()} ${sign}` : text;
  }

  /**
   * Send now (you asked Cora for it in your own words): posted at once, and it can be undone for a few seconds.
   * `typed`: you wrote it yourself (the Inbox's reply), so it isn't signed as Cora's.
   */
  async sendNow(d: { to: SlackTarget; text: string; threadTs?: string; own?: boolean; typed?: boolean; files?: SlackAttachment[]; /** the session that wrote it (its banner says so) */ sessionId?: string | null; /** false: without Cora's banner */ banner?: boolean; /** only you read it (your own DM): its banner may say more */ reviewed?: boolean }): Promise<{ id: string; link: string }> {
    const footer = d.typed ? undefined : await this.footer(d.sessionId ?? null);
    // Cora's banner on top of what Cora writes (not what you typed; not with files)
    const banner = !d.typed && !d.files?.length && d.banner !== false && this.o.banner ? await this.o.banner({ sessionId: d.sessionId ?? null, text: d.text, to: d.to, reviewed: !!d.reviewed }).catch(() => null) : null;
    const r = d.files?.length ? await this.o.slack.postFiles(d.to, d.typed ? d.text : this.signed(d.text), d.files, d.threadTs) : await this.o.slack.post(d.to, d.text, d.threadTs, { footer, banner, rich: !d.typed });
    const at = Date.now();
    const id = randomUUID();
    this.sentNow.set(id, { id, to: d.to, text: d.text, link: r.link, at, until: at + UNDO_MS, channel: r.channel, ...(r.ts ? { ts: r.ts } : {}), ...(r.fileIds ? { fileIds: r.fileIds, ...(d.files ? { files: d.files } : {}) } : {}), ...(d.own ? { own: r.channel } : {}) });
    setTimeout(() => this.sentNow.delete(id) && this.changed(), UNDO_MS + 500).unref?.();
    this.changed();
    return { id, link: r.link };
  }

  /** Undo: take the message back (deleted from Slack), while there's still time. */
  async undo(id: string): Promise<{ ok: boolean; error?: string }> {
    const s = this.sentNow.get(id);
    if (!s || Date.now() > s.until + 2000) return { ok: false, error: 'too late to undo: delete it in Slack' };
    try {
      // the message, then its files (a message Slack hadn't placed yet: just the files)
      if (s.ts) await this.o.slack.remove(s.channel, s.ts);
      if (s.fileIds?.length) await this.o.slack.removeFiles(s.fileIds);
    } catch (e) {
      return { ok: false, error: e instanceof SlackError ? e.code : (e as Error).message };
    }
    this.sentNow.delete(id);
    const { channel: _c, ts: _t, fileIds: _f, ...rest } = s;
    this.o.onUndo?.(rest);
    this.changed();
    return { ok: true };
  }

  list(): SlackDraft[] {
    return [...this.held.values()].map((h) => h.draft).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** A session's slack_send call started (from its hooks or transcript): remember who asked, by the text. */
  noteCall(sessionId: string, input: unknown): void {
    const text = (input as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') return;
    const now = Date.now();
    this.seen = [...this.seen.filter((s) => now - s.ts < 60_000), { sessionId, text, ts: now }];
    for (const h of this.held.values()) {
      if (!h.draft.sessionId && h.draft.text === text) {
        h.draft = { ...h.draft, sessionId };
        this.changed();
      }
    }
  }

  /** Hold a draft for you; resolves with what you did (or, after a while, that it's waiting). */
  request(d: { sessionId: string | null; to: SlackTarget; text: string; threadTs?: string; threadLink?: string; files?: SlackAttachment[]; /** false: without Cora's banner */ banner?: boolean }): Promise<DraftOutcome> {
    const sessionId = d.sessionId ?? this.seen.filter((s) => s.text === d.text).pop()?.sessionId ?? null;
    const draft: SlackDraft = { id: randomUUID(), sessionId, to: d.to, text: d.text, ...(d.threadTs ? { threadTs: d.threadTs } : {}), ...(d.threadLink ? { threadLink: d.threadLink } : {}), ...(d.files?.length ? { files: d.files } : {}), ...(d.banner === false ? { banner: false } : {}), createdAt: Date.now(), waiting: true };
    return new Promise((resolve) => {
      const h: Held = { draft, answered: false, answer: (o) => !h.answered && ((h.answered = true), resolve(o)) };
      this.held.set(draft.id, h);
      if (!draft.files?.length && draft.banner !== false && this.o.banner) {
        const b = { sessionId: draft.sessionId, text: draft.text, to: draft.to, reviewed: true };
        this.banners.set(draft.id, this.o.banner(b).catch(() => null));
        // the draft card shows what the banner will say, so you check it with the words
        void this.o.bannerPreview?.(b).then((q) => {
          if (!q || !this.held.has(draft.id)) return;
          h.draft = { ...h.draft, bannerQ: q };
          this.changed();
        }).catch(() => {});
      }
      setTimeout(() => {
        if (h.answered || !this.held.has(draft.id)) return;
        h.draft = { ...h.draft, waiting: false };
        h.answer({ sent: false, why: 'waiting' });
        this.changed();
      }, this.o.waitMs ?? DRAFT_WAIT_MS);
      this.changed();
    });
  }

  /** Your answer. Sending posts it (and drops the draft); a failed send keeps it, with the error. */
  async decide(id: string, a: SlackAction): Promise<{ ok: boolean; error?: string; link?: string; url?: string }> {
    const h = this.held.get(id);
    if (!h) return { ok: false, error: 'not found (already answered)' };
    const text = (a.text ?? h.draft.text).trim();
    const to = a.to ?? h.draft.to;
    if (a.action === 'discard' || a.action === 'opened') {
      // taken to Slack: where to open it (the person's DM may need opening first)
      const url = a.action === 'opened' ? await this.o.slack.webUrl(to, h.draft.threadTs).catch(() => undefined) : undefined;
      this.held.delete(id);
      this.banners.delete(id);
      h.answer({ sent: false, why: a.action === 'discard' ? 'discarded' : 'opened', text, to });
      this.changed();
      return { ok: true, ...(url ? { url } : {}) };
    }
    if (!text) return { ok: false, error: 'the message is empty' };
    try {
      // Cora's banner on top, unless you unticked it (a message with files has none: Slack shows them its own way); made
      // as the draft came, again if you changed its words (it may show its first line)
      const banner = !h.draft.files?.length && (a.banner ?? h.draft.banner) !== false && this.o.banner ? await ((text === h.draft.text.trim() && to.id === h.draft.to.id && this.banners.get(id)) || this.o.banner({ sessionId: h.draft.sessionId, text, to, reviewed: true })).catch(() => null) : null;
      const r = h.draft.files?.length ? await this.o.slack.postFiles(to, this.signed(text), h.draft.files, h.draft.threadTs) : await this.o.slack.post(to, text, h.draft.threadTs, { footer: await this.footer(h.draft.sessionId), banner });
      this.held.delete(id);
      this.banners.delete(id);
      h.answer({ sent: true, link: r.link, text, to, edited: text !== h.draft.text.trim() || to.id !== h.draft.to.id });
      this.changed();
      return { ok: true, link: r.link };
    } catch (e) {
      return { ok: false, error: e instanceof SlackError ? e.code : (e as Error).message };
    }
  }
}
