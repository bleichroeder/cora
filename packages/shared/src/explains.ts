/** An explain's title as a folder name: lower case, letters, digits and dashes, never empty. */
export function explainSlug(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');
  return s || 'live';
}

/**
 * Sharing an explain: Cora writes a self-contained copy of it, `share-<slug>.html` in the explain's folder, and asks its
 * session to publish that as a claude.ai artifact. The session's publish is how Cora learns the link.
 */
export const shareFileName = (title: string) => `share-${explainSlug(title)}.html`;

/** The claude.ai artifact link in a publish's result, if any. */
export function artifactUrl(text: string): string | null {
  return /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/.exec(text)?.[0] ?? null;
}
