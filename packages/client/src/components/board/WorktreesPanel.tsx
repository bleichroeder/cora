import { useEffect, useState } from 'react';
import type { Worktree, WorktreeRepo } from '@cora/shared';
import { removeWorktree, useWorktrees } from '../../state/worktrees';
import { useBrain } from '../../state/store';
import { launchTerminal } from '../../state/ws';
import { desktop } from '../../lib/desktop';
import { ago, sessionColor, sessionName } from '../../lib/format';
import { Icon } from '../Icon';

const STATE_WORD: Record<Worktree['state'], string> = { active: 'active', idle: 'idle', stale: 'stale', done: 'done' };

/**
 * Cora's board: every worktree of your repos, by
 * repo, its main checkout first: who works in each (their orbs), how far it has got, its state. On hover what you can
 * do; done ones gather at the foot to clean up together.
 */
export function WorktreesPanel() {
  const repos = useWorktrees((s) => s.repos);
  const error = useWorktrees((s) => s.error);
  // asking keeps the server reading them while this shows
  useEffect(() => {
    void useWorktrees.getState().load();
    const t = setInterval(() => void useWorktrees.getState().load(), 120_000);
    return () => clearInterval(t);
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(null), 6000);
    return () => clearTimeout(t);
  }, [said]);
  if (!repos) return <div className="lb-empty">{error ?? 'Reading your repos…'}</div>;
  if (!repos.length) return <div className="lb-empty">No repos yet. Worktrees of the repos you give Cora (Settings › Cora) and those your sessions work in show here.</div>;
  const done = repos.flatMap((r) => r.trees.filter((t) => t.state === 'done'));
  const remove = async (paths: string[]) => {
    setBusy(paths.join('|'));
    const out = await Promise.all(paths.map((p) => removeWorktree(p)));
    setBusy(null);
    const kept = out.filter((o) => !o.ok);
    setSaid(kept.length ? `Kept ${kept.length}: ${kept.map((o) => o.why).join('; ')}` : `Removed ${paths.length} worktree${paths.length === 1 ? '' : 's'}`);
  };
  return (
    <div className="wt-panel">
      <div className="wt-scroll">
        {repos.map((r) => (
          <RepoBlock key={r.root} repo={r} busy={busy} onRemove={(p) => void remove([p])} />
        ))}
      </div>
      {said ? <div className="wt-said">{said}</div> : null}
      {done.length ? (
        <div className="wt-done">
          <span>
            {done.length} worktree{done.length === 1 ? '' : 's'} done
            <small>merged, clean, nobody in them</small>
          </span>
          <button disabled={!!busy} onClick={() => void remove(done.map((t) => t.path))}>
            {busy ? 'Removing…' : done.length === 1 ? 'Clean it up' : `Clean up ${done.length === 2 ? 'both' : `all ${done.length}`}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function RepoBlock({ repo, busy, onRemove }: { repo: WorktreeRepo; busy: string | null; onRemove(path: string): void }) {
  return (
    <section className="wt-repo">
      <div className="wt-rh">
        <b>{repo.name}</b>
        {repo.mine ? <span className="mine">· yours</span> : null}
        <span className="rule" />
        <span>{repo.trees.length}</span>
      </div>
      {repo.trees.map((t) => (
        <Row key={t.path} t={t} root={repo.root} busy={!!busy?.split('|').includes(t.path)} onRemove={() => onRemove(t.path)} />
      ))}
    </section>
  );
}

function Row({ t, root, busy, onRemove }: { t: Worktree; root: string; busy: boolean; onRemove(): void }) {
  const sessions = useBrain((s) => s.sessions);
  const setFocus = useBrain((s) => s.setFocus);
  const [sure, setSure] = useState(false);
  const who = t.who.map((id) => sessions[id]).filter(Boolean);
  const coming = (t.coming ?? []).map((id) => sessions[id]).filter(Boolean);
  const mover = coming[0];
  // where it is: under the repo's worktrees folder just its name (the rest is the same for all)
  const rel = t.main ? t.path : t.path.slice(root.length + 1).replace(/\\/g, '/').replace(/^\.claude\/worktrees\//, '');
  const safe = !t.main && !t.who.length && !t.dirty && !t.unpushed;
  const bits = [
    t.ahead ? <span key="a" className="up">↑{t.ahead}</span> : null,
    t.behind ? <span key="b" className="dn">↓{t.behind}</span> : null,
    t.dirty ? <span key="d" className="dirty">{t.dirty} uncommitted</span> : null,
    t.unpushed ? <span key="u">{t.unpushed} unpushed</span> : null,
    t.merged && !t.main ? <span key="m">merged</span> : null,
    t.main ? <span key="p">checkout</span> : null,
    <span key="t">{ago(t.changedAt)} ago</span>,
  ].filter(Boolean);
  return (
    <div className={`wt-row${t.main ? ' main' : ''}${mover ? ' moving' : ''}`} style={mover ? { ['--k' as string]: sessionColor(mover) } : undefined} title={t.path}>
      <span className="wt-ic">
        <Icon name={t.main ? 'House' : 'GitBranch'} size={14} />
      </span>
      <span className="wt-mid">
        <b>{t.branch ?? '(detached)'}</b>
        <span className="wt-l2">
          {mover ? <span className="wt-mv">{sessionName(mover)} moving in</span> : <>{!t.main ? <span className="path">{rel}</span> : null}{bits}</>}
        </span>
      </span>
      <span className="wt-right">
        {who.length ? (
          <span className="wt-who">
            {who.slice(0, 4).map((s) => (
              <i key={s!.id} style={{ ['--k' as string]: sessionColor(s!) }} title={sessionName(s!)} onClick={() => setFocus(s!.id)} />
            ))}
          </span>
        ) : null}
        {sure ? (
          <span className="wt-sure">
            Remove{t.branch ? ' it and its branch' : ''}?
            <button className="no" onClick={() => setSure(false)}>Keep</button>
            <button className="yes" disabled={busy} onClick={() => (setSure(false), onRemove())}>Remove</button>
          </span>
        ) : (
          <>
            <span className={`wt-chip ${t.state}`}>{t.main && who.length ? `${who.length} here` : STATE_WORD[t.state]}</span>
            <span className="wt-acts">
              {who[0] ? (
                <button title={`Go to ${sessionName(who[0])}`} onClick={() => setFocus(who[0]!.id)}>
                  <Icon name="ArrowUpRight" size={14} />
                </button>
              ) : null}
              <button title="Start a session here" onClick={() => void launchTerminal({ mode: 'new', cwd: t.path })}>
                <Icon name="Play" size={13} />
              </button>
              <button title="Copy its path" onClick={() => (desktop?.writeClipboard ? desktop.writeClipboard(t.path) : void navigator.clipboard?.writeText(t.path))}>
                <Icon name="Copy" size={13} />
              </button>
              {safe ? (
                <button className="rm" title={t.state === 'done' ? 'Remove it and its branch' : 'Remove it (nothing in it is at risk)'} onClick={() => setSure(true)}>
                  <Icon name="Trash2" size={13} />
                </button>
              ) : null}
            </span>
          </>
        )}
      </span>
    </div>
  );
}
