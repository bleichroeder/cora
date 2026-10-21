const RULE = /^[─━]{8,}$/;

/**
 * Which rows of Claude Code's screen to show in compact terminal mode: its input area. Claude Code draws the
 * prompt between two full-width horizontal rules, with the status line or menus (slash commands, pickers)
 * below; so show from the second-to-last rule down to the last non-empty row. Without rules (dialogs, the
 * startup splash) show the bottom 8 rows of content.
 */
export function activeRegion(lines: string[]): { start: number; end: number } {
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      end = i;
      break;
    }
  }
  if (end < 0) return { start: 0, end: 0 };
  const rules: number[] = [];
  for (let i = 0; i <= end; i++) if (RULE.test(lines[i].trim())) rules.push(i);
  let start: number;
  if (rules.length >= 2) start = rules[rules.length - 2];
  else if (rules.length === 1) start = rules[0];
  else start = Math.max(0, end - 7);
  return { start: Math.min(start, Math.max(0, end - 2)), end };
}
