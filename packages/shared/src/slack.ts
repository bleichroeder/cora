/**
 * Slack for Cora: sessions draft messages (Cora's MCP tools), you confirm each one in the dashboard, and it's posted
 * as you with your own Slack app's user token. These are the shapes the server and the UI share, and the pure helpers.
 */

/** How the user's own words to Cora from its Slack DM begin (they're away: its answer goes back there, not out loud). */
export const SLACK_DM_MARK = '[Slack · the user, from their Cora DM';
/** The user's words to Cora without the note of where they came from (spoken, or its Slack DM) in front. */
export const bareWords = (text: string) => text.replace(/^\s*\[(?:Spoken|Slack)\b[^\n]*?\]\s*/, '');
/** Every Slack tool Cora's /mcp offers (without the mcp__cora__ prefix). */
export const SLACK_TOOLS = ['slack_find', 'slack_read', 'slack_send', 'slack_search', 'slack_inbox', 'slack_watch', 'slack_allow'] as const;
export const SLACK_FIND_TOOL = 'mcp__cora__slack_find';
export const SLACK_READ_TOOL = 'mcp__cora__slack_read';
export const SLACK_SEND_TOOL = 'mcp__cora__slack_send';
/** Header on a hosted session's MCP calls naming the session (so a draft shows whose it is). */
export const SESSION_HEADER = 'x-cora-session';

export type SlackStatus =
  | { connected: false; error?: string }
  | {
      connected: true;
      team: string;
      teamId: string;
      user: string;
      userId: string;
      url: string;
      /** the app can search (DMs and mentions in briefs, a ticket's threads); unknown until checked */
      search?: boolean;
      /** live events (Socket Mode, with the app-level token): threads sessions watch hear replies at once */
      live?: 'off' | 'connecting' | 'live' | 'error';
      liveError?: string;
      /** threads being watched for a reply */
      watching?: number;
      /** which: Settings › Slack lists them, and stops one */
      watches?: SlackThreadWatch[];
    };

/** A thread a session (or Cora) watches for someone's reply. */
export type SlackThreadWatch = { id: string; sessionId: string; where: string; about?: string; until: number };

/** Who a message goes to: a channel, a person (their DM) or a group DM. `id` is the channel or user id. */
export type SlackTarget = { kind: 'channel' | 'person' | 'group'; id: string; label: string; detail?: string };

/** A message a session wants to send, waiting for you in the dashboard. */
/** A file going with a message (on its draft and sent card). */
export type SlackAttachment = { name: string; path: string; size: number; image: boolean };
/** How many files a message may carry, and how big each. */
export const ATTACH_MAX = 10;
export const ATTACH_BYTES = 20 * 1024 * 1024;

export type SlackDraft = {
  id: string;
  /** files that go with it */
  files?: SlackAttachment[];
  /** the session that asked (null when it can't be told: a session started before Cora knew to say) */
  sessionId: string | null;
  to: SlackTarget;
  text: string;
  /** a reply in a thread: the thread's first message, and a link to it */
  threadTs?: string;
  threadLink?: string;
  createdAt: number;
  /** the session is still waiting for the answer (after a while it's told the draft is waiting here) */
  waiting: boolean;
};

/** How long a message Cora sent straight away (because you asked) can be taken back. */
export const UNDO_MS = 15_000;

/** A message Cora sent straight away because you asked for it: it can be undone (deleted) until `until`. */
export type SlackSent = {
  id: string;
  to: SlackTarget;
  text: string;
  link: string;
  at: number;
  until: number;
  /** sent on Cora's own, in a conversation you let it carry on (its channel, to stop that) */
  own?: string;
  /** files that went with it (Undo takes them back too) */
  files?: SlackAttachment[];
};

/** A conversation you let Cora carry on by itself: its messages there go out without asking, until you stop it. */
export type SlackGrant = { channel: string; label: string; about?: string; at: number; until: number };

/** A channel you follow (Cora's Inbox): only what touches you there comes in, and your words for it. */
export type SlackFollow = { id: string; label: string; words: string[] };
export const MAX_FOLLOW = 30;
export const MAX_FOLLOW_WORDS = 20;

/** Someone replied in a thread a session was watching (for its row and a notification). */
export type SlackNotice = { sessionId: string; text: string; detail?: string };

/** Where a ticket key comes up in Slack: per conversation, how often, and its newest message. */
export type SlackTalk = { where: string; channel: string; count: number; link: string; ts: string };

export type SlackMsg = { t: 'slack'; status: SlackStatus; drafts: SlackDraft[]; sent?: SlackSent[]; notice?: SlackNotice; grants?: SlackGrant[]; /** Cora's own bot */ bot?: import('./slackBot').SlackBotStatus };

/** Your answer to a draft. 'opened': you took it to Slack to finish yourself. */
export type SlackAction = { action: 'send' | 'discard' | 'opened'; text?: string; to?: SlackTarget };

/** A Slack message link (`https://x.slack.com/archives/C123/p1700000000123456?thread_ts=1700000000.000100`). */
export function parseSlackLink(url: string): { channel: string; ts: string; threadTs?: string } | null {
  const m = /^https:\/\/[\w.-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?(.*))?$/i.exec(url.trim());
  if (!m) return null;
  const ts = `${m[2]}.${m[3]}`;
  const thread = new URLSearchParams(m[4] ?? '').get('thread_ts') ?? undefined;
  return { channel: m[1].toUpperCase(), ts, ...(thread && thread !== ts ? { threadTs: thread } : {}) };
}

/** The web app at a conversation (and a thread in it). */
export function slackWebUrl(teamId: string, channel: string, threadTs?: string): string {
  return `https://app.slack.com/client/${teamId}/${channel}${threadTs ? `/thread/${channel}-${threadTs}` : ''}`;
}

/** Markdown as Claude writes it, as Slack's mrkdwn: **bold**, [text](url), headings, ~~strike~~. Code is left alone. */
export function toMrkdwn(md: string): string {
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => {
      if (i % 2) return part;
      return part
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        .replace(/__(.+?)__/g, '*$1*')
        .replace(/~~(.+?)~~/g, '~$1~')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
    })
    .join('');
}

const norm = (s: string) => s.toLowerCase().replace(/^[#@]/, '').trim();

/**
 * Best matches for a query among names (each item's `names`, best first): exact, then starts-with, then a word
 * starting with it, then contains. Ties keep the given order.
 */
export function rankByName<T extends { names: string[] }>(items: T[], query: string, limit = 8): T[] {
  const q = norm(query);
  if (!q) return [];
  const score = (it: T) => {
    let best = 0;
    for (const raw of it.names) {
      const n = norm(raw);
      if (!n) continue;
      const s = n === q ? 4 : n.startsWith(q) ? 3 : n.split(/[\s._-]+/).some((w) => w.startsWith(q)) ? 2 : n.includes(q) ? 1 : 0;
      best = Math.max(best, s);
    }
    return best;
  };
  return items
    .map((it, i) => ({ it, i, s: score(it) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.it);
}

