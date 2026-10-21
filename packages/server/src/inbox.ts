import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { INBOX_ENTRIES, INBOX_KEEP_MS, INBOX_MAX, isUnread, type InboxItem, type InboxSource } from '@cora/shared';
import { writeFileAtomic } from './fsx';

/** Something Cora tells you, as a feed hands it over. */
export type InboxAdd = {
  source: InboxSource;
  key: string;
  title: string;
  why: string;
  entry: { id: string; who?: string; text: string; at: number };
  link?: string;
  sessionId?: string;
  did?: string;
  state?: InboxItem['state'];
  mailId?: string;
  /** the latest replaces what's there (a pipeline's or deploy's result) instead of adding to it */
  replace?: boolean;
  /** it comes in read (you answered it yourself) */
  read?: boolean;
};

/**
 * Cora's Inbox on the server: one item per conversation, kept 14
 * days (3,000 at most) in ~/.cora/inbox.json with what you've read. An entry already told is never told again.
 */
export class Inbox {
  private items: InboxItem[] = [];
  /** nothing kept yet (its first start): the feeds' own history can fill it */
  readonly fresh: boolean;

  constructor(private o: { file?: string; now?: () => number; onChange?: (changed: InboxItem[], gone: string[]) => void }) {
    this.fresh = !o.file || !existsSync(o.file);
    try {
      if (o.file && existsSync(o.file)) {
        const j = JSON.parse(readFileSync(o.file, 'utf8'));
        if (Array.isArray(j)) this.items = j.filter((i) => i && typeof i.key === 'string' && Array.isArray(i.entries));
      }
    } catch {
      /* start afresh */
    }
  }

  private now = () => this.o.now?.() ?? Date.now();
  private save() {
    try {
      if (this.o.file) writeFileAtomic(this.o.file, JSON.stringify(this.items));
    } catch {
      /* not kept */
    }
  }
  /** Older than 14 days, or past 3,000: gone. */
  private prune(): string[] {
    const cutoff = this.now() - INBOX_KEEP_MS;
    const keep = this.items.filter((i) => i.at >= cutoff).slice(0, INBOX_MAX);
    const gone = this.items.filter((i) => !keep.includes(i)).map((i) => i.id);
    this.items = keep;
    return gone;
  }
  private changed(changed: InboxItem[]) {
    const gone = this.prune();
    this.save();
    this.o.onChange?.(changed, gone);
  }

  /** Newest first. */
  list(): InboxItem[] {
    return [...this.items];
  }
  get(id: string): InboxItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  /** Fold it into its conversation (or start one). Null: that entry was told already. */
  add(a: InboxAdd): InboxItem | null {
    const now = this.now();
    const old = this.items.find((i) => i.key === a.key);
    if (old?.entries.some((e) => e.id === a.entry.id)) return null;
    const entry = { ...a.entry, got: now };
    const opt = {
      ...(a.link ? { link: a.link } : {}),
      ...(a.sessionId ? { sessionId: a.sessionId } : {}),
      ...(a.did ? { did: a.did } : {}),
      ...(a.state ? { state: a.state } : {}),
      ...(a.mailId ? { mailId: a.mailId } : {}),
    };
    let item: InboxItem;
    if (!old) item = { id: randomUUID().slice(0, 12), source: a.source, key: a.key, title: a.title, why: a.why, ...opt, entries: [entry], at: now, readAt: null };
    else {
      // fixed before you saw it failing: nothing to tell any more
      const fixed = a.replace && old.state === 'failed' && a.state === 'ok' && isUnread(old);
      item = { ...old, title: a.title, why: a.why, ...opt, entries: a.replace ? [entry] : [entry, ...old.entries].slice(0, INBOX_ENTRIES), at: now, ...(fixed ? { readAt: now } : {}) };
    }
    if (a.read) item.readAt = now;
    this.items = [item, ...this.items.filter((i) => i.key !== a.key)];
    this.changed([item]);
    return item;
  }

  /** You've seen them: some, a source's, or everything. How many changed. */
  read(sel: { ids?: string[]; keys?: string[]; source?: InboxSource; all?: boolean }): number {
    const now = this.now();
    const hit = (i: InboxItem) => sel.all || (sel.source && i.source === sel.source) || sel.ids?.includes(i.id) || sel.keys?.includes(i.key);
    const changed: InboxItem[] = [];
    this.items = this.items.map((i) => {
      if (!hit(i) || !isUnread(i)) return i;
      const r = { ...i, readAt: now };
      changed.push(r);
      return r;
    });
    if (changed.length) this.changed(changed);
    return changed.length;
  }
}
