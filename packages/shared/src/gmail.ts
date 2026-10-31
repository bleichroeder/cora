/** Gmail, through the user's own Google app: what the dashboard shows, and what the tools see. */

export type GmailStatus = {
  /** the user's Google app (its JSON) is in place */
  client: boolean;
  /** its Google Cloud project */
  project?: string;
  connected: boolean;
  email?: string;
  /** Cora looks for new mail matching what it watches for (default on) */
  watch: boolean;
  /** what it watches for: your rules (Gmail searches) */
  rules: MailRule[];
  /** also anything Gmail marks important (unread, not promotions/social/updates/forums); default off */
  important: boolean;
  /** Cora may write drafts at all (default off) */
  drafts: boolean;
  /** who its drafts may go to (addresses, or @domains); empty: anyone */
  draftTo: string[];
  /** domains whose mail a watch trusts without Gmail's sender check (internal alert senders that neither sign nor align) */
  trusted: string[];
  /** sessions may ask for an email to be sent: it waits in Cora for your Send (default off) */
  send: boolean;
  /** the emails being waited for (email watches) */
  watches: MailWatch[];
  error?: string;
  lastCheck?: number;
};

/** An email a session asked to send (a draft in your Gmail meanwhile), waiting for you: send it, finish it in Gmail, or discard it. */
export type MailSend = { id: string; sessionId: string | null; /** the session's name */ by: string; to: string; cc?: string; subject: string; body: string; /** the draft in Gmail */ link: string; at: number; /** the session is still waiting for your answer */ waiting: boolean };
export type MailOutboxMsg = { t: 'mailOutbox'; drafts: MailSend[] };

/** Something Cora watches for: a name, and a Gmail search (from:ana@x.com, subject:(outage OR incident) …). */
export type MailRule = { id: string; label: string; query: string };
export const MAX_MAIL_RULES = 20;

/** One message, as a list shows it; `why`: the rule it matched (or "important"), when Cora was watching for it. */
export type MailHit = { id: string; threadId: string; from: string; to: string; subject: string; at: number; snippet: string; labels: string[]; unread: boolean; important: boolean; why?: string };

/** Is this address one of these (an address, or an @domain / domain)? */
export function addressAllowed(address: string, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const a = address.trim().toLowerCase();
  const domain = a.split('@')[1] ?? '';
  return allowed.some((x) => {
    const w = x.trim().toLowerCase();
    if (!w) return false;
    if (w.includes('@') && !w.startsWith('@')) return a === w;
    const d = w.replace(/^@/, '');
    return domain === d || domain.endsWith(`.${d}`);
  });
}

/** The Gmail tools (sessions' and Cora's): read and draft; nothing sends. */
export const GMAIL_TOOLS = ['gmail_inbox', 'gmail_search', 'gmail_read', 'gmail_draft', 'gmail_watch', 'gmail_watches', 'gmail_unwatch'] as const;

/**
 * An email watch: the user is waiting for an email, and said what to do when it comes
 *.
 */
export type MailWatch = {
  id: string;
  /** what it waits for, in a few words (shown to the user) */
  about: string;
  /** the exact thread, or a Gmail search (the sender is added to it) */
  thread?: string;
  query?: string;
  /** the address (or @domain) it must really come from */
  from: string;
  /** one email then done, or that thread's every reply */
  mode: 'once' | 'thread';
  /** the user's instruction: what to do with it */
  then: string;
  /** tell the user; ask before starting; or start */
  act: 'tell' | 'ask' | 'do';
  /** after the work: ask before drafting a reply, or draft it */
  reply: 'ask' | 'draft';
  /** where the work happens: the session that set it, or (set with Cora) a new session in this folder */
  sessionId?: string;
  cwd?: string;
  /** who set it: a session's name, or Cora */
  by: string;
  createdAt: number;
  until: number;
  /** how many emails it has had */
  hits: number;
  lastHit?: number;
};
export const MAIL_WATCH_DAYS = 3;
export const MAIL_WATCH_MAX_DAYS = 14;
export const MAX_MAIL_WATCHES = 30;
