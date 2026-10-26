/**
 * Something a session changed on the web (docs/backlog.md "Browser control" 1): a Jira comment, edit or move; a GitLab
 * or GitHub note, merge request or issue. Recognised from the tool that did it (Atlassian's and GitLab's MCP tools,
 * `glab` and `gh` in a shell), with the link straight to the change where the site has one (Jira's focusedCommentId,
 * GitLab's #note_…, GitHub's #issuecomment-…), so the page opens on it, highlighted by the site itself.
 */
export type WebChange = {
  what: 'comment' | 'edit' | 'move' | 'create' | 'merge' | 'close';
  /** a ticket's key, or a merge request / issue (`!12`, `#34`) */
  target: string;
  /** the link, when the tool's answer gave one */
  url?: string;
  /** a Jira ticket (its link is made with the site's address, which the tool doesn't give) */
  jira?: { key: string; commentId?: string };
};

const WORDS: Record<WebChange['what'], string> = { comment: 'Commented on', edit: 'Edited', move: 'Moved', create: 'Created', merge: 'Merged', close: 'Closed' };
/** How it reads: "Commented on WEB-123". */
export const webChangeText = (w: WebChange) => `${WORDS[w.what]} ${w.target}`;

/** The link to open: the tool's, or a Jira ticket's on the user's site (`site`: its host). */
export function webChangeUrl(w: WebChange, site?: string | null): string | null {
  if (w.url) return w.url;
  if (w.jira && site) return `https://${site.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/browse/${encodeURIComponent(w.jira.key)}${w.jira.commentId ? `?focusedCommentId=${encodeURIComponent(w.jira.commentId)}` : ''}`;
  return null;
}

/** A tool's answer as text (MCP answers come as content blocks; shells as stdout). */
function answerText(r: unknown): string {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) return r.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : answerText(b))).join('\n');
  if (typeof r === 'object') {
    const o = r as Record<string, unknown>;
    if (typeof o.stdout === 'string') return `${o.stdout}\n${typeof o.stderr === 'string' ? o.stderr : ''}`;
    if (Array.isArray(o.content)) return answerText(o.content);
    try {
      return JSON.stringify(r);
    } catch {
      return '';
    }
  }
  return String(r);
}

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const firstUrl = (text: string, re: RegExp) => text.match(re)?.[0]?.replace(/[)\]"'.,]+$/, '');
const GITLAB_NOTE = /https?:\/\/[^\s"'<>]+\/-\/(?:merge_requests|issues|work_items)\/\d+#note_\d+/;
const GITLAB_ITEM = /https?:\/\/[^\s"'<>]+\/-\/(?:merge_requests|issues|work_items)\/\d+/;
const GITHUB_COMMENT = /https:\/\/github\.com\/[^\s"'<>]+\/(?:issues|pull)\/\d+#issuecomment-\d+/;
const GITHUB_ITEM = /https:\/\/github\.com\/[^\s"'<>]+\/(?:issues|pull)\/\d+/;
const targetOf = (url: string) => {
  const m = /\/(merge_requests|pull|issues|work_items)\/(\d+)/.exec(url);
  return m ? `${m[1] === 'merge_requests' || m[1] === 'pull' ? '!' : '#'}${m[2]}` : url;
};

/** What a finished tool call changed on the web, if anything (null: nothing, or it failed). */
export function webChangeOf(name: string, input: unknown, response: unknown): WebChange | null {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const op = name.split('__').pop() ?? name;
  const server = name.startsWith('mcp__') ? name.split('__')[1].toLowerCase() : '';
  // Jira, through Atlassian's MCP tools
  if (server.includes('atlassian')) {
    const key = String(inp.issueIdOrKey ?? inp.issueKey ?? '').toUpperCase();
    if (!KEY.test(key)) {
      if (op !== 'createJiraIssue') return null;
      const made = /"key"\s*:\s*"([A-Z][A-Z0-9_]+-\d+)"/.exec(answerText(response))?.[1];
      return made ? { what: 'create', target: made, jira: { key: made } } : null;
    }
    if (op === 'addOrEditJiraIssueComment' || op === 'addCommentToJiraIssue') {
      const text = answerText(response);
      const commentId = /\/comment\/(\d+)/.exec(text)?.[1] ?? /"id"\s*:\s*"?(\d+)"?/.exec(text)?.[1];
      return { what: 'comment', target: key, jira: { key, ...(commentId ? { commentId } : {}) } };
    }
    if (op === 'transitionJiraIssue') return { what: 'move', target: key, jira: { key } };
    if (op === 'editJiraIssue') return { what: 'edit', target: key, jira: { key } };
    return null;
  }
  // GitLab, through its MCP tools
  if (server === 'gitlab') {
    const text = answerText(response);
    if (op === 'save_note' || op === 'create_note' || op === 'create_merge_request_note' || op === 'create_issue_note') {
      const url = firstUrl(text, GITLAB_NOTE) ?? (() => {
        const item = firstUrl(text, GITLAB_ITEM);
        const id = /"id"\s*:\s*(\d+)/.exec(text)?.[1];
        return item && id ? `${item}#note_${id}` : item;
      })();
      return url ? { what: 'comment', target: targetOf(url), url } : null;
    }
    if (op === 'save_merge_request' || op === 'save_work_item' || op === 'create_merge_request' || op === 'create_issue' || op === 'accept_merge_request') {
      const url = /"web_url"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? firstUrl(text, GITLAB_ITEM);
      if (!url) return null;
      return { what: op === 'accept_merge_request' ? 'merge' : inp.id || inp.iid ? 'edit' : 'create', target: targetOf(url), url };
    }
    return null;
  }
  // glab and gh in a shell
  if (name === 'Bash' || name === 'PowerShell') {
    const cmd = String(inp.command ?? '');
    const m = /\b(glab|gh)\s+(mr|pr|issue)\s+(note|comment|create|edit|update|close|merge|reopen)\b/.exec(cmd);
    if (!m) return null;
    const text = answerText(response);
    const gh = m[1] === 'gh';
    const what: WebChange['what'] = m[3] === 'note' || m[3] === 'comment' ? 'comment' : m[3] === 'create' ? 'create' : m[3] === 'merge' ? 'merge' : m[3] === 'close' ? 'close' : 'edit';
    const url = what === 'comment' ? (firstUrl(text, gh ? GITHUB_COMMENT : GITLAB_NOTE) ?? firstUrl(text, gh ? GITHUB_ITEM : GITLAB_ITEM)) : firstUrl(text, gh ? GITHUB_ITEM : GITLAB_ITEM);
    return url ? { what, target: targetOf(url), url } : null;
  }
  return null;
}
