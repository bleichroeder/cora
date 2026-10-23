/** The Meme panel: memes and GIFs a session posts about what's happening (its `meme` tool), when the user wants them. */

/** How often sessions may post (Settings › Sessions › Memes): never, at real moments only, or freely. */
export const MEME_MODES = ['off', 'sometimes', 'often'] as const;
export type MemeMode = (typeof MEME_MODES)[number];

/** The most a drawn meme may be. */
export const SVG_MAX = 30_000;

/**
 * Why a drawn meme can't be shown (null: it can). It's shown as an image (which can't run scripts or fetch anything
 * anyway), but it's also held to that: an <svg> of at most 30 KB, with no scripts, foreign HTML, event handlers or
 * outside addresses.
 */
export function svgProblem(svg: string): string | null {
  const s = svg.trim();
  if (s.length > SVG_MAX) return `It's ${Math.round(s.length / 1000)} KB: at most ${SVG_MAX / 1000} KB.`;
  if (!/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return 'It must be one whole <svg>…</svg>.';
  if (/<script|<foreignObject|<iframe|<object|<embed/i.test(s)) return 'No scripts or embedded HTML.';
  if (/\son[a-z]+\s*=/i.test(s)) return 'No event handlers (onload=…).';
  if (/(href|src)\s*=\s*["']\s*(https?:|\/\/|javascript:)|url\(\s*["']?\s*(https?:|\/\/)|@import/i.test(s)) return 'Nothing from outside: no links, outside images or fonts (draw it all in the SVG).';
  return null;
}

/** A template from Imgflip's list of popular memes (Cora draws the captions on it). */
export type MemeTemplate = { id: string; name: string; url: string; width: number; height: number; boxes: number };

/** One post: a meme (a template with top and bottom text) or a GIF, and why. */
export type MemePost = {
  id: string;
  at: number;
  /** `svg`: one Claude drew itself (kept in Cora's memory only, never on disk) */
  kind: 'meme' | 'gif' | 'svg';
  /** the picture: the template's, or the GIF's (an `svg` has none: its drawing is `svg`) */
  url: string;
  /** a meme Claude drew: the whole SVG */
  svg?: string;
  /** a meme's template, and its captions */
  template?: string;
  top?: string;
  bottom?: string;
  /** a GIF: what it was searched for, and its page on Giphy (its attribution) */
  query?: string;
  page?: string;
  /** a line from the session on why */
  why?: string;
};
