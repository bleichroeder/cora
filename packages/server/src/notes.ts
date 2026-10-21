import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SCRATCH_ID, addedBlock, formatScratch, parseScratch, slugOf, type Jot, type NoteDoc, type NoteDraft, type NoteSummary } from '@cora/shared';
import { DEFAULT_TEMPLATES, fillDate, parseTemplate, stripHints, type Template } from './noteTemplates';
import { writeFileAtomic } from './fsx';

/**
 * Cora notes, kept as plain markdown in a folder: scratch.md (the
 * jots, newest first) and one file per named note, with notes.json for titles, pins, versions and what sessions added
 * that you haven't seen. The user edits and deletes; sessions only add (a jot, or a quote at a note's end).
 */

type Meta = {
  title: string;
  pinned?: boolean;
  createdAt: number;
  version: number;
  /** a session's last addition, and when you last opened it */
  addedAt?: number;
  seenAt?: number;
  /** sessions' additions lately (a save from an editor that hadn't seen them keeps them) */
  added?: Array<{ version: number; block: string }>;
  /** a template (its file is in templates/) */
  template?: true;
  /** the template a note was made from, and how Cora drafted it */
  from?: string;
  draft?: NoteDraft;
};
type Index = { notes: Record<string, Meta>; scratch: { version: number; addedAt?: number; seenAt?: number }; /** the first templates were made */ seeded?: boolean };

export const MAX_TEXT = 1_000_000;
export const MAX_JOT = 20_000;
const MAX_NOTES = 1000;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type NoteHit = { id: string; title: string; lines: string[] };

export class NoteError extends Error {}

export class Notes {
  private idx: Index = { notes: {}, scratch: { version: 0 } };
  private file: string;

  constructor(private o: { dir: string; onChange?: () => void; now?: () => number }) {
    mkdirSync(o.dir, { recursive: true });
    this.file = join(o.dir, 'notes.json');
    try {
      if (existsSync(this.file)) this.idx = { ...this.idx, ...(JSON.parse(readFileSync(this.file, 'utf8')) as Index) };
    } catch {
      /* start afresh (the notes' files are still there) */
    }
    // the first templates, once (deleted ones stay deleted)
    if (!this.idx.seeded) {
      mkdirSync(join(o.dir, 'templates'), { recursive: true });
      for (const t of DEFAULT_TEMPLATES) {
        const id = `tpl-${slugOf(t.name)}`;
        if (this.idx.notes[id]) continue;
        this.idx.notes[id] = { title: t.name, createdAt: this.now(), version: 1, template: true };
        if (!existsSync(this.path(id))) writeFileAtomic(this.path(id), t.text);
      }
      this.idx.seeded = true;
      writeFileAtomic(this.file, JSON.stringify(this.idx, null, 1));
    }
  }

  private now = () => this.o.now?.() ?? Date.now();
  private path = (id: string) => (id === SCRATCH_ID ? join(this.o.dir, 'scratch.md') : this.idx.notes[id]?.template ? join(this.o.dir, 'templates', `${id.replace(/^tpl-/, '')}.md`) : join(this.o.dir, `${id}.md`));
  /** your notes (not templates) */
  private notes = () => Object.entries(this.idx.notes).filter(([, m]) => !m.template);
  private readText(id: string): string {
    try {
      return readFileSync(this.path(id), 'utf8');
    } catch {
      return '';
    }
  }
  private mtime(id: string): number {
    try {
      return statSync(this.path(id)).mtimeMs;
    } catch {
      return this.idx.notes[id]?.createdAt ?? 0;
    }
  }
  private saveIndex(): void {
    writeFileAtomic(this.file, JSON.stringify(this.idx, null, 1));
    this.o.onChange?.();
  }
  private meta(id: string): Meta {
    const m = ID.test(id) ? this.idx.notes[id] : undefined;
    if (!m) throw new NoteError('no such note');
    return m;
  }

  // ---------------------------------------------------------------------------------------------------------------

  list(): NoteSummary[] {
    const jots = this.jots();
    const s = this.idx.scratch;
    const scratch: NoteSummary = { id: SCRATCH_ID, title: 'Scratch', kind: 'scratch', pinned: true, updatedAt: jots[0]?.at ?? 0, preview: jots[0]?.text.slice(0, 120) ?? '', count: jots.length, unseen: (s.addedAt ?? 0) > (s.seenAt ?? 0) };
    const notes = this.notes()
      .map(([id, m]): NoteSummary => ({ id, title: m.title, kind: 'note', pinned: !!m.pinned, updatedAt: this.mtime(id), preview: preview(this.readText(id)), unseen: (m.addedAt ?? 0) > (m.seenAt ?? 0) }))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    const templates = Object.entries(this.idx.notes)
      .filter(([, m]) => m.template)
      .map(([id, m]): NoteSummary => ({ id, title: m.title, kind: 'template', pinned: false, updatedAt: this.mtime(id), preview: '', unseen: false, fill: parseTemplate(this.readText(id), m.title).fill }))
      .sort((a, b) => a.title.localeCompare(b.title));
    return [scratch, ...notes, ...templates];
  }

  /** A template's parts (its front matter read). */
  template(id: string): Template & { id: string; name: string } {
    const m = this.meta(id);
    if (!m.template) throw new NoteError('not a template');
    return { id, name: m.title, ...parseTemplate(this.readText(id), m.title) };
  }

  /** The starter templates you deleted, back as they were (the ones still there are left alone). How many came back. */
  restoreTemplates(): number {
    mkdirSync(join(this.o.dir, 'templates'), { recursive: true });
    let added = 0;
    for (const t of DEFAULT_TEMPLATES) {
      const id = `tpl-${slugOf(t.name)}`;
      if (this.idx.notes[id]) continue;
      this.idx.notes[id] = { title: t.name, createdAt: this.now(), version: 1, template: true };
      writeFileAtomic(this.path(id), t.text);
      added++;
    }
    if (added) this.saveIndex();
    return added;
  }

  /** A new template (from Edit templates…): a Cora-filled one to start from. */
  createTemplate(name: string): string {
    const t = name.trim().slice(0, 80) || 'Template';
    let id = `tpl-${slugOf(t)}`;
    for (let n = 2; this.idx.notes[id]; n++) id = `tpl-${slugOf(t).slice(0, 50)}-${n}`;
    this.idx.notes[id] = { title: t, createdAt: this.now(), version: 1, template: true };
    writeFileAtomic(this.path(id), `---\nfill: cora\nwindow: 24h\ntitle: ${t} · {date}\n---\n## Notes\n<!-- cora: what to write here, from my recent work -->\n`);
    this.saveIndex();
    return id;
  }

  /** A note started from a template (its hints kept when Cora is about to draft it, else taken out). */
  fromTemplate(tplId: string, o: { keepHints: boolean }): string {
    const t = this.template(tplId);
    const at = new Date(this.now());
    const id = this.create(fillDate(t.title, at), o.keepHints ? t.body : stripHints(t.body));
    this.idx.notes[id].from = tplId;
    this.saveIndex();
    return id;
  }

  /** When the last note from a template was made (the "since last" window), if any. */
  lastFrom(tplId: string, except?: string): number | null {
    const ts = this.notes()
      .filter(([id, m]) => m.from === tplId && id !== except)
      .map(([, m]) => m.createdAt);
    return ts.length ? Math.max(...ts) : null;
  }

  /** Cora's draft into a note (replacing its text). */
  setDraft(id: string, text: string, draft: NoteDraft): { version: number } {
    const m = this.meta(id);
    writeFileAtomic(this.path(id), text.slice(0, MAX_TEXT));
    m.version++;
    m.draft = draft;
    this.saveIndex();
    return { version: m.version };
  }

  /** The titles of notes you changed since a time (for a draft's facts). */
  changedSince(since: number): string[] {
    return this.notes()
      .filter(([id]) => this.mtime(id) >= since)
      .map(([, m]) => m.title);
  }

  /** A note, whole. `seen`: the user opened it (its unseen additions are seen now). */
  read(id: string, o: { seen?: boolean } = {}): NoteDoc {
    if (id === SCRATCH_ID) {
      if (o.seen && (this.idx.scratch.addedAt ?? 0) > (this.idx.scratch.seenAt ?? 0)) (this.idx.scratch.seenAt = this.now()), this.saveIndex();
      return { ...this.list()[0], text: '', version: this.idx.scratch.version, jots: this.jots() };
    }
    const m = this.meta(id);
    if (o.seen && (m.addedAt ?? 0) > (m.seenAt ?? 0)) (m.seenAt = this.now()), this.saveIndex();
    const text = this.readText(id);
    return { id, title: m.title, kind: m.template ? 'template' : 'note', pinned: !!m.pinned, updatedAt: this.mtime(id), preview: preview(text), unseen: (m.addedAt ?? 0) > (m.seenAt ?? 0), text, version: m.version, ...(m.from ? { from: m.from } : {}), ...(m.draft ? { draft: m.draft } : {}), ...(m.template ? { fill: parseTemplate(text, m.title).fill } : {}) };
  }

  /** Find a note by id or title (any case). */
  find(ref: string): string | null {
    const r = ref.trim();
    if (!r || r.toLowerCase() === SCRATCH_ID) return SCRATCH_ID;
    if (this.idx.notes[r] && !this.idx.notes[r].template) return r;
    const low = r.toLowerCase();
    return this.notes().find(([, m]) => m.title.toLowerCase() === low)?.[0] ?? this.notes().find(([, m]) => m.title.toLowerCase().includes(low))?.[0] ?? null;
  }

  create(title: string, text = ''): string {
    const t = title.trim().slice(0, 120) || 'Untitled';
    if (Object.keys(this.idx.notes).length >= MAX_NOTES) throw new NoteError('too many notes');
    const base = slugOf(t) === SCRATCH_ID ? 'scratch-note' : slugOf(t);
    let id = base;
    for (let n = 2; this.idx.notes[id] || existsSync(this.path(id)); n++) id = `${base.slice(0, 58)}-${n}`;
    writeFileAtomic(this.path(id), text.slice(0, MAX_TEXT));
    this.idx.notes[id] = { title: t, createdAt: this.now(), version: 1 };
    this.saveIndex();
    return id;
  }

  /**
   * The user's edit. Saved from an editor that hadn't seen a session's addition since (`base` older than the note), the
   * addition is put back at the end, so nothing a session added is lost by a save that never knew about it.
   */
  save(id: string, text: string, base: number): { version: number; text: string } {
    const m = this.meta(id);
    let t = text.slice(0, MAX_TEXT);
    if (base < m.version) for (const a of m.added ?? []) if (a.version > base && !t.includes(a.block)) t = `${t.replace(/\s+$/, '')}\n\n${a.block}\n`;
    writeFileAtomic(this.path(id), t);
    m.version++;
    this.saveIndex();
    return { version: m.version, text: t };
  }

  rename(id: string, title: string): void {
    const t = title.trim().slice(0, 120);
    if (!t) throw new NoteError('a title, please');
    this.meta(id).title = t;
    this.saveIndex();
  }

  pin(id: string, pinned: boolean): void {
    this.meta(id).pinned = pinned;
    this.saveIndex();
  }

  remove(id: string): void {
    this.meta(id);
    rmSync(this.path(id), { force: true });
    delete this.idx.notes[id];
    this.saveIndex();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Scratch

  private jots(): Jot[] {
    return parseScratch(this.readText(SCRATCH_ID));
  }

  private writeJots(jots: Jot[]): void {
    writeFileAtomic(this.path(SCRATCH_ID), formatScratch(jots));
    this.idx.scratch.version++;
  }

  /** A jot on top of Scratch (`by`: a session's; `src`: yours, taken from a session). */
  jot(text: string, by?: string, src?: string): Jot {
    const t = text.trim().slice(0, MAX_JOT);
    if (!t) throw new NoteError('nothing to jot');
    const j: Jot = { id: Math.random().toString(36).slice(2, 10), at: this.now(), text: t, ...(by ? { by } : {}), ...(src ? { src: src.slice(0, 120) } : {}) };
    this.writeJots([j, ...this.jots()]);
    if (by) this.idx.scratch.addedAt = this.now();
    this.saveIndex();
    return j;
  }

  deleteJot(jotId: string): void {
    const jots = this.jots();
    if (!jots.some((j) => j.id === jotId)) throw new NoteError('no such jot');
    this.writeJots(jots.filter((j) => j.id !== jotId));
    this.saveIndex();
  }

  /** A deleted jot back where it was (undo). */
  restoreJot(j: Jot): void {
    const t = String(j.text ?? '').trim().slice(0, MAX_JOT);
    if (!t || !/^[a-z0-9]{1,16}$/.test(j.id)) throw new NoteError('not a jot');
    const jots = this.jots().filter((x) => x.id !== j.id);
    const back: Jot = { id: j.id, at: Number(j.at) || this.now(), text: t, ...(j.by ? { by: String(j.by).slice(0, 120) } : {}), ...(j.src ? { src: String(j.src).slice(0, 120) } : {}) };
    this.writeJots([...jots, back].sort((a, b) => b.at - a.at));
    this.saveIndex();
  }

  /** A jot into a note (an existing one, or a new one by its title), off Scratch. */
  moveJot(jotId: string, to: { id?: string; title?: string }): string {
    const j = this.jots().find((x) => x.id === jotId);
    if (!j) throw new NoteError('no such jot');
    const id = to.id ? (this.meta(to.id), to.id) : this.create(to.title ?? j.text.split(/\r?\n/)[0].slice(0, 60));
    this.append(id, j.text);
    this.deleteJot(jotId);
    return id;
  }

  /** The user's own text at a note's end (quick capture's Tab, a moved jot). */
  append(id: string, text: string): void {
    const m = this.meta(id);
    const cur = this.readText(id).replace(/\s+$/, '');
    writeFileAtomic(this.path(id), `${cur ? `${cur}\n\n` : ''}${text.trim()}\n`.slice(0, MAX_TEXT));
    m.version++;
    this.saveIndex();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // sessions

  /** A session adds: a jot on Scratch (no note named), or a quote at a note's end (made when there's none by that name). */
  addFromSession(note: string | undefined, text: string, by: string): { id: string; title: string; created: boolean } {
    const t = text.trim().slice(0, MAX_JOT);
    if (!t) throw new NoteError('nothing to add');
    const found = note == null ? SCRATCH_ID : this.find(note);
    if (found === SCRATCH_ID) {
      this.jot(t, by);
      return { id: SCRATCH_ID, title: 'Scratch', created: false };
    }
    const block = addedBlock(by, this.now(), t);
    if (!found) {
      const id = this.create(note!, `${block}\n`);
      const m = this.idx.notes[id];
      m.addedAt = this.now();
      this.saveIndex();
      return { id, title: m.title, created: true };
    }
    const m = this.meta(found);
    const cur = this.readText(found).replace(/\s+$/, '');
    writeFileAtomic(this.path(found), `${cur ? `${cur}\n\n` : ''}${block}\n`.slice(0, MAX_TEXT));
    m.version++;
    m.addedAt = this.now();
    m.added = [...(m.added ?? []), { version: m.version, block }].slice(-20);
    this.saveIndex();
    return { id: found, title: m.title, created: false };
  }

  /** What the notes say about a ticket (its key as a whole word), for a session starting on it; null when nothing. */
  aboutTicket(key: string, max = 1500): string | null {
    const re = new RegExp(`(^|[^A-Za-z0-9-])${key.replace(/[^A-Za-z0-9-]/g, '')}(?![0-9])`, 'i');
    const hits = this.search(key)
      .map((h) => ({ ...h, lines: h.lines.filter((l) => re.test(l)) }))
      .filter((h) => h.lines.length || re.test(h.title));
    if (!hits.length) return null;
    let out = '';
    for (const h of hits) {
      const part = `## ${h.title}\n${h.lines.map((l) => `- ${l}`).join('\n')}\n`;
      if (out.length + part.length > max) break;
      out += part;
    }
    return out.trim() || null;
  }

  /** Notes and jots with every word of the query, best first: per note, its matching lines. */
  search(query: string, limit = 20): NoteHit[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const has = (s: string) => words.every((w) => s.toLowerCase().includes(w));
    const any = (s: string) => words.some((w) => s.toLowerCase().includes(w));
    const hits: Array<NoteHit & { score: number }> = [];
    const jots = this.jots().filter((j) => has(j.text));
    if (jots.length) hits.push({ id: SCRATCH_ID, title: 'Scratch', lines: jots.slice(0, 6).map((j) => `[${new Date(j.at).toISOString().slice(0, 16).replace('T', ' ')}] ${j.text.replace(/\s+/g, ' ').slice(0, 240)}`), score: jots.length });
    for (const [id, m] of this.notes()) {
      const text = this.readText(id);
      if (!has(`${m.title}\n${text}`)) continue;
      const lines = text.split(/\r?\n/).filter((l) => l.trim() && any(l)).slice(0, 6).map((l) => l.trim().slice(0, 240));
      hits.push({ id, title: m.title, lines, score: (has(m.title) ? 10 : any(m.title) ? 5 : 0) + lines.length });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score: _s, ...h }) => h);
  }
}

const preview = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
    .find(Boolean)
    ?.slice(0, 120) ?? '';
