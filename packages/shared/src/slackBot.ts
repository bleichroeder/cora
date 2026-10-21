/**
 * Cora's own Slack bot: Cora DMs you as itself while
 * you're away (its messages ping, its buttons answer prompts), and what you write in that DM goes to Cora. Messaging
 * as you (the user token) is separate and unchanged.
 */

export const FINISHED_MODES = ['ping', 'digest', 'off'] as const;
export type FinishedMode = (typeof FINISHED_MODES)[number];

export type SlackBotSettings = {
  /** Cora messages you as itself while you're away */
  alerts: boolean;
  /** away: no keyboard or mouse this long (minutes), or the screen locked */
  awayMinutes: number;
  /** what pings you at once */
  ping: { prompts: boolean; failures: boolean; tickets: boolean; /** important mail (once Gmail is connected) */ mail: boolean };
  /** sessions that finished: a ping, a digest every 30 minutes, or nothing */
  finished: FinishedMode;
  /** no messages between these times (local, HH:MM) */
  quiet: { on: boolean; from: string; to: string };
  /** what you write in the Cora DM goes to Cora's agent */
  instructions: boolean;
  /** at most this many messages a day */
  dailyCap: number;
};

export const DEFAULT_SLACK_BOT: SlackBotSettings = {
  alerts: true,
  awayMinutes: 10,
  ping: { prompts: true, failures: true, tickets: true, mail: true },
  finished: 'digest',
  quiet: { on: false, from: '22:00', to: '07:00' },
  instructions: true,
  dailyCap: 40,
};

/** The bot as the dashboard sees it. */
export type SlackBotStatus = { connected: boolean; name?: string; error?: string; away: boolean; awaySince?: number; sentToday: number; quiet: boolean };

export const isHHMM = (s: unknown): s is string => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Is a time inside quiet hours (which may cross midnight)? */
export function inQuiet(q: SlackBotSettings['quiet'], at: Date): boolean {
  if (!q.on || !isHHMM(q.from) || !isHHMM(q.to)) return false;
  const m = at.getHours() * 60 + at.getMinutes();
  const [f, t] = [q.from, q.to].map((s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3)));
  return f === t ? false : f < t ? m >= f && m < t : m >= f || m < t;
}

/** Cora's tool: DM the user as Cora on Slack. */
export const CORA_DM_TOOL = 'mcp__cora__cora_dm';
