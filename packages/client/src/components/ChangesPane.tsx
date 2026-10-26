import { useEffect, useMemo, useState } from 'react';
import { sessionEvents, useBrain } from '../state/store';
import { changeTurns, openChanges, relPath, samePath } from '../lib/changes';
import { clock } from '../lib/format';
import { Counts } from './DiffView';
import { Icon } from './Icon';
import { webChangeText } from '@cora/shared';
import { webChangeLink } from '../state/webChanges';
import { useWeb } from '../state/web';
import { showInIde } from './board/IdePanel';

type GitFile = { path: string; status: string; add: number; del: number; binary?: boolean };
const STATUS: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', '??': 'new, untracked', AM: 'added', MM: 'modified' };

/** The Changes tab: what each turn changed (live), and what git says is uncommitted (shell edits included). */
export function ChangesPane({ sessionId }: { sessionId: string }) {
  const version = useBrain((s) => s.versions[sessionId] ?? 0);
  const cwd = useBrain((s) => s.sessions[sessionId]?.cwd);
  const diff = useBrain((s) => s.diff);
  const turns = useMemo(() => changeTurns(sessionEvents(sessionId), cwd), [sessionId, cwd, version]);
  const [git, setGit] = useState<{ repo: boolean; root?: string; branch?: string; files: GitFile[] } | null>(null);
  const [gitOpen, setGitOpen] = useState(true);

  // git status: on open, and a moment after changes land
  useEffect(() => {
    let dead = false;
    const t = setTimeout(() => {
      void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/changes/git`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => !dead && setGit(j));
    }, git ? 1500 : 0);
    return () => {
      dead = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, turns.length, turns.at(-1)?.files.length, turns.at(-1)?.add]);

  const edited = useMemo(() => turns.flatMap((t) => t.files.map((f) => f.path)), [turns]);
  // files counted once however many turns touched them (the tab's count does the same)
  const total = { ...turns.reduce((o, t) => ({ add: o.add + t.add, del: o.del + t.del }), { add: 0, del: 0 }), n: new Set(edited).size };
  const live = turns.at(-1)?.to == null;
  // "in the IDE": a turn's change to a file as a diff there (or the file); says so when no IDE panel is open
  const [ideMiss, setIdeMiss] = useState<string | null>(null);
  const toIde = (e: React.MouseEvent, path: string, span?: { from: number; to: number | null }) => {
    e.stopPropagation();
    void showInIde(sessionId, path, span ?? {}).then((ok) => {
      if (ok) return;
      setIdeMiss(path);
      setTimeout(() => setIdeMiss((p) => (p === path ? null : p)), 3500);
    });
  };
  const ideBtn = (path: string, span?: { from: number; to: number | null }) => (
    <span role="button" tabIndex={-1} className={`ch-ide${ideMiss === path ? ' miss' : ''}`} title={span ? "Claude's change to it, as a diff in the IDE panel" : 'Open it in the IDE panel'} onClick={(e) => toIde(e, path, span)}>
      {ideMiss === path ? 'open an IDE panel' : <Icon name="Code" size={12} />}
    </span>
  );
  // what it changed on the web (newest first): each opens in its browser, at the change
  const web = useMemo(() => sessionEvents(sessionId).filter((e) => e.kind === 'tool' && e.phase === 'end' && e.tool?.web).reverse(), [sessionId, version]);

  return (
    <div className="changes">
      <div className="ch-h">
        <span className="ch-sum">
          {total.n ? (
            <>
              {total.n} file{total.n === 1 ? '' : 's'} · <Counts add={total.add} del={total.del} />
            </>
          ) : (
            'No changes yet'
          )}
        </span>
        <span className="sp" />
        {turns.length ? (
          <button
            className="dl-btn"
            title="Review the latest turn, file by file"
            onClick={() => {
              const t = turns.at(-1)!;
              openChanges(sessionId, t.files[0].path, { from: t.from, to: t.to });
              useBrain.getState().setDiffWide(true);
            }}
          >
            <Icon name="Maximize2" size={13} /> Review
          </button>
        ) : null}
      </div>
      {web.length ? (
        <div className="ch-turn ch-web">
          <div className="ch-th">
            <span className="p">On the web</span>
            <span className="ch-rule" />
          </div>
          {web.map((e) => {
            const url = webChangeLink(e);
            return (
              <button key={e.id} className="ch-f" disabled={!url} title={url ?? 'No link to it (or not on one of your sites)'} onClick={() => url && (useWeb.getState().open(sessionId, url, { reload: true }), useWeb.getState().setShown(sessionId, true))}>
                <span className="fn">
                  <span className="nm">
                    <Icon name="Globe" size={11} /> {webChangeText(e.tool!.web!)}
                  </span>
                </span>
                <span className="dsrc">{clock(e.ts)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {!turns.length ? <div className="ch-empty">No file changes yet in this session. Edits Claude makes show up here as they happen; click a file to see exactly what changed.</div> : null}
      {[...turns].reverse().map((t, i) => (
        <div key={t.key} className="ch-turn">
          <div className="ch-th" title={`${t.files.length} file${t.files.length === 1 ? '' : 's'} · +${t.add} −${t.del}`}>
            <span className="p" title={t.prompt}>{t.prompt ? `“${t.prompt}”` : 'Earlier in the session'}</span>
            <span className="ch-rule" />
            <span className="t">{i === 0 && live ? <span className="live">now</span> : clock(t.from)}</span>
          </div>
          {t.files.map((f) => {
            const sel = diff?.mode === 'turn' && diff.sessionId === sessionId && diff.from === t.from && samePath(diff.path, f.path);
            return (
              <button key={f.path} className={`ch-f${sel ? ' sel' : ''}`} onClick={() => openChanges(sessionId, f.path, { from: t.from, to: t.to })} title={f.path}>
                <span className="fn">
                  <span className="nm">{f.rel.split('/').pop()}</span>
                  <span className="dir">{f.rel.split('/').slice(0, -1).join('/')}</span>
                </span>
                {f.isNew ? <span className="dsrc new">new</span> : f.edits.length > 1 ? <span className="dsrc">{f.edits.length} edits</span> : null}
                <Counts add={f.add} del={f.del} />
                {ideBtn(f.path, { from: t.from, to: t.to ?? null })}
              </button>
            );
          })}
        </div>
      ))}
      {git?.repo ? (
        <div className="ch-git">
          <button className="ch-gh" onClick={() => setGitOpen(!gitOpen)}>
            <Icon name="ChevronDown" size={11} className={`ch-chev${gitOpen ? '' : ' closed'}`} />
            <span>Uncommitted{git.branch ? ` · ${git.branch}` : ''}</span>
            <span className="ch-n">{git.files.length}</span>
            <span className="ch-rule" />
          </button>
          {gitOpen ? (
            git.files.length ? (
              git.files.map((f) => {
                const byClaude = edited.some((p) => samePath(p, f.path));
                const sel = diff?.mode === 'git' && diff.sessionId === sessionId && samePath(diff.path, f.path);
                const rel = relPath(f.path, cwd);
                return (
                  <button key={f.path} className={`ch-f${sel ? ' sel' : ''}`} onClick={() => openChanges(sessionId, f.path, { mode: 'git' })} title={`${f.path} · ${STATUS[f.status] ?? f.status}`}>
                    <span className={`gst s-${f.status === '??' ? 'u' : f.status[0]?.toLowerCase()}`}>{f.status === '??' ? 'U' : f.status[0]}</span>
                    <span className="fn">
                      <span className="nm">{rel.split('/').pop()}</span>
                      <span className="dir">{rel.split('/').slice(0, -1).join('/')}</span>
                    </span>
                    {!byClaude ? <span className="dsrc git" title="Not changed by Claude's edit tools this session: a shell command, a script, or you">other</span> : null}
                    {f.binary ? <span className="dsrc">binary</span> : <Counts add={f.add} del={f.del} />}
                    {git?.root ? ideBtn(`${git.root.replace(/[\\/]+$/, '')}/${f.path}`) : null}
                  </button>
                );
              })
            ) : (
              <div className="ch-empty">Nothing uncommitted.</div>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
