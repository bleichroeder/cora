import { INBOX_LABELS, type InboxSource } from '@cora/shared';

// The services' own marks, so nothing new has to be learnt: Jira, Gmail and GitLab from Simple Icons (CC0); Slack's
// isn't there any more (removed at Slack's request), so it's Lucide's Slack glyph in Slack's four colours.
const JIRA = 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z';
const GMAIL = 'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z';
const GITLAB = 'm23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z';

/** Each source's colour (its tile's tint). */
export const BRAND_COLOR: Record<InboxSource, string> = { jira: '#2684FF', slack: '#E01E5A', mail: '#EA4335', gitlab: '#FC6D26', cora: 'var(--cora)' };
export const SOURCE_LABEL = INBOX_LABELS;

/** A source's logo: Jira, Slack, Gmail, GitLab; Cora's is its lens. */
export function BrandIcon({ source, size = 14 }: { source: InboxSource; size?: number }) {
  if (source === 'cora') return <span className="brand-lens" style={{ width: size - 2, height: size - 2 }} aria-hidden />;
  const svg = (children: React.ReactNode) => (
    <svg className="brand" viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      {children}
    </svg>
  );
  if (source === 'slack')
    return svg(
      <>
        <g fill="#2EB67D"><rect width="3" height="8" x="13" y="2" rx="1.5" /><path d="M19 8.5V10h1.5A1.5 1.5 0 1 0 19 8.5" /></g>
        <g fill="#E01E5A"><rect width="3" height="8" x="8" y="14" rx="1.5" /><path d="M5 15.5V14H3.5A1.5 1.5 0 1 0 5 15.5" /></g>
        <g fill="#ECB22E"><rect width="8" height="3" x="14" y="13" rx="1.5" /><path d="M15.5 19H14v1.5a1.5 1.5 0 1 0 1.5-1.5" /></g>
        <g fill="#36C5F0"><rect width="8" height="3" x="2" y="8" rx="1.5" /><path d="M8.5 5H10V3.5A1.5 1.5 0 1 0 8.5 5" /></g>
      </>,
    );
  return svg(<path fill={BRAND_COLOR[source]} d={source === 'jira' ? JIRA : source === 'mail' ? GMAIL : GITLAB} />);
}
