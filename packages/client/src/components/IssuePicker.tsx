import { useEffect, useState } from 'react';
import { issueRef, parseIssueInput, type GitlabIssue, type SessionInfo } from '@cora/shared';
import { ago } from '../lib/format';
import { openInBrowser } from './JiraChip';
import { BrandIcon } from './BrandIcon';
import { Icon } from './Icon';

/** The issue picked in the New session dialog: its project and number (its title when it came from your list). */
export type PickedIssue = { project: string; iid: number; title?: string };

type Mine = { ok: true; issues: GitlabIssue[] } | { ok: false; kind: string; error: string };
type One = { ok: true; issue: GitlabIssue } | { ok: false; kind: string; error: string };

/** Read one issue (with its description) through Cora's glab. */
export const fetchIssue = (p: { project: string; iid: number }): Promise<One> =>
  fetch(`/api/gitlab/issue?project=${encodeURIComponent(p.project)}&iid=${p.iid}`)
    .then((r) => r.json() as Promise<One>)
    .catch(() => ({ ok: false as const, kind: 'offline', error: "Cora's server didn't answer" }));

/** The project's last part: acme/web/app → app (its whole path in the row's tooltip). */
const projectName = (p: string) => p.split('/').pop() ?? p;

/**
 * The New session dialog's GitLab issue: one of your open issues (assigned to you, any project), or a link or a
 * group/project#123 pasted in (looked up as you type). Enter (or a double-click) starts.
 */
export function IssuePicker({ host, picked, onPick, onStart }: { host: string; picked: PickedIssue | null; onPick(i: PickedIssue | null): void; onStart(): void }) {
  const [list, setList] = useState<Mine | null>(null);
  const [text, setText] = useState('');
  const pasted = host ? parseIssueInput(text, host) : null;
  useEffect(() => {
    let live = true;
    void fetch('/api/gitlab/issues')
      .then((r) => r.json() as Promise<Mine>)
      .then((r) => live && setList(r))
      .catch(() => live && setList({ ok: false, kind: 'offline', error: "Cora's server didn't answer" }));
    return () => void (live = false);
  }, []);
  const type = (v: string) => {
    setText(v);
    onPick(host ? parseIssueInput(v, host) : null);
  };
  const issues = list?.ok ? list.issues : [];
  const same = (i: { project: string; iid: number }) => !!picked && picked.project.toLowerCase() === i.project.toLowerCase() && picked.iid === i.iid;
  return (
    <div className="tpick">
      <label className="field">
        <span>Issue</span>
        <input
          value={text}
          autoFocus
          spellCheck={false}
          placeholder="paste an issue link (or group/project#123), or pick one below"
          onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && picked && onStart()}
        />
      </label>
      {text.trim() ? pasted ? <PastedIssue i={pasted} /> : <div className="tp-msg">Not an issue: paste a link to one on {host || 'your GitLab'}, or group/project#123.</div> : null}
      {list && !list.ok ? (
        <div className={`tp-msg${list.kind === 'signed-out' || list.kind === 'no-glab' ? ' warn' : ''}`}>
          {list.kind === 'no-glab' ? (
            <>GitLab is read with the glab CLI, and it isn&apos;t installed. A pasted link can&apos;t be read either until it is.</>
          ) : list.kind === 'signed-out' ? (
            <>
              <Icon name="LogIn" size={12} /> glab isn&apos;t signed in to {host}: run <code>glab auth login</code> to list your issues.
            </>
          ) : (
            <>Couldn&apos;t list your issues ({list.kind === 'offline' ? `${host} is out of reach` : list.error}). A pasted link still works.</>
          )}
        </div>
      ) : null}
      {!list ? <div className="tp-msg">Looking up your open issues…</div> : null}
      {list?.ok && !issues.length ? <div className="tp-msg">Nothing open is assigned to you.</div> : null}
      {issues.length ? (
        <div className="tp-list" role="listbox" aria-label="Your open issues">
          {issues.map((i) => (
            <button
              key={issueRef(i)}
              role="option"
              aria-selected={same(i)}
              className={`tp-row gl-row${same(i) ? ' on' : ''}`}
              onClick={() => (setText(''), onPick({ project: i.project, iid: i.iid, title: i.title }))}
              onDoubleClick={onStart}
              title={`${issueRef(i)} · ${i.title}${i.labels.length ? `\n${i.labels.join(', ')}` : ''}`}
            >
              <BrandIcon source="gitlab" size={12} />
              <span className="tk gl">
                {projectName(i.project)} #{i.iid}
              </span>
              <span className="tsum">{i.title}</span>
              {i.labels.slice(0, 2).map((l) => (
                <span key={l} className="gl-lbl">
                  {l}
                </span>
              ))}
              {i.updatedAt ? <span className="gl-when">{ago(i.updatedAt)}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A pasted issue, looked up: its title and state, or why there's none. */
function PastedIssue({ i }: { i: { project: string; iid: number } }) {
  const [r, setR] = useState<One | null>(null);
  useEffect(() => {
    let live = true;
    setR(null);
    void fetchIssue(i).then((x) => live && setR(x));
    return () => void (live = false);
  }, [i.project, i.iid]);
  if (r?.ok)
    return (
      <div className="tp-row gl-row on static">
        <BrandIcon source="gitlab" size={12} />
        <span className="tk gl">
          {projectName(r.issue.project)} #{r.issue.iid}
        </span>
        <span className="tsum">{r.issue.title}</span>
        <span className="gl-lbl">{r.issue.state}</span>
      </div>
    );
  return (
    <div className={`tp-msg${r && !r.ok ? ' warn' : ''}`}>
      <span className="tk gl">{issueRef(i)}</span> · {!r ? 'looking it up…' : !r.ok ? r.error : ''}
    </div>
  );
}

/** The issue a session is about: `#123` (in the list, quiet) that opens it in the session's browser. */
export function IssueChip({ s, header = false }: { s: Pick<SessionInfo, 'id' | 'issue'>; header?: boolean }) {
  const i = s.issue;
  if (!i) return null;
  return (
    <span
      role="link"
      tabIndex={0}
      className={`gl-chip${header ? ' head' : ''}`}
      title={`${issueRef(i)}${i.title ? `: ${i.title}` : ''} (open it)`}
      onClick={(e) => (e.stopPropagation(), openInBrowser(i.url, s.id))}
      onKeyDown={(e) => e.key === 'Enter' && (e.stopPropagation(), openInBrowser(i.url, s.id))}
    >
      {header ? <BrandIcon source="gitlab" size={12} /> : null}#{i.iid}
      {header && i.title ? <span className="gl-t">{i.title}</span> : null}
    </span>
  );
}
