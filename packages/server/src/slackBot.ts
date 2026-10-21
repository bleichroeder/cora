import { firstSentence, inQuiet, summarizeTool, toMrkdwn, type Approval, type BrainEvent, type PendingDecision, type PendingRequest, type SlackBotSettings, type SlackBotStatus, type SlackDraft, SLACK_DM_MARK } from '@cora/shared';
import type { Slack } from './slack';

/**
 * Cora's own Slack bot. While you're away it DMs you as
 * itself: prompts a session is waiting on (with Allow / Deny), failures, tickets assigned to you, and a digest of
 * finished sessions. What you write in that DM goes to Cora's agent, and its reply comes back. Only your own clicks
 * and messages in that DM count.
 *
 * Whatever waits for your OK can be answered from here while you're away: a session's permission prompt (Allow /
 * Deny), a Slack message a session drafted (Send / Discard), and Cora's own cards (Yes / No, or its options). What was
 * already waiting when you left comes here then. Handing Cora control (Away in its console) counts as away.
 */

export type BotAlert = { kind: 'failure' | 'ticket' | 'finished' | 'mail'; text: string; /** sent once (a pipeline, a ticket) */ key?: string };

export type CoraBotDeps = {
  slack: Slack;
  settings(): SlackBotSettings;
  pending: { list(): PendingRequest[]; resolve(id: string, d: PendingDecision): { ok: boolean; error?: string }; extend(id: string, ms: number): boolean };
  nameOf(sessionId: string): string;
  /** your answer to one of Cora's cards (in its console), from a button here; `text`: the option you picked */
  approve?(id: string, ok: boolean, text?: string): Promise<{ ok: boolean; error?: string; result?: string }>;
  /** Cora's cards waiting for your OK */
  cards?(): Approval[];
  /** Slack messages sessions drafted, waiting for your OK */
  drafts?(): SlackDraft[];
  /** your Send or Discard on one, from a button here */
  draft?(id: string, send: boolean): Promise<{ ok: boolean; error?: string; link?: string }>;
  /** you handed Cora control (Away in its console): you're away, whatever the PC says */
  handedOff?(): boolean;
  /** your words to Cora's agent (null: Cora's agent is off) */
  say?(text: string): { ok: boolean; error?: string } | null;
  onChange?(): void;
  now?: () => number;
  log?(m: string): void;
};

/** Pings close together go out as one message. */
export const COALESCE_MS = 20_000;
export const DIGEST_MS = 30 * 60_000;
/** A prompt that went to your phone is held this long (Claude Code waits up to an hour for the hook). */
export const AWAY_HOLD_MS = 55 * 60_000;
/** The desktop app reports presence every 30 s; older than this, Cora doesn't know (so it doesn't think you're away). */
const PRESENCE_STALE_MS = 3 * 60_000;
const REPLY_WAIT_MS = 10 * 60_000;
/** Cora's opening line goes out on its own when the rest takes longer than this. */
export const EARLY_MS = 3000;
/** A draft older than this (kept across restarts) isn't news when you leave: it stays in Cora. */
const DRAFT_NEWS_MS = 24 * 3_600_000;

type Posted = { channel: string; ts: string; head: string; answered?: boolean };
/** what you wrote in the DM, while Cora works on it: your message, what it has said so far, its "on it" message */
type Awaiting = { since: number; parts: string[]; channel: string; ts: string; early?: Promise<{ channel: string; ts: string } | null>; timer?: NodeJS.Timeout };

export class CoraBot {
  private presence: { idle: number; locked: boolean; at: number } | null = null;
  private awaySince: number | null = null;
  private pings: string[] = [];
  private pingTimer: NodeJS.Timeout | null = null;
  private digest: string[] = [];
  private digestTimer: NodeJS.Timeout | null = null;
  private sent = { day: '', n: 0 };
  private keys = new Set<string>();
  private prompts = new Map<string, Posted>();
  /** Cora's questions sent here (by their card's id), and the options of those that have them */
  private questions = new Map<string, Posted>();
  private options = new Map<string, string[]>();
  private seenCards = new Set<string>();
  /** drafts sent here (by id) */
  private draftMsgs = new Map<string, Posted>();
  private seenDrafts = new Set<string>();
  private seenPending = new Set<string>();
  private wasAway = false;
  private heard = new Set<string>();
  private awaiting: Awaiting | null = null;
  private error: string | undefined;

  constructor(private d: CoraBotDeps) {}

  private now = () => this.d.now?.() ?? Date.now();
  private cfg = () => this.d.settings();
  connected = () => !!this.d.slack.botInfo() && this.d.slack.status().connected;

  status(): SlackBotStatus {
    const b = this.d.slack.botInfo();
    return { connected: this.connected(), ...(b ? { name: b.name } : {}), ...(this.error ? { error: this.error } : {}), away: this.away(), ...(this.awaySince ? { awaySince: this.awaySince } : {}), sentToday: this.today(), quiet: inQuiet(this.cfg().quiet, new Date(this.now())) };
  }

  // ---------------------------------------------------------------- presence
  /** The desktop app: how long since the last key or mouse move, and whether the screen is locked. */
  report(p: { idle: number; locked: boolean }): void {
    this.presence = { idle: Math.max(0, p.idle), locked: !!p.locked, at: this.now() };
    this.refresh();
  }
  /**
   * Did away change (the PC's presence, or you handed Cora control)? Gone: what's waiting for your OK comes here.
   * Back: nothing more goes out, and a digest waiting isn't news any more.
   */
  refresh(): void {
    const is = this.away();
    if (is === this.wasAway) return;
    this.wasAway = is;
    if (is) {
      this.awaySince = this.now();
      void this.catchUp();
    } else {
      this.awaySince = null;
      this.digest = [];
      if (this.digestTimer) clearTimeout(this.digestTimer);
      this.digestTimer = null;
    }
    this.d.onChange?.();
  }
  /** You just left: whatever is waiting for your OK comes to your phone. */
  async catchUp(): Promise<void> {
    await this.pendingChanged(this.d.pending.list());
    await this.draftsChanged();
    await this.cardsChanged();
  }
  away(): boolean {
    if (this.d.handedOff?.()) return true;
    const p = this.presence;
    if (!p || this.now() - p.at > PRESENCE_STALE_MS) return false;
    return p.locked || p.idle >= this.cfg().awayMinutes * 60;
  }

  private today(): number {
    const day = new Date(this.now()).toDateString();
    if (this.sent.day !== day) this.sent = { day, n: 0 };
    return this.sent.n;
  }
  /** Alerts may go out now: on, connected, you're away, not quiet hours, under the day's cap. */
  private mayAlert(): boolean {
    const c = this.cfg();
    return c.alerts && this.connected() && this.away() && !inQuiet(c.quiet, new Date(this.now())) && this.today() < c.dailyCap;
  }
  private async post(text: string, blocks?: unknown[]): Promise<{ channel: string; ts: string } | null> {
    try {
      const r = await this.d.slack.postAsCora(text, blocks);
      this.today();
      this.sent.n++;
      if (this.error) (this.error = undefined), this.d.onChange?.();
      return r;
    } catch (e) {
      this.error = (e as { code?: string }).code ?? (e as Error).message;
      this.d.log?.(`cora bot: ${this.error}`);
      this.d.onChange?.();
      return null;
    }
  }

  // ---------------------------------------------------------------- alerts
  /** Something worth telling you while you're away (each kind as its settings say). */
  alert(a: BotAlert): void {
    if (a.key) {
      if (this.keys.has(a.key)) return;
      if (this.keys.size > 500) this.keys.clear();
    }
    if (!this.mayAlert()) return;
    const c = this.cfg();
    const ping = a.kind === 'failure' ? c.ping.failures : a.kind === 'ticket' ? c.ping.tickets : a.kind === 'mail' ? c.ping.mail !== false : c.finished === 'ping';
    const digest = a.kind === 'finished' && c.finished === 'digest';
    if (!ping && !digest) return;
    if (a.key) this.keys.add(a.key);
    if (digest) {
      this.digest.push(a.text);
      this.digestTimer ??= setTimeout(() => void this.flushDigest(), DIGEST_MS);
      return;
    }
    this.pings.push(a.text);
    this.pingTimer ??= setTimeout(() => void this.flushPings(), COALESCE_MS);
  }
  async flushPings(): Promise<void> {
    this.pingTimer = null;
    const lines = this.pings.splice(0);
    if (!lines.length || !this.mayAlert()) return;
    await this.post(lines.length === 1 ? lines[0] : `While you're away:\n${lines.map((l) => `• ${l}`).join('\n')}`);
  }
  async flushDigest(): Promise<void> {
    this.digestTimer = null;
    const lines = this.digest.splice(0);
    if (!lines.length || !this.mayAlert()) return;
    await this.post(`Finished while you're away:\n${lines.map((l) => `• ${l}`).join('\n')}`);
  }

  // ---------------------------------------------------------------- prompts, with buttons
  /** The prompts sessions are waiting on changed: new ones go to your phone (held longer), answered ones say so. */
  async pendingChanged(list: PendingRequest[]): Promise<void> {
    const ids = new Set(list.map((p) => p.id));
    for (const p of list) {
      if (this.seenPending.has(p.id)) continue;
      if (p.kind === 'elicitation') {
        this.seenPending.add(p.id);
        continue;
      }
      // not now (you're here, or quiet hours): it comes if it's still waiting when you leave
      if (!this.cfg().ping.prompts || !this.mayAlert()) continue;
      this.seenPending.add(p.id);
      this.d.pending.extend(p.id, AWAY_HOLD_MS);
      const msg = promptMessage(p, this.d.nameOf(p.sessionId));
      const r = await this.post(msg.text, msg.blocks);
      if (r) this.prompts.set(p.id, { ...r, head: msg.head });
    }
    // answered at the PC (or in the terminal), or gone: the message says so
    for (const [id, m] of this.prompts) {
      if (ids.has(id)) continue;
      this.prompts.delete(id);
      if (!m.answered) await this.d.slack.updateAsCora(m.channel, m.ts, `${m.head}: answered at your PC`, [section(`${m.head}\n_Answered at your PC (or the session moved on)._`)]).catch(() => {});
    }
    for (const id of this.seenPending) if (!ids.has(id) && !this.prompts.has(id)) this.seenPending.delete(id);
  }

  /**
   * A question from Cora while you're away (an email you were waiting for came: start on it?), with Yes and No. Your
   * answer is the same as on its card in Cora's console. Goes out whether or not alerts are on: you set the watch.
   */
  async askOnPhone(id: string, text: string): Promise<void> {
    if (this.seenCards.has(id) || !this.connected() || inQuiet(this.cfg().quiet, new Date(this.now())) || this.today() >= this.cfg().dailyCap) return;
    this.seenCards.add(id);
    const head = text.split('\n')[0];
    const r = await this.post(text.slice(0, 2900), [
      section(toMrkdwn(text).slice(0, 2900)),
      { type: 'actions', elements: [btn('Yes', 'cora_yes', id, 'primary'), btn('No', 'cora_no', id)] },
    ]);
    if (r) this.questions.set(id, { ...r, head });
  }

  /**
   * Cora's cards changed: new ones go to your phone while you're away (with Yes / No, or its options), and one you
   * answered in Cora says so here.
   */
  async cardsChanged(): Promise<void> {
    if (!this.d.cards) return;
    const list = this.d.cards();
    const ids = new Set(list.map((a) => a.id));
    for (const a of list) {
      if (this.seenCards.has(a.id) || !this.cfg().ping.prompts || !this.mayAlert()) continue;
      this.seenCards.add(a.id);
      const msg = cardMessage(a);
      if (a.kind === 'ask' && a.options?.length) this.options.set(a.id, a.options);
      const r = await this.post(msg.text, msg.blocks);
      if (r) this.questions.set(a.id, { ...r, head: msg.head });
    }
    for (const [id, m] of this.questions) {
      if (ids.has(id)) continue;
      this.questions.delete(id);
      this.options.delete(id);
      if (!m.answered) await this.d.slack.updateAsCora(m.channel, m.ts, `${m.head}: answered in Cora`, [section(`${m.head}\n_Answered in Cora._`)]).catch(() => {});
    }
    for (const id of this.seenCards) if (!ids.has(id) && !this.questions.has(id)) this.seenCards.delete(id);
  }

  /** Slack messages sessions drafted: new ones go to your phone while you're away (Send / Discard). */
  async draftsChanged(): Promise<void> {
    if (!this.d.drafts) return;
    const list = this.d.drafts();
    const ids = new Set(list.map((d) => d.id));
    for (const d of list) {
      if (this.seenDrafts.has(d.id) || this.now() - d.createdAt > DRAFT_NEWS_MS || !this.cfg().ping.prompts || !this.mayAlert()) continue;
      this.seenDrafts.add(d.id);
      const msg = draftMessage(d, d.sessionId ? this.d.nameOf(d.sessionId) : 'A session');
      const r = await this.post(msg.text, msg.blocks);
      if (r) this.draftMsgs.set(d.id, { ...r, head: msg.head });
    }
    for (const [id, m] of this.draftMsgs) {
      if (ids.has(id)) continue;
      this.draftMsgs.delete(id);
      if (!m.answered) await this.d.slack.updateAsCora(m.channel, m.ts, `${m.head}: answered in Cora`, [section(`${m.head}\n_Answered in Cora._`)]).catch(() => {});
    }
    for (const id of this.seenDrafts) if (!ids.has(id) && !this.draftMsgs.has(id)) this.seenDrafts.delete(id);
  }

  /** A button in one of Cora's messages (Socket Mode's interactive envelope). Only your clicks count. */
  async interactive(payload: any): Promise<void> {
    if (payload?.type !== 'block_actions') return;
    const me = this.d.slack.status();
    if (!me.connected || payload.user?.id !== me.userId) return;
    const a = payload.actions?.[0];
    if (a && ['cora_yes', 'cora_no'].includes(a.action_id)) return this.answer(payload, String(a.value ?? ''), a.action_id === 'cora_yes');
    if (a?.action_id === 'cora_pick') {
      const [id, i] = String(a.value ?? '').split('#');
      return this.answer(payload, id, true, this.options.get(id)?.[Number(i)]);
    }
    if (a && ['cora_send', 'cora_discard'].includes(a.action_id)) return this.sendDraft(payload, String(a.value ?? ''), a.action_id === 'cora_send');
    if (!a || !['cora_allow', 'cora_deny'].includes(a.action_id)) return;
    const id = String(a.value ?? '');
    const m = this.prompts.get(id);
    const channel = String(payload.channel?.id ?? m?.channel ?? '');
    const ts = String(payload.message?.ts ?? m?.ts ?? '');
    const head = m?.head ?? 'That prompt';
    const allow = a.action_id === 'cora_allow';
    const r = this.d.pending.resolve(id, { decision: allow ? 'allow' : 'deny', ...(allow ? {} : { message: 'Denied from Slack' }) });
    if (m) m.answered = true;
    const note = r.ok ? (allow ? '✅ Allowed from Slack' : '⛔ Denied from Slack') : '_That prompt is gone: answered elsewhere, or the session moved on._';
    if (channel && ts) await this.d.slack.updateAsCora(channel, ts, `${head}: ${r.ok ? (allow ? 'allowed' : 'denied') : 'gone'}`, [section(`${head}\n${note}`)]).catch(() => {});
  }

  /** Your Yes or No (or the option you picked) to one of Cora's cards: runs as on its card; the message says what happened. */
  private async answer(payload: any, id: string, yes: boolean, pick?: string): Promise<void> {
    const q = this.questions.get(id);
    const channel = String(payload.channel?.id ?? q?.channel ?? '');
    const ts = String(payload.message?.ts ?? q?.ts ?? '');
    const head = q?.head ?? 'That question';
    if (q) q.answered = true;
    const r = this.d.approve ? await this.d.approve(id, yes, pick) : { ok: false, error: 'Cora is off' };
    this.questions.delete(id);
    this.options.delete(id);
    const note = !r.ok ? `_${r.error === 'not found (already answered)' ? 'Already answered (in Cora, or here).' : `Couldn't: ${r.error}`}_` : pick !== undefined ? `✅ You answered: ${pick}` : yes ? `✅ ${r.result ?? 'Done'}` : '⛔ No';
    if (channel && ts) await this.d.slack.updateAsCora(channel, ts, `${head}: ${r.ok ? (yes ? 'yes' : 'no') : 'gone'}`, [section(`${head}\n${note}`)]).catch(() => {});
  }

  /** Your Send or Discard on a session's draft: as in Cora's outbox; the message says what happened. */
  private async sendDraft(payload: any, id: string, send: boolean): Promise<void> {
    const m = this.draftMsgs.get(id);
    const channel = String(payload.channel?.id ?? m?.channel ?? '');
    const ts = String(payload.message?.ts ?? m?.ts ?? '');
    const head = m?.head ?? 'That message';
    if (m) m.answered = true;
    const r = this.d.draft ? await this.d.draft(id, send) : { ok: false, error: 'Slack is off' };
    if (r.ok) this.draftMsgs.delete(id);
    else if (m) m.answered = false;
    const note = !r.ok ? `_${r.error === 'not found (already answered)' ? 'Already answered (in Cora, or here).' : `Couldn't: ${r.error}`}_` : send ? `✅ Sent${'link' in r && r.link ? `: ${r.link}` : ''}` : '🗑 Discarded';
    if (channel && ts) await this.d.slack.updateAsCora(channel, ts, `${head}: ${r.ok ? (send ? 'sent' : 'discarded') : 'not sent'}`, [section(`${head}\n${note}`)]).catch(() => {});
  }

  // ---------------------------------------------------------------- your Cora DM: instructions, and Cora's reply
  /** Is this message yours, in the Cora DM? (Anything else in Slack is never an instruction.) */
  async isMine(ev: any): Promise<boolean> {
    const b = this.d.slack.botInfo();
    const me = this.d.slack.status();
    if (!b || !me.connected || ev?.type !== 'message' || ev.bot_id || (ev.subtype && ev.subtype !== 'file_share')) return false;
    if (ev.user !== me.userId || !(ev.channel_type === 'im' || String(ev.channel ?? '').startsWith('D'))) return false;
    const dm = await this.d.slack.botDm().catch(() => null);
    return !!dm && String(ev.channel) === dm;
  }
  /** A message in the Cora DM (it may arrive twice: as your event and the bot's). */
  async incoming(ev: any): Promise<void> {
    if (!(await this.isMine(ev))) return;
    const ts = String(ev.ts);
    if (this.heard.has(ts)) return;
    this.heard.add(ts);
    if (this.heard.size > 200) this.heard.delete(this.heard.values().next().value!);
    const text = String(ev.text ?? '').trim();
    if (!text) return;
    if (!this.cfg().instructions) return void (await this.post("Taking instructions here is off (Cora's Settings → Slack → Cora's own bot)."));
    const r = this.d.say?.(`${SLACK_DM_MARK} on their phone: open with one short sentence saying what you'll do, then do it; reply briefly; your reply is sent back there] ${text}`);
    if (!r) return void (await this.post("Cora's agent is off, so I can't act on that. (Settings → Cora Orchestrator.)"));
    if (!r.ok) return void (await this.post(`I couldn't pass that on: ${r.error ?? 'Cora is busy'}`));
    if (this.awaiting) this.drop(this.awaiting);
    this.awaiting = { since: this.now(), parts: [], channel: String(ev.channel), ts };
    // seen: at once, so there's no silence while it works
    void this.react(String(ev.channel), ts, 'eyes');
  }

  /**
   * Cora's agent's events, after a message from the DM. Its first words (what it'll do) go back on their own when the
   * rest takes a while, and that message becomes the whole reply when its turn ends (one ping, not two).
   */
  agentEvent(e: BrainEvent): void {
    const w = this.awaiting;
    if (!w || e.ts < w.since - 1000 || e.agentId !== 'main') return;
    if (this.now() - w.since > REPLY_WAIT_MS) return void this.drop(w);
    if (e.kind === 'say' && e.text) {
      w.parts.push(e.text);
      if (w.parts.length === 1) w.timer = setTimeout(() => void this.sayEarly(w), EARLY_MS);
    }
    if (e.kind === 'turn_end' && w.parts.length) {
      this.drop(w);
      void this.finish(w);
    }
  }
  private drop(w: Awaiting): void {
    if (w.timer) clearTimeout(w.timer);
    if (this.awaiting === w) this.awaiting = null;
  }
  /** Its opening line, while it works on the rest. */
  private async sayEarly(w: Awaiting): Promise<void> {
    if (this.awaiting !== w) return;
    const first = firstSentence(clean(w.parts[0] ?? ''));
    if (!first) return;
    w.early = this.post(first, [section(`${toMrkdwn(first)} _…_`)]);
  }
  private async finish(w: Awaiting): Promise<void> {
    const text = clean(w.parts.join('\n\n'));
    if (text) {
      const body = text.slice(0, 2900);
      const blocks = [section(toMrkdwn(text).slice(0, 2900))];
      const early = await w.early;
      const edited = early ? await this.d.slack.updateAsCora(early.channel, early.ts, body, blocks).then(() => true, () => false) : false;
      if (!edited) await this.post(body, blocks);
    }
    // done: 👀 becomes ✅
    await this.react(w.channel, w.ts, 'eyes', true);
    await this.react(w.channel, w.ts, 'white_check_mark');
  }
  /** A reaction on your message (a bot without the reactions permission just doesn't react). */
  private async react(channel: string, ts: string, name: string, remove = false): Promise<void> {
    await this.d.slack.reactAsCora(channel, ts, name, remove).catch((e) => this.d.log?.(`cora bot: reaction ${name}: ${(e as { code?: string }).code ?? (e as Error).message}`));
  }

  /** Cora's tool: a DM from Cora (you asked to be told something on your phone). Goes out whether you're away or not. */
  async dm(text: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.connected()) return { ok: false, error: "Cora's own Slack bot isn't set up (Settings → Slack → Cora's own bot)." };
    if (this.today() >= this.cfg().dailyCap) return { ok: false, error: "today's cap of Cora DMs is reached" };
    const r = await this.post(text.slice(0, 2900), [section(toMrkdwn(text).slice(0, 2900))]);
    return r ? { ok: true } : { ok: false, error: this.error ?? 'Slack refused it' };
  }

  /** Settings' test button. */
  test(): Promise<{ ok: boolean; error?: string }> {
    return this.dm("Hi, it's Cora. This is where I'll message you while you're away, with buttons for prompts. Write here to give me instructions.");
  }

  stop(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    if (this.digestTimer) clearTimeout(this.digestTimer);
    if (this.awaiting) this.drop(this.awaiting);
  }
}

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2990) } });
const btn = (text: string, action: string, value: string, style?: 'primary' | 'danger') => ({ type: 'button', action_id: action, ...(style ? { style } : {}), text: { type: 'plain_text', text }, value });

/** A prompt as a message: who wants what, and Allow / Deny (a question: answer it at your PC or in the Claude app). */
export function promptMessage(p: PendingRequest, who: string): { head: string; text: string; blocks: unknown[] } {
  const s = summarizeTool(p.toolName, p.toolInput);
  const input = p.toolInput as { command?: string; question?: string; questions?: Array<{ question?: string }> } | null;
  if (p.kind === 'question') {
    const q = input?.questions?.[0]?.question ?? input?.question ?? s.summary;
    const head = `*${who}* asks you`;
    return { head, text: `${who} asks you: ${q}`, blocks: [section(`${head}\n>${String(q).slice(0, 1500)}\n_Answer it in Cora, or in the Claude app (Remote Control)._`)] };
  }
  const what = input?.command ? String(input.command) : s.summary || p.toolName;
  const head = `*${who}* wants to use *${p.toolName}*`;
  return {
    head,
    text: `${who} wants to use ${p.toolName}: ${what.slice(0, 200)}`,
    blocks: [
      section(`${head}\n\`\`\`${what.slice(0, 1500).replace(/```/g, "'''")}\`\`\``),
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'cora_allow', style: 'primary', text: { type: 'plain_text', text: 'Allow' }, value: p.id },
          { type: 'button', action_id: 'cora_deny', style: 'danger', text: { type: 'plain_text', text: 'Deny' }, value: p.id },
        ],
      },
    ],
  };
}

/** One of Cora's cards as a message: what it wants to do, and Yes / No (a question: its options, or answer in Cora). */
export function cardMessage(a: Approval): { head: string; text: string; blocks: unknown[] } {
  const head = a.kind === 'ask' ? `*Cora* asks you: ${a.title}` : `*Cora* wants to: ${a.title}`;
  const quoted = a.text ? `>${a.text.slice(0, 1200).replace(/\n/g, '\n>')}` : '';
  const body = [a.kind === 'ask' ? '' : a.detail, quoted].filter(Boolean).join('\n');
  const text = `${head.replace(/\*/g, '')}${a.text ? `: ${a.text.slice(0, 200)}` : ''}`;
  if (a.kind === 'ask') {
    const picks = (a.options ?? []).map((o, i) => btn(o.slice(0, 70), 'cora_pick', `${a.id}#${i}`, i === 0 ? 'primary' : undefined));
    const how = picks.length ? '' : '\n_Answer it in Cora, or write your answer here and Cora will hear it._';
    return { head, text, blocks: [section(`${head}${body ? `\n${body}` : ''}${how}`), ...(picks.length ? [{ type: 'actions', elements: picks }] : [])] };
  }
  return { head, text, blocks: [section(`${head}\n${body}`), { type: 'actions', elements: [btn('Yes', 'cora_yes', a.id, 'primary'), btn('No', 'cora_no', a.id)] }] };
}

/** A session's Slack draft as a message: to whom, what, and Send / Discard (to change it first: in Cora). */
export function draftMessage(d: SlackDraft, who: string): { head: string; text: string; blocks: unknown[] } {
  const head = `*${who}* wants to send a Slack message to *${d.to.label}*${d.threadTs ? ' (in a thread)' : ''}`;
  const files = d.files?.length ? `\n_with ${d.files.length === 1 ? d.files[0].name : `${d.files.length} files`}_` : '';
  return {
    head,
    text: `${who} wants to send ${d.to.label}: ${d.text.slice(0, 200)}`,
    blocks: [
      section(`${head}\n>${d.text.slice(0, 2000).replace(/\n/g, '\n>')}${files}\n_To change it first: in Cora's Slack outbox._`),
      { type: 'actions', elements: [btn('Send', 'cora_send', d.id, 'primary'), btn('Discard', 'cora_discard', d.id, 'danger')] },
    ],
  };
}

/** Cora's reply without what's for the dashboard: explains, spoken lines, other HTML comments. */
export const clean = (t: string) =>
  t
    .replace(/<!--\s*cora:explain[\s\S]*?<!--\s*\/cora:explain\s*-->/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
