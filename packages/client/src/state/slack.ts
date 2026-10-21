import { create } from 'zustand';
import { parseSlackLink, slackWebUrl } from '@cora/shared';
import type { SlackAction, SlackBotStatus, SlackDraft, SlackGrant, SlackMsg, SlackSent, SlackStatus, SlackTalk, SlackTarget } from '@cora/shared';
import { useBrain } from './store';
import { attentive, desktop } from '../lib/desktop';
import { sessionName } from '../lib/format';

/** Slack: connected or not, and the messages sessions want sent, waiting for you (from the server). */
type SlackState = {
  status: SlackStatus;
  drafts: SlackDraft[];
  manifest: object | null;
  /** sent at once by Cora (you asked), while they can be undone */
  sent: SlackSent[];
  /** conversations you let Cora carry on by itself */
  grants: SlackGrant[];
  /** Cora's own bot (null: not known yet) */
  bot: SlackBotStatus | null;
};

export const useSlack = create<SlackState>(() => ({ status: { connected: false }, drafts: [], manifest: null, sent: [], grants: [], bot: null }));

/** The server's update; a new draft while you're elsewhere is a notification. */
export function applySlack(m: SlackMsg): void {
  const before = new Set(useSlack.getState().drafts.map((d) => d.id));
  useSlack.setState({ status: m.status, drafts: m.drafts, sent: m.sent ?? [], grants: m.grants ?? [], ...(m.bot ? { bot: m.bot } : {}) });
  // someone replied in a thread a session watches: its row says so (until you open it), and a notification
  if (m.notice) {
    const n = m.notice;
    const st = useBrain.getState();
    if (st.focus !== n.sessionId || !attentive()) useBrain.setState({ unseen: { ...st.unseen, [n.sessionId]: Date.now() } });
    if (!attentive()) {
      const s = st.sessions[n.sessionId];
      desktop?.notify(`${n.text}${s ? ` · ${sessionName(s)}` : ''}`, n.detail ?? '', n.sessionId);
    }
  }
  for (const d of m.drafts) {
    if (before.has(d.id) || attentive()) continue;
    const s = d.sessionId ? useBrain.getState().sessions[d.sessionId] : undefined;
    desktop?.notify(`Slack message for ${d.to.label}`, `${s ? `${sessionName(s)}: ` : ''}${d.text.slice(0, 200)}`, d.sessionId ?? '');
  }
}

const call = async (url: string, method: string, body?: unknown) => {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, ...j } as { ok: boolean; error?: string } & Record<string, any>;
};

/** Status, drafts and the app manifest (for Settings). */
export async function loadSlack(check = false): Promise<void> {
  const j = await call(`/api/slack${check ? '?check=1' : ''}`, 'GET');
  if (j.ok) useSlack.setState({ status: j.status, drafts: j.drafts, manifest: j.manifest, sent: j.sent ?? [], grants: j.grants ?? [], ...(j.bot ? { bot: j.bot } : {}) });
}

/** Connect with a user token, or (token rotation) a refresh token and the app's Client ID and Secret. */
export async function connectSlack(token: string, rotation?: { clientId: string; clientSecret: string }): Promise<string | null> {
  const j = await call('/api/slack/token', 'POST', { token, ...rotation });
  if (!j.ok) return j.error ?? 'failed';
  useSlack.setState({ status: j.status });
  return null;
}

export async function disconnectSlack(): Promise<void> {
  const j = await call('/api/slack/token', 'DELETE');
  if (j.ok) useSlack.setState({ status: j.status });
}

export async function findSlack(q: string): Promise<SlackTarget[]> {
  if (!q.trim()) return [];
  const j = await call(`/api/slack/find?q=${encodeURIComponent(q)}`, 'GET');
  return j.ok ? (j.results as SlackTarget[]) : [];
}

/** Send (as written or changed), take to Slack, or discard a draft. */
export async function decideDraft(id: string, a: SlackAction): Promise<{ ok: boolean; error?: string; link?: string; url?: string }> {
  return call(`/api/slack/drafts/${encodeURIComponent(id)}`, 'POST', a);
}

/** The app to create at api.slack.com, prefilled from the manifest. */
export const slackAppUrl = (manifest: object) => `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;

/** Take back a message Cora just sent (it's deleted from Slack). */
/** Stop Cora carrying on a conversation by itself (no channel: all of them). */
export async function stopGrant(channel?: string): Promise<void> {
  const j = await call('/api/slack/grants/stop', 'POST', channel ? { channel } : {});
  if (j.ok) useSlack.setState({ grants: j.grants ?? [] });
}

/** Stop watching a thread for a reply (Settings › Slack). */
export async function stopWatch(id: string): Promise<void> {
  const r = await fetch('/api/slack/unwatch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  const j = (await r.json().catch(() => ({}))) as { status?: SlackStatus };
  if (j.status) useSlack.setState({ status: j.status });
}

export async function undoSent(id: string): Promise<string | null> {
  const j = await call(`/api/slack/sent/${encodeURIComponent(id)}/undo`, 'POST');
  return j.ok ? null : (j.error ?? 'failed');
}

/** The app-level token for live events (empty takes it away). */
export async function setAppToken(token: string, rotation?: { clientId: string; clientSecret: string }): Promise<string | null> {
  const j = await call('/api/slack/app-token', 'POST', { token, ...rotation });
  if (j.ok) useSlack.setState({ status: j.status });
  return j.ok ? null : (j.error ?? 'failed');
}

/** Where a ticket comes up in Slack (cached here a few minutes; the server caches too). */
const talkCache = new Map<string, { at: number; talk: SlackTalk[] }>();
export async function ticketTalk(key: string): Promise<SlackTalk[]> {
  const c = talkCache.get(key);
  if (c && Date.now() - c.at < 5 * 60_000) return c.talk;
  const j = await call(`/api/slack/ticket/${encodeURIComponent(key)}`, 'GET');
  const talk = (j.talk as SlackTalk[] | undefined) ?? [];
  talkCache.set(key, { at: Date.now(), talk });
  return talk;
}

/**
 * A Slack message link (https://team.slack.com/archives/…) as the web app's own address for that conversation or
 * thread: the Slack tool is the web app, where a permalink only lands on the workspace's home.
 */
export function slackAppLink(url: string): string {
  const l = parseSlackLink(url);
  const st = useSlack.getState().status;
  return l && st.connected && st.teamId ? slackWebUrl(st.teamId, l.channel, l.threadTs) : url;
}

/** Cora's own bot: its token (xoxb-…; empty takes it away). Null: done; else why not. */
export async function setBotToken(token: string): Promise<string | null> {
  try {
    const r = await fetch('/api/slack/bot-token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return j.error ?? `HTTP ${r.status}`;
    if (j.bot) useSlack.setState({ bot: j.bot });
    return null;
  } catch {
    return "Couldn't reach Cora's server";
  }
}

/** A test DM from Cora's bot. Null: sent; else why not. */
export async function testBot(): Promise<string | null> {
  try {
    const r = await fetch('/api/slack/bot/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const j = await r.json().catch(() => ({}));
    return r.ok ? null : (j.error ?? `HTTP ${r.status}`);
  } catch {
    return "Couldn't reach Cora's server";
  }
}
