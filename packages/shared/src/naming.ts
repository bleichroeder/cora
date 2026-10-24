import type { SessionInfo } from './types';

/**
 * What a session is called everywhere (the nav, Resume, the switcher): your name for it, then its ticket (key and
 * summary), its GitLab issue's title, Cora's suggested name, Claude Code's title, the folder.
 */
export function displayName(s: Pick<SessionInfo, 'id' | 'alias' | 'autoName' | 'title' | 'project' | 'ticket' | 'issue'>): string {
  return (
    s.alias ||
    (s.ticket?.summary ? `${s.ticket.key} · ${s.ticket.summary}` : '') ||
    s.issue?.title ||
    s.autoName ||
    s.title ||
    s.project ||
    s.id.slice(0, 8)
  );
}

/** A name worth remembering past Cora's history (one you or Cora gave it, not just Claude Code's own title). */
export const hasOwnName = (s: Pick<SessionInfo, 'alias' | 'autoName' | 'ticket' | 'issue'>) => !!(s.alias || s.autoName || s.ticket?.summary || s.issue?.title);
