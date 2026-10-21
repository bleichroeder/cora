const RULE = /^[─━]{8,}$/;
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
