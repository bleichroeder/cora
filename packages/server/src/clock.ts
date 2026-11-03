/** How often a session hears the time again (it hears it on its first prompt). */
export const TIME_EVERY_MS = 10 * 60_000;

/**
 * The time now, in a line for a session's prompt context. Claude Code tells a session only today's date (and that once,
 * when it starts): a session that runs past midnight, or that needs the hour ("is it too late to page someone?",
 * "how long ago was that alert?"), has no clock of its own. Cora adds this to a session's first prompt (the
 * UserPromptSubmit hook), then again once TIME_EVERY_MS has passed: local time, with the weekday, the date and the zone.
 */
export function nowLine(at: Date = new Date(), timeZone?: string): string {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
  return `From Cora: it's ${when} (${zone}).`;
}
