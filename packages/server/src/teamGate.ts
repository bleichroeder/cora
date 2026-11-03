import { routeAllows, type Endpoint, type MsgKind, type Team } from '@cora/shared';

/**
 * The route gate: whether a team seat may send a message, and if
 * not, why (a sentence the sender reads, naming who it may message instead). Pure: the app works out the seats.
 */

/** Labels from a leading `[labels: issue=encoder, area=network]` line (the first line that isn't blank), or none. */
export function parseLabels(text: string): Record<string, string> | undefined {
  const m = /^\s*\[labels:\s*([^\]\n]*)\]/i.exec(text);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const pair of m[1].split(',')) {
    const at = pair.indexOf('=');
    const k = pair.slice(0, at).trim();
    const v = pair.slice(at + 1).trim();
    if (at > 0 && k && v) out[k] = v;
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A template's fields the text lacks: each must be a markdown heading (`## Issue`) or start a line as `Issue:`. */
export function missingFields(fields: string[], text: string): string[] {
  return fields.filter((f) => {
    const n = escape(f.trim());
    return !new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]+${n}[ \\t]*:?[ \\t]*#*[ \\t]*$|(?:[-*][ \\t]+)?\\**${n}[ \\t]*\\**[ \\t]*:)`, 'im').test(text);
  });
}

/** Why `fromSeat` may not send this to `to` (null: it may). Its route's template, when it has one, must be filled in. */
export function gate(team: Team, fromSeat: string, to: Endpoint, kind: MsgKind, text: string, labels?: Record<string, string>): string | null {
  const r = routeAllows(team, `seat:${fromSeat}`, to, kind, labels);
  if (!r.ok) return r.why;
  const missing = missingFields(r.route.template?.fields ?? [], text);
  return missing.length ? `This route needs: ${missing.join(', ')}.` : null;
}
