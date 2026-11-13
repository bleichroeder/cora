/**
 * A button pressed in a dashboard: the page posts the click
 * to Cora, and Cora decides. The words a button sends are the session's own, sent back as yours, so:
 * - a page that is Cora's own kit page (by its content's hash) only posts on a real click: its buttons act at once
 *   (one marked risky asks in itself first: click, then click again);
 * - any other page (a session's own HTML could post "clicks" by script) always asks first, here in Cora, in a card of
 *   Cora's own;
 * - someone watching your Cora can't press them.
 * What the session then does goes through its usual permissions.
 */

export type ExplainAction = { id: string; label: string; confirm: boolean } & ({ prompt: string; url?: undefined } | { url: string; prompt?: undefined });

const PROMPT_MAX = 2000;

/** A page's message as an action, or null when it isn't one (anything can be posted: only this shape is taken). */
export function readAction(m: unknown): ExplainAction | null {
  if (!m || typeof m !== 'object') return null;
  const d = m as Record<string, unknown>;
  if (d.cora !== 'action' || typeof d.id !== 'string' || !/^\w{1,20}$/.test(d.id)) return null;
  const label = typeof d.label === 'string' ? d.label.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  if (!label) return null;
  const base = { id: d.id, label, confirm: d.confirm === true };
  if (typeof d.prompt === 'string') {
    const prompt = d.prompt.trim();
    return prompt && prompt.length <= PROMPT_MAX ? { ...base, prompt } : null;
  }
  if (typeof d.url === 'string') {
    try {
      const u = new URL(d.url);
      return u.protocol === 'http:' || u.protocol === 'https:' ? { ...base, url: u.href } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Does Cora ask before acting? Never for its own kit page: a click there is a real click, and a button marked risky
 * asks in itself (it arms on the first click and sends on the second). Always for any other page.
 */
export const asksInCora = (kit: boolean): boolean => !kit;

/** A page's content, hashed as the server hashes its kit page (hex SHA-256). */
export async function hashOf(content: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let kitHash: Promise<string | null> | null = null;
const known = new Map<string, boolean>();
/** Is this page Cora's own kit page? (Its hash, against the server's; a page is asked about once.) */
export async function isKitPage(content: string): Promise<boolean> {
  const key = `${content.length}:${content.slice(0, 64)}:${content.slice(-64)}`;
  const hit = known.get(key);
  if (hit != null) return hit;
  kitHash ??= fetch('/api/dashboard-kit')
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { hash?: string } | null) => j?.hash ?? null)
    .catch(() => null);
  const want = await kitHash;
  if (!want) return ((kitHash = null), false);
  const is = (await hashOf(content)) === want;
  known.set(key, is);
  return is;
}
