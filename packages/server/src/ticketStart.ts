import { coraTicketPrompt, jiraPrompt, type TicketFacts, type TicketStart } from '@cora/shared';
import { listCommands } from './commands';

/**
 * How a session started from a ticket begins (Settings › Jira): the user's own command (their /jira skill, say) or
 * Cora's ticket prompt, which needs no skill and no Jira tool. `auto` uses their /jira when they have one.
 */
export type TicketStartUse = { use: 'command'; command: string } | { use: 'cora' };

const CACHE_MS = 60_000;
let cached: { at: number; claudeDir: string; names: Set<string> } | null = null;

/** The user's own slash commands and skills (theirs and their plugins'), looked at once a minute at most. */
async function userCommands(claudeDir: string, now = Date.now()): Promise<Set<string>> {
  if (cached && cached.claudeDir === claudeDir && now - cached.at < CACHE_MS) return cached.names;
  const names = new Set((await listCommands({ claudeDir }).catch(() => [])).map((c) => c.name.replace(/^\//, '').toLowerCase()));
  cached = { at: now, claudeDir, names };
  return names;
}

export async function resolveTicketStart(s: TicketStart, claudeDir: string, have: (claudeDir: string) => Promise<Set<string>> = userCommands): Promise<TicketStartUse> {
  if (s.with === 'cora') return { use: 'cora' };
  if (s.with === 'command') return { use: 'command', command: s.command };
  // auto: the user's own jira command or skill, when they have one
  return (await have(claudeDir)).has('jira') ? { use: 'command', command: '/jira' } : { use: 'cora' };
}

/** The first prompt for a ticket session: the command, or Cora's prompt from what it knows of the ticket. */
export function ticketFirstPrompt(u: TicketStartUse, t: TicketFacts, auto: boolean): string {
  return u.use === 'command' ? jiraPrompt(t.key, u.command) : coraTicketPrompt(t, auto);
}
