/**
 * Your GitLab to-dos (GitLab's own To-Do list): an MR or issue assigned to you, your review requested, a mention, an
 * approval needed, your MR's pipeline failed. Cora reads them (never marks them done) into its Inbox, tells Cora's
 * agent, and pings your phone while you're away, as it does for Jira.
 */
export type GitlabTodo = {
  /** GitLab's id for the to-do */
  id: number;
  /** what it's for: assigned, mentioned, directly_addressed, review_requested, approval_required, build_failed, … */
  action: string;
  /** MergeRequest, Issue, … */
  type: string;
  /** group/project */
  project: string;
  /** `!12` (an MR), `#34` (an issue), or '' */
  ref: string;
  title: string;
  /** who did it */
  who: string;
  /** the comment, or the title */
  text: string;
  link: string;
  at: number;
};

const WHY: Record<string, string> = {
  assigned: 'assigned to you',
  mentioned: 'you were mentioned',
  directly_addressed: 'addressed to you',
  review_requested: 'your review was requested',
  review_submitted: 'your MR was reviewed',
  approval_required: 'your approval is needed',
  build_failed: 'its pipeline failed',
  unmergeable: "it can't be merged",
  marked: 'you added it to your to-dos',
  merge_train_removed: 'removed from the merge train',
  member_access_requested: 'someone asked for access',
};

/** Why a to-do is yours, in words (the Inbox's "why"). */
export const todoWhy = (action: string) => WHY[action] ?? action.replace(/_/g, ' ');

/** The kinds that ping your phone while you're away (others just wait in the Inbox). */
export const TODO_PINGS = new Set(['assigned', 'mentioned', 'directly_addressed', 'review_requested', 'review_submitted', 'approval_required']);
