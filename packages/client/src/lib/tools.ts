/** Tools: web apps Cora keeps open for the whole app (not per session), in a drawer from the left nav. */

export type ToolDef = {
  id: string;
  name: string;
  url: string;
  /** its tile washed in a colour (one of TOOL_TINTS), so the same favicon reads differently */
  tint?: string;
  /** up to 3 letters on the icon's corner (PRD, STG, DEV) */
  tag?: string;
  /** tools with the same folder name sit together in one folder */
  folder?: string;
};

/** The tints a tool can have: Cora's palette (red, orange, amber, green, teal, blue, violet, pink). */
export const TOOL_TINTS = ['#f87171', '#fb923c', '#fbbf24', '#4ade80', '#2dd4bf', '#60a5fa', '#a78bfa', '#f472b6'] as const;

/** A tool's tint when it's a colour the tile can use (anything else, an older setting say, is no tint, not a blank tile). */
export const tintOf = (t: Pick<ToolDef, 'tint'>) => (t.tint && /^#[0-9a-f]{3,8}$/i.test(t.tint) ? t.tint : undefined);

/** A tool's tag as kept: letters and digits, upper case, at most 3. */
export const cleanTag = (s: string) => s.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 3);

/** One entry in the Tools row: a tool, or a folder of them. `n` is the tool's place in the list (its Ctrl+n). */
export type ToolEntry = { kind: 'tool'; t: ToolDef; n: number } | { kind: 'folder'; name: string; tools: Array<{ t: ToolDef; n: number }> };

/** The tools as the row shows them: in their order, a folder where its first tool is (folders match by name, any case). */
export function toolEntries(tools: ToolDef[]): ToolEntry[] {
  const out: ToolEntry[] = [];
  const folders = new Map<string, Extract<ToolEntry, { kind: 'folder' }>>();
  tools.forEach((t, n) => {
    const f = t.folder?.trim();
    if (!f) return void out.push({ kind: 'tool', t, n });
    const key = f.toLowerCase();
    let e = folders.get(key);
    if (!e) {
      e = { kind: 'folder', name: f, tools: [] };
      folders.set(key, e);
      out.push(e);
    }
    e.tools.push({ t, n });
  });
  return out;
}

export const DEFAULT_TOOLS: ToolDef[] = [{ id: 'slack', name: 'Slack', url: 'https://app.slack.com/client' }];

export function toolHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** A tool's site, to show under its name: the host alone (app.slack.com), no scheme, path, query or `www.`. */
export const toolSite = (url: string) => toolHost(url).replace(/^www\./, '');

export const isSlackUrl = (url: string) => /(^|\.)slack\.com$/.test(toolHost(url));

/** The Slack tool, if there is one. */
export const slackTool = (tools: ToolDef[]) => tools.find((t) => isSlackUrl(t.url));

/**
 * Unread news from a page's title, as web apps show it: "(3) Inbox" is 3; a leading "*" or "!" (Slack marks unread
 * channels so) is a dot; nothing else is nothing.
 */
export function unreadOf(title: string): number | 'dot' | null {
  const t = title.trim();
  const n = /^\((\d+)\+?\)/.exec(t);
  if (n) return Number(n[1]) || null;
  if (/^[*!•]\s/.test(t)) return 'dot';
  return null;
}

/** A tool from what you typed: a name and an address (https assumed); its id from the name, kept unique. */
export function newTool(name: string, url: string, existing: ToolDef[]): ToolDef | string {
  const u = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
  if (!toolHost(u) || !/^https?:/i.test(u)) return 'not a web address';
  const label = name.trim() || toolHost(u).replace(/^www\./, '').split('.')[0];
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tool';
  let id = base;
  for (let i = 2; existing.some((t) => t.id === id); i++) id = `${base}-${i}`;
  return { id, name: label.slice(0, 40), url: u };
}
