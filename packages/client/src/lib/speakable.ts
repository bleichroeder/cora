/**
 * What gets read aloud from one of Claude's markdown replies: code skipped, tables mentioned, links and
 * formatting stripped, paths shortened to their file name, and capped at about `cap` characters
 * (whole paragraphs) with a pointer to the rest.
 */
export function speakable(src: string, cap = Infinity): string {
  const t = src
    .replace(/```[\s\S]*?```/g, '\n\nCode omitted.\n\n')
    .replace(/(^\|.*\|[ \t]*$\n?)+/gm, "\n\nThere's a table in the transcript.\n\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/https?:\/\/(?:www\.)?([^/\s]+)\S*/g, '$1')
    .replace(/(?:[A-Za-z]:)?(?:[\\/~.]?[\w.@-]+[\\/])+([\w.@-]+)/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/gm, (_, s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?:]$/.test(s) ? '' : '.'}`)
    .replace(/^\s*>\s?/gm, '');
  const paras = t
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let out = '';
  let cut = false;
  for (const p of paras) {
    if (out && out.length + p.length > cap) {
      cut = true;
      break;
    }
    out += (out ? ' ' : '') + p;
  }
  return cut ? `${out} More in the transcript.` : out;
}

/** Split spoken text into sentences, for showing which one is being read. */
export function sentences(t: string): string[] {
  return t.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [t];
}

/** The sentence being read at `frac` (0..1) of the way through, assuming an even pace. */
export function sentenceAt(list: string[], frac: number): number {
  const total = list.reduce((n, s) => n + s.length, 0) || 1;
  let acc = 0;
  for (let i = 0; i < list.length; i++) {
    acc += list[i].length;
    if (acc / total >= frac) return i;
  }
  return Math.max(0, list.length - 1);
}
