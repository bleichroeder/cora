import { findRefs, type CalEvent, type JournalEntry } from '@cora/shared';
import type { Drafts } from './drafts';
import type { Journal } from './journal';
import type { Notes } from './notes';
import { withWhom } from './calendar';

/**
 * A call's prep, from the Notes templates: a standup gets the
 * Standup template, drafted from your work since the last one; any other call the Meeting template, its context from
 * the week's work and the journal trail of the tickets and merge requests its invite names. The note is titled
 * `Prep · <title> · <date>` (a standup's keeps its template's title).
 */
export type PrepDeps = { notes: Notes; drafts: Drafts; journal: Journal; projects(): string[]; now?: () => number };

const day = (t: number) => new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
const time = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A template by its name (Standup, Meeting), whatever its id. */
function templateNamed(notes: Notes, name: string): string | null {
  const t = notes.list().find((n) => n.kind === 'template' && n.title.toLowerCase() === name.toLowerCase());
  return t?.id ?? null;
}

/** What the journals say about the tickets and merge requests a call's invite names (newest first, any age). */
export function journalTrail(e: CalEvent, journal: Journal, projects: string[], max = 12): JournalEntry[] {
  const refs = findRefs(`${e.title}\n${e.about ?? ''}`, { projects });
  const seen = new Map<string, JournalEntry>();
  for (const ticket of refs.tickets ?? []) for (const x of journal.query({ ticket, limit: 8 })) seen.set(x.id, x);
  for (const mr of refs.mrs ?? []) for (const x of journal.query({ mr, limit: 8 })) seen.set(x.id, x);
  return [...seen.values()].sort((a, b) => b.at - a.at).slice(0, max);
}

export const trailLines = (xs: JournalEntry[]): string[] => xs.map((x) => `- ${day(x.at)}, ${x.session} (${x.repo})${x.tag ? ` · ${x.tag}` : ''}: ${clip(x.text.replace(/\s+/g, ' '), 400)}`);

export async function draftPrep(e: CalEvent, d: PrepDeps): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const now = d.now?.() ?? Date.now();
  const name = e.standup ? 'Standup' : 'Meeting';
  const tpl = templateNamed(d.notes, name);
  if (!tpl) return { ok: false, error: `There's no ${name} template in Notes (Edit templates… › Restore the starters).` };
  const since = e.standup ? (d.notes.lastFrom(tpl) ?? now - 86_400_000) : now - 7 * 86_400_000;
  const w = { since, until: now };
  const facts = await d.drafts.facts(w);
  const trail = e.standup ? [] : journalTrail(e, d.journal, d.projects());
  const call = [
    `## The call these notes are for`,
    `- "${e.title}", ${day(e.start)} at ${time(e.start)}${withWhom(e) ? `, with ${withWhom(e)}` : ''}`,
    ...(e.about ? [`- The invite says: ${clip(e.about.replace(/\s+/g, ' '), 800)}`] : []),
    ...(trail.length ? ['', '## Journal entries about what the invite names', ...trailLines(trail)] : []),
  ].join('\n');
  if (!facts.counts.sessions && !facts.counts.jots && !facts.counts.jira && !facts.counts.deploys && !trail.length) return { ok: false, error: 'Cora saw nothing to prepare from (no work in that window).' };
  const asks = e.standup ? undefined : `Prep for the call "${clip(e.title, 120)}": write Context about what is relevant to this call (its people, what its invite names); leave out unrelated work.`;
  const r = await d.drafts.write(d.notes.template(tpl).body, { ...facts, text: `${call}\n\n${facts.text}` }, new Date(now), asks);
  if (!r.ok) return r;
  const id = d.notes.fromTemplate(tpl, { keepHints: true });
  d.notes.setDraft(id, r.text, { template: tpl, since, until: now, repos: facts.repos.map((x) => x.repo), read: `${facts.counts.sessions} sessions${trail.length ? ` · ${trail.length} journal entries` : ''}`, at: now, ...(asks ? { asks } : {}) });
  if (!e.standup) d.notes.rename(id, `Prep · ${clip(e.title, 80)} · ${day(e.start)}`);
  return { ok: true, id };
}
