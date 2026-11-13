// (the box's top rule may carry a label near its end: the session's name, "──── cora-99c0 ─")
const RULE = /^[─━]{8,}(?: \S.*? [─━]+)?$/;
// (a dialog may be drawn in a box: its side border comes first)
const OPTION = /^[\s│┃|]*[❯›]\s*\d+\.\s+\S/u;
// a dialog whose options have no numbers ("❯ No, exit" / "  Yes, I trust this folder"), told by its footer
const PLAIN_OPTION = /^[\s│┃|]*[❯›]\s+\S/u;
const CONFIRM_FOOTER = /Enter to confirm|Esc to cancel/;

/**
 * Is Claude Code showing a choice (a permission prompt, a question, a picker such as /model)? Its highlighted option
 * ("❯ 1. Yes") is then in the input area at the bottom: from the second-to-last full-width rule down, or the last
 * rows when there are no rules. Text typed there would pick options and its Enter would confirm one, so the
 * dashboard doesn't send prompts then. The prompt line itself (right under a rule) is your text, even "❯ 1. fix it".
 */
export function choiceOpen(lines: string[]): boolean {
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  if (end < 0) return false;
  const rules: number[] = [];
  for (let i = 0; i <= end; i++) if (RULE.test(lines[i].trim())) rules.push(i);
  const start = rules.length >= 2 ? rules[rules.length - 2] : Math.max(0, end - 11);
  const footer = lines.slice(start, end + 1).some((l) => CONFIRM_FOOTER.test(l));
  for (let i = start; i <= end; i++) {
    if (i > 0 && RULE.test(lines[i - 1].trim())) continue;
    if (OPTION.test(lines[i]) || (footer && PLAIN_OPTION.test(lines[i]))) return true;
  }
  return false;
}

/**
 * Claude Code's "do you trust this folder?" question (its first start in a new folder or repo). Its highlighted
 * answer is "No, exit", so anything typed with an Enter would end the session.
 */
export function trustQuestion(lines: string[]): boolean {
  return choiceOpen(lines) && lines.some((l) => /Is this a project you created or one you trust|Do you trust the files in this folder|Yes, I trust this folder|Yes, proceed/i.test(l));
}

/** The option highlighted in a choice on screen (its text, without the marker or number), if any. */
export function highlightedOption(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^[\s│┃|]*[❯›]\s*(?:\d+\.\s+)?(.+?)\s*[│┃|]?\s*$/u.exec(lines[i]);
    if (m && !(i > 0 && RULE.test(lines[i - 1].trim()))) return m[1];
  }
  return null;
}

/** The most lines an input box (a draft of several lines) spans between its two rules. */
const BOX_MAX = 12;

/**
 * Claude Code's input box, if it's on screen: a line starting with ❯ or > right under a full-width rule, with the box's
 * closing rule a few lines below. Any such box counts, not only the one under the second-to-last rule (a band of its
 * own below the box, another pair of rules, once hid it). Rows are screen rows (top = the first rule's).
 */
export function inputBox(lines: string[]): { top: number; bottom: number } | null {
  const rules: number[] = [];
  lines.forEach((l, i) => RULE.test(l.trim()) && rules.push(i));
  for (let k = 0; k + 1 < rules.length; k++) {
    const [top, bottom] = [rules[k], rules[k + 1]];
    if (bottom - top >= 2 && bottom - top <= BOX_MAX + 1 && /^\s*[❯>]/u.test(lines[top + 1] ?? '')) return { top, bottom };
  }
  return null;
}

/**
 * What's written in Claude Code's input box (its draft), or null when no box is on screen: the box's lines without the
 * prompt mark and the indent that continues it, one row a line (a draft wider than the screen wraps onto rows of its
 * own, so compare it with its spacing ignored); empty is ''.
 */
export function inputBoxText(lines: string[]): string | null {
  const box = inputBox(lines);
  if (!box) return null;
  const rows = lines.slice(box.top + 1, box.bottom).map((l, i) => (i === 0 ? l.replace(/^\s*[❯>]\s?/u, '') : l.replace(/^\s{0,2}/, '')).trimEnd());
  return rows.join('\n').trim();
}
