import { describe, expect, it } from 'vitest';
import { webChangeOf, webChangeText, webChangeUrl } from '../src/webChange';

describe('what a session changed on the web', () => {
  it('Jira, through Atlassian’s tools: a comment (straight to it), a move, an edit, a new ticket', () => {
    const c = webChangeOf('mcp__atlassian__addOrEditJiraIssueComment', { cloudId: 'x', issueIdOrKey: 'web-123', commentBody: 'Done' }, [{ type: 'text', text: '{"self":"https://api.atlassian.com/ex/jira/abc/rest/api/3/issue/10001/comment/20456","id":"20456"}' }]);
    expect(c).toEqual({ what: 'comment', target: 'WEB-123', jira: { key: 'WEB-123', commentId: '20456' } });
    expect(webChangeText(c!)).toBe('Commented on WEB-123');
    expect(webChangeUrl(c!, 'acme.atlassian.net')).toBe('https://acme.atlassian.net/browse/WEB-123?focusedCommentId=20456');
    expect(webChangeUrl(c!, null)).toBeNull();
    expect(webChangeOf('mcp__atlassian__transitionJiraIssue', { issueIdOrKey: 'WEB-9' }, 'ok')).toMatchObject({ what: 'move', target: 'WEB-9' });
    expect(webChangeOf('mcp__claude_ai_Atlassian__editJiraIssue', { issueIdOrKey: 'WEB-9' }, 'ok')).toMatchObject({ what: 'edit' });
    expect(webChangeOf('mcp__atlassian__createJiraIssue', { projectKey: 'WEB' }, '{"key":"WEB-200"}')).toMatchObject({ what: 'create', target: 'WEB-200' });
    // reading isn't changing
    expect(webChangeOf('mcp__atlassian__getJiraIssue', { issueIdOrKey: 'WEB-9' }, '{}')).toBeNull();
  });

  it('GitLab notes and merge requests, by MCP or glab; GitHub by gh: the link the answer gave', () => {
    expect(webChangeOf('mcp__GitLab__save_note', { project: 'g/p', body: 'x' }, '{"id":991,"noteable_iid":12,"web_url":"https://gitlab.com/g/p/-/merge_requests/12"}')).toEqual({ what: 'comment', target: '!12', url: 'https://gitlab.com/g/p/-/merge_requests/12#note_991' });
    expect(webChangeOf('mcp__GitLab__save_merge_request', { project: 'g/p', title: 't' }, '{"web_url":"https://gitlab.com/g/p/-/merge_requests/13"}')).toMatchObject({ what: 'create', target: '!13' });
    expect(webChangeOf('Bash', { command: 'glab mr note 12 -m "LGTM"' }, { stdout: 'https://gitlab.com/g/p/-/merge_requests/12#note_1234\n' })).toEqual({ what: 'comment', target: '!12', url: 'https://gitlab.com/g/p/-/merge_requests/12#note_1234' });
    expect(webChangeOf('Bash', { command: 'gh pr comment 5 --body hi' }, { stdout: 'https://github.com/o/r/pull/5#issuecomment-77' })).toMatchObject({ what: 'comment', target: '!5' });
    expect(webChangeOf('Bash', { command: 'gh issue create -t bug' }, { stdout: 'https://github.com/o/r/issues/8\n' })).toMatchObject({ what: 'create', target: '#8', url: 'https://github.com/o/r/issues/8' });
    // looking isn't changing; no link in the answer: nothing to show
    expect(webChangeOf('Bash', { command: 'glab mr view 12' }, { stdout: 'https://gitlab.com/g/p/-/merge_requests/12' })).toBeNull();
    expect(webChangeOf('Bash', { command: 'glab mr note 12 -m x' }, { stdout: 'done' })).toBeNull();
  });
});
