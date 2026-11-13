/** One entry of a session's journal file, as the Journal tab shows it. */
export type JournalItem = {
  /** its day ("Nov 13") and its time ("2:14 PM"), as written */
  day: string;
  time: string;
  /** what it is: an entry's own kind (from its Refs line), a wrap-up, or one of Claude Code's recaps */
  kind: 'done' | 'decision' | 'finding' | 'blocker' | 'wrapup' | 'recap' | 'entry';
  /** its words (markdown), without its Refs line */
  body: string;
  /** what it points at (markdown, each a link or a few words): its Refs line without its kind */
  refs: string[];
};

const TAGS = ['done', 'decision', 'finding', 'blocker'] as const;

/**
 * A journal file's entries, in the order written. The file is a title, a few facts about the session, then an entry
 * under each "## Nov 13, 2:14 PM" (or "… · Wrap-up", "… · Recap"), ending with a "Refs: kind · link · link" line when
 * it has any.
 */
export function journalItems(text: string): JournalItem[] {
  const out: JournalItem[] = [];
  for (const p of text.replace(/\r\n/g, '\n').split(/^## /m).slice(1)) {
    const nl = p.indexOf('\n');
    const [when, label] = (nl < 0 ? p : p.slice(0, nl)).trim().split(' · ');
    const rest = nl < 0 ? '' : p.slice(nl + 1);
    const refsLine = /^Refs: (.*)$/m.exec(rest)?.[1] ?? '';
    const body = rest.replace(/^Refs: .*$/m, '').trim();
    if (!body) continue;
    const refs = refsLine.split(' · ').map((r) => r.trim()).filter(Boolean);
    const tag = TAGS.find((t) => t === refs[0]);
    if (tag) refs.shift();
    const comma = when.lastIndexOf(',');
    out.push({
      day: comma < 0 ? when : when.slice(0, comma).trim(),
      time: comma < 0 ? '' : when.slice(comma + 1).trim(),
      kind: label === 'Wrap-up' ? 'wrapup' : label === 'Recap' ? 'recap' : (tag ?? 'entry'),
      body,
      refs,
    });
  }
  return out;
}
