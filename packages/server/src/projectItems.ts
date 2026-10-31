import { randomBytes } from 'node:crypto';
import { INCIDENT_STATES, MAX_ITEM_NOTES, MAX_ITEMS, SEVERITIES, itemOpen, type ItemKind, type ItemSeverity, type Project, type ProjectItem } from '@cora/shared';

/**
 * A project's items: incidents and known
 * issues, and who may change what. `actor` is a member's session id, 'you' or 'cora'. Each change answers what it did
 * (and whom to tell: a new owner, an owner someone else annotated), or why it can't.
 */

export type ItemResult = { ok: true; item: ProjectItem; /** to tell: who, what */ tell?: { to: string; text: string } } | { ok: false; error: string };

const id = () => randomBytes(4).toString('hex');
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const fail = (error: string): ItemResult => ({ ok: false, error });

/** The lead (or you, or Cora: her tool asks you first unless she may route) runs incidents; with no lead, the opener does. */
function runs(p: Project, actor: string, i?: ProjectItem): boolean {
  if (actor === 'you' || actor === 'cora') return true;
  if (p.lead) return actor === p.lead;
  return !i || i.openedBy === actor;
}
const member = (p: Project, sid: string) => sid === 'you' || p.sessions.includes(sid);
const sev = (s: unknown): ItemSeverity | undefined => (SEVERITIES as readonly string[]).includes(s as string) ? (s as ItemSeverity) : undefined;

export function findItem(p: Project, ref: string): ProjectItem | undefined {
  return p.items?.find((i) => i.id === ref);
}

/** A new item: an incident (the lead's, or with no lead anyone's) or a known issue (anyone proposes; yours is approved). */
export function openItem(p: Project, actor: string, f: { kind?: unknown; title?: unknown; severity?: unknown; owner?: unknown; next?: unknown; link?: unknown; body?: unknown; rule?: unknown }, now: number): ItemResult {
  const kind: ItemKind = f.kind === 'known' ? 'known' : 'incident';
  const title = clip(f.title, 160);
  if (!title) return fail('A title, please (the site or station, and what).');
  if (kind === 'incident' && !runs(p, actor)) return fail(`Only the lead (${p.lead}) opens incidents in this project: post it to the lead instead.`);
  const owner = typeof f.owner === 'string' && f.owner ? f.owner : undefined;
  if (owner && !member(p, owner)) return fail(`${owner} isn't in this project.`);
  const item: ProjectItem = {
    id: id(),
    kind,
    title,
    state: kind === 'known' ? (actor === 'you' ? 'approved' : 'proposed') : owner ? 'working' : 'open',
    ...(kind === 'incident' ? { severity: sev(f.severity) ?? 'medium' } : {}),
    ...(owner ? { owner, ownedAt: now } : {}),
    ...(clip(f.next, 400) ? { next: clip(f.next, 400) } : {}),
    ...(clip(f.link, 500) ? { link: clip(f.link, 500) } : {}),
    ...(kind === 'known' && clip(f.body, 2000) ? { body: clip(f.body, 2000) } : {}),
    ...(kind === 'known' && clip(f.rule, 400) ? { rule: clip(f.rule, 400) } : {}),
    openedBy: actor,
    openedAt: now,
    updatedBy: actor,
    updatedAt: now,
    notes: [],
  };
  p.items = [...(p.items ?? []), item];
  // the log keeps the newest closed ones
  if (p.items.length > MAX_ITEMS) {
    const closed = p.items.filter((i) => !itemOpen(i)).sort((a, b) => (a.closedAt ?? a.updatedAt) - (b.closedAt ?? b.updatedAt));
    const drop = new Set(closed.slice(0, p.items.length - MAX_ITEMS).map((i) => i.id));
    p.items = p.items.filter((i) => !drop.has(i.id));
  }
  return { ok: true, item, ...(owner && owner !== actor ? { tell: { to: owner, text: `Assigned you "${title}"${item.severity ? ` (${item.severity})` : ''}${item.next ? `. Next: ${item.next}` : ''}` } } : {}) };
}

/**
 * A change to an item's fields: severity, owner and title the lead's (or with no lead, the opener's); state and next
 * step its owner's; you change anything. Known issues: you approve and retire them; their proposer edits them.
 */
export function changeItem(p: Project, actor: string, ref: string, patch: { title?: unknown; severity?: unknown; owner?: unknown; state?: unknown; next?: unknown; link?: unknown; body?: unknown; rule?: unknown }, now: number): ItemResult {
  const i = findItem(p, ref);
  if (!i) return fail(`No item ${ref}.`);
  const lead = runs(p, actor, i);
  const owner = actor === 'you' || i.owner === actor || actor === 'cora';
  let tell: { to: string; text: string } | undefined;
  if (i.kind === 'known') {
    if (patch.state !== undefined) {
      if (actor !== 'you') return fail('Only the user approves or retires a known issue.');
      if (patch.state !== 'approved' && patch.state !== 'retired' && patch.state !== 'proposed') return fail('A known issue is proposed, approved or retired.');
      i.state = patch.state;
      if (patch.state === 'retired') i.closedAt = now;
    }
    if (patch.title !== undefined || patch.body !== undefined || patch.rule !== undefined) {
      if (actor !== 'you' && actor !== i.openedBy) return fail('Only its proposer (or the user) edits a known issue.');
      if (clip(patch.title, 160)) i.title = clip(patch.title, 160);
      if (patch.body !== undefined) i.body = clip(patch.body, 2000) || undefined;
      if (patch.rule !== undefined) i.rule = clip(patch.rule, 400) || undefined;
    }
  } else {
    if ((patch.severity !== undefined || patch.owner !== undefined || patch.title !== undefined) && !lead) return fail(p.lead ? `Only the lead (${p.lead}) changes an incident's severity, owner or title.` : "Only the incident's opener (or the user) changes its severity, owner or title.");
    if ((patch.state !== undefined || patch.next !== undefined) && !owner && !lead) return fail(i.owner ? `It's ${i.owner}'s: only its owner (or the lead) changes its state or next step. Annotate it instead.` : 'Nobody owns it: claim it first (project_claim).');
    if (patch.severity !== undefined) {
      const s = sev(patch.severity);
      if (!s) return fail('Severity is low, medium, high or critical.');
      i.severity = s;
    }
    if (clip(patch.title, 160)) i.title = clip(patch.title, 160);
    if (patch.owner !== undefined) {
      const o = typeof patch.owner === 'string' && patch.owner ? patch.owner : undefined;
      if (o && !member(p, o)) return fail(`${o} isn't in this project.`);
      if (o !== i.owner) {
        const before = i.owner;
        i.owner = o;
        i.ownedAt = o ? now : undefined;
        if (o && i.state === 'open') i.state = 'working';
        if (!o && i.state === 'working') i.state = 'open';
        if (o && o !== actor) tell = { to: o, text: `${before ? 'Reassigned' : 'Assigned'} you "${i.title}"${i.severity ? ` (${i.severity})` : ''}${i.next ? `. Next: ${i.next}` : ''}` };
      }
    }
    if (patch.state !== undefined) {
      if (!(INCIDENT_STATES as readonly string[]).includes(patch.state as string) || patch.state === 'resolved') return fail('State is open, working or waiting (close it with project_close).');
      i.state = patch.state as string;
    }
    if (patch.next !== undefined) i.next = clip(patch.next, 400) || undefined;
  }
  if (patch.link !== undefined) i.link = clip(patch.link, 500) || undefined;
  i.updatedBy = actor;
  i.updatedAt = now;
  return { ok: true, item: i, ...(tell ? { tell } : {}) };
}

/** Claim it: yours if nobody has it (the one check that stops two sessions working one outage). */
export function claimItem(p: Project, actor: string, ref: string, now: number): ItemResult {
  const i = findItem(p, ref);
  if (!i) return fail(`No item ${ref}.`);
  if (i.kind !== 'incident') return fail('Only an incident can be claimed.');
  if (!itemOpen(i)) return fail(`"${i.title}" is closed.`);
  if (i.owner && i.owner !== actor) return fail(`Already claimed: ${i.owner} has owned "${i.title}" since ${new Date(i.ownedAt ?? i.updatedAt).toISOString().slice(11, 16)}Z.`);
  i.owner = actor;
  i.ownedAt ??= now;
  if (i.state === 'open') i.state = 'working';
  i.updatedBy = actor;
  i.updatedAt = now;
  return { ok: true, item: i };
}

/** A dated, signed note on an item, by anyone in the project; its owner hears of it. */
export function annotateItem(p: Project, actor: string, ref: string, text: unknown, now: number): ItemResult {
  const i = findItem(p, ref);
  if (!i) return fail(`No item ${ref}.`);
  const t = clip(text, 2000);
  if (!t) return fail('Nothing to note.');
  i.notes = [...i.notes, { by: actor, at: now, text: t }].slice(-MAX_ITEM_NOTES);
  i.updatedAt = now;
  return { ok: true, item: i, ...(i.owner && i.owner !== actor ? { tell: { to: i.owner, text: `Noted on "${i.title}": ${t}` } } : {}) };
}

/** Closed by its owner (or the lead, or you) with a cause and a fix: into the incident log. */
export function closeItem(p: Project, actor: string, ref: string, cause: unknown, fix: unknown, now: number): ItemResult {
  const i = findItem(p, ref);
  if (!i) return fail(`No item ${ref}.`);
  if (i.kind !== 'incident') return fail('A known issue is retired by the user, not closed.');
  if (!itemOpen(i)) return fail(`"${i.title}" is already closed.`);
  if (actor !== 'you' && i.owner !== actor && !runs(p, actor, i)) return fail(i.owner ? `It's ${i.owner}'s to close (or the lead's).` : 'Claim it first, then close it.');
  i.state = 'resolved';
  i.cause = clip(cause, 1000) || undefined;
  i.fix = clip(fix, 1000) || undefined;
  i.closedAt = now;
  i.updatedBy = actor;
  i.updatedAt = now;
  return { ok: true, item: i };
}

/** A duplicate merged into another (the lead's, or you): closed, pointing at it, its notes carried over. */
export function mergeItem(p: Project, actor: string, ref: string, into: string, now: number): ItemResult {
  const i = findItem(p, ref);
  const t = findItem(p, into);
  if (!i || !t) return fail('No such item.');
  if (i === t) return fail('An item can’t merge into itself.');
  if (!runs(p, actor, i)) return fail(p.lead ? `Only the lead (${p.lead}) merges incidents.` : 'Only its opener (or the user) merges it.');
  t.notes = [...t.notes, ...i.notes, { by: actor, at: now, text: `Merged in "${i.title}" (${i.id}).` }].slice(-MAX_ITEM_NOTES);
  t.updatedAt = now;
  i.mergedInto = t.id;
  i.state = i.kind === 'incident' ? 'resolved' : 'retired';
  i.closedAt = now;
  i.updatedBy = actor;
  i.updatedAt = now;
  return { ok: true, item: t };
}

/** Items that match: by kind, open (or the log), owner, severity, words; most urgent first, the log newest first. */
export function queryItems(p: Project, q: { kind?: ItemKind; open?: boolean; owner?: string; severity?: ItemSeverity; words?: string }): ProjectItem[] {
  const words = (q.words ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const open = q.open ?? true;
  const list = (p.items ?? []).filter(
    (i) =>
      (!q.kind || i.kind === q.kind) &&
      itemOpen(i) === open &&
      (!q.owner || (q.owner === 'none' ? !i.owner : i.owner === q.owner)) &&
      (!q.severity || i.severity === q.severity) &&
      words.every((w) => `${i.title} ${i.next ?? ''} ${i.body ?? ''} ${i.link ?? ''} ${i.notes.map((n) => n.text).join(' ')}`.toLowerCase().includes(w)),
  );
  const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return open ? list.sort((a, b) => (rank[a.severity ?? 'medium'] ?? 2) - (rank[b.severity ?? 'medium'] ?? 2) || a.openedAt - b.openedAt) : list.sort((a, b) => (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt));
}

/** One line for an item, as sessions read it. */
export function itemLine(i: ProjectItem, who: (by: string) => string, now = Date.now()): string {
  const age = (t: number) => {
    const m = Math.max(0, Math.round((now - t) / 60_000));
    return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  };
  if (i.kind === 'known') return `[known ${i.state}] ${i.title} (item ${i.id})${i.rule ? ` · rule: ${i.rule}` : ''}${i.body ? ` · ${i.body.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`;
  const head = `[${i.severity ?? 'medium'} · ${i.state}] ${i.title} (item ${i.id})`;
  const own = i.owner ? `owner ${who(i.owner)}` : 'unowned';
  const tail = itemOpen(i) ? `opened ${age(i.openedAt)} ago, updated ${age(i.updatedAt)} ago` : `closed ${age(i.closedAt ?? i.updatedAt)} ago${i.mergedInto ? ` (merged into ${i.mergedInto})` : ''}${i.cause ? ` · cause: ${i.cause}` : ''}${i.fix ? ` · fix: ${i.fix}` : ''}`;
  return `${head} · ${own}${i.next ? ` · next: ${i.next}` : ''}${i.link ? ` · ${i.link}` : ''} · ${tail}${i.notes.length ? ` · ${i.notes.length} note${i.notes.length === 1 ? '' : 's'}, latest: ${i.notes.at(-1)!.text.replace(/\s+/g, ' ').slice(0, 160)} (${who(i.notes.at(-1)!.by)})` : ''}`;
}
