import { useEffect, useMemo, useRef, useState } from 'react';
import { diffWordsWithSpace, formatPatch, parsePatch } from 'diff';
import type { Hunk } from '@cora/shared';
import { sessionEvents, useBrain, type DiffTarget } from '../state/store';
import { changeOf, changeTurns, hunkStats, openChanges, relPath, samePath, type FileGroup } from '../lib/changes';
import { highlight, langOf } from '../lib/highlight';
import { clock } from '../lib/format';
import { desktop } from '../lib/desktop';
import { Icon } from './Icon';
import './viewer.css';

type Row = { t: 'c'; o: number; n: number; s: string } | { t: 'p'; d?: string; a?: string; o: number | null; n: number | null };

/** A hunk's lines as display rows: context, or removed/added runs paired line by line (for word-level marks). */
function rows(h: Hunk): Row[] {
  const out: Row[] = [];
  let o = h.oldStart;
  let n = h.newStart;
  const L = h.lines.filter((l) => !l.startsWith('\\'));
  let i = 0;
  while (i < L.length) {
    if (L[i][0] !== '-' && L[i][0] !== '+') {
      out.push({ t: 'c', o: o++, n: n++, s: L[i].slice(1) });
      i++;
      continue;
    }
    const del: string[] = [];
    const add: string[] = [];
    while (i < L.length && L[i][0] === '-') del.push(L[i++].slice(1));
    while (i < L.length && L[i][0] === '+') add.push(L[i++].slice(1));
    for (let k = 0; k < Math.max(del.length, add.length); k++) out.push({ t: 'p', d: del[k], a: add[k], o: del[k] != null ? o++ : null, n: add[k] != null ? n++ : null });
  }
  return out;
}

/** Word-level changes between a removed and an added line, highlighted per segment. */
function words(oldS: string, newS: string, lang: string | null) {
  if (oldS.length + newS.length > 1200) return null; // long lines: line-level only
  const parts = diffWordsWithSpace(oldS, newS);
  const side = (keepOld: boolean) =>
    parts
      .filter((p) => !(keepOld ? p.added : p.removed))
      .map((p) => (p.added || p.removed ? `<span class="wd">${highlight(p.value, lang)}</span>` : highlight(p.value, lang)))
      .join('');
  return { old: side(true), new: side(false) };
}

const html = (h: string) => ({ dangerouslySetInnerHTML: { __html: h || '&#8203;' } });
const sig = (h: Hunk) => h.lines.join('\n');

function HunkView({ h, lang, split, fresh, cur, onAsk, href }: { h: Hunk; lang: string | null; split: boolean; fresh: boolean; cur: boolean; onAsk(a: number, b: number): void; href: (line: number) => string }) {
  const rs = useMemo(() => rows(h), [h]);
  const first = Math.max(1, h.newStart);
  const last = h.newStart + Math.max(0, h.newLines - 1);
  return (
    <div className={`dh${fresh ? ' fresh' : ''}`}>
      <div className={`dh-h${cur ? ' cur' : ''}`}>
        <span>@@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</span>
        <span className="sp" />
        <a className="dh-b" href={href(first)} title="Open in VS Code at this line">open</a>
        <button className="dh-b" onClick={() => onAsk(first, last)} title="Put a reference to these lines into your prompt">ask Claude about this</button>
      </div>
      {split ? (
        <table className="dt s">
          <tbody>
            {rs.map((r, i) => {
              if (r.t === 'c') {
                const c = highlight(r.s, lang);
                return (
                  <tr key={i}>
                    <td className="n">{r.o}</td><td className="sepl" {...html(c)} /><td className="n">{r.n}</td><td {...html(c)} />
                  </tr>
                );
              }
              const w = r.d != null && r.a != null ? words(r.d, r.a, lang) : null;
              return (
                <tr key={i}>
                  <td className="n">{r.o ?? ''}</td>
                  {r.d != null ? <td className="d sepl" {...html(w ? w.old : highlight(r.d, lang))} /> : <td className="x sepl" />}
                  <td className="n">{r.n ?? ''}</td>
                  {r.a != null ? <td className="a" {...html(w ? w.new : highlight(r.a, lang))} /> : <td className="x" />}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <table className="dt u">
          <tbody>
            {rs.flatMap((r, i) => {
              if (r.t === 'c') return [<tr key={i}><td className="n">{r.o}</td><td className="n">{r.n}</td><td className="m"> </td><td {...html(highlight(r.s, lang))} /></tr>];
              const w = r.d != null && r.a != null ? words(r.d, r.a, lang) : null;
              const out = [];
              if (r.d != null) out.push(<tr key={`${i}d`} className="d"><td className="n">{r.o}</td><td className="n" /><td className="m">−</td><td {...html(w ? w.old : highlight(r.d, lang))} /></tr>);
              if (r.a != null) out.push(<tr key={`${i}a`} className="a"><td className="n" /><td className="n">{r.n}</td><td className="m">+</td><td {...html(w ? w.new : highlight(r.a, lang))} /></tr>);
              return out;
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export const Counts = ({ add, del }: { add: number; del: number }) => {
  const n = add + del || 1;
  const k = 5;
  const ai = Math.round((add / n) * k);
  const di = Math.min(k - ai, Math.round((del / n) * k));
  return (
    <span className="dcount">
      <span className="plus">+{add}</span> <span className="minus">−{del}</span>
      <span className="dbar">{Array.from({ length: k }, (_, i) => <i key={i} className={i < ai ? 'a' : i < ai + di ? 'd' : ''} />)}</span>
    </span>
  );
};

type Net = { hunks: Hunk[] | null; exact: boolean; add: number; del: number; tooBig?: boolean };
const prefSplit = () => {
  try {
    return localStorage.getItem('ab:diffSplit') === '1';
  } catch {
    return false;
  }
};

/**
 * A file's changes, in the viewer: within a turn (net, from Claude Code's snapshot, or edit by edit as each
 * landed) or uncommitted in git. Live: new edits slide in while the agent works; "follow" jumps to whatever it edits next.
 */
export function DiffView({ sessionId }: { sessionId: string }) {
  const d = useBrain((s) => s.diff) as DiffTarget;
  const wide = useBrain((s) => s.diffWide);
  const version = useBrain((s) => s.versions[sessionId] ?? 0);
  const cwd = useBrain((s) => s.sessions[sessionId]?.cwd);
  const terminal = useBrain((s) => s.terminals.find((t) => t.sessionId === sessionId && t.alive));
  const [split, setSplitState] = useState(prefSplit);
  const setSplit = (v: boolean) => {
    setSplitState(v);
    try {
      localStorage.setItem('ab:diffSplit', v ? '1' : '0');
    } catch {
      /* no storage */
    }
  };
  const [net, setNet] = useState<Net | null>(null);
  const [git, setGit] = useState<{ hunks: Hunk[] } | { error: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cur, setCur] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);

  // this turn's edits to the file, as they land
  const turns = useMemo(() => changeTurns(sessionEvents(sessionId), cwd), [sessionId, cwd, version]);
  const turn = turns.find((t) => t.from === d.from) ?? null;
  const group: FileGroup | null = turn?.files.find((f) => samePath(f.path, d.path)) ?? null;
  const edits = group?.edits ?? [];
  const lastEdit = edits.at(-1)?.id;

  // the turn's net change (snapshot → now/next prompt), refetched as edits land
  useEffect(() => {
    if (d.mode !== 'turn') return;
    let dead = false;
    const t = setTimeout(async () => {
      const q = new URLSearchParams({ path: d.path, from: String(d.from ?? 0), ...(d.to != null ? { to: String(d.to) } : {}) });
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/changes/net?${q}`).catch(() => null);
      if (!dead) setNet(r?.ok ? await r.json() : null);
    }, lastEdit ? 250 : 0);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [sessionId, d.mode, d.path, d.from, d.to, lastEdit]);
  useEffect(() => {
    if (d.mode !== 'git') return;
    let dead = false;
    setGit(null);
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/changes/git-diff?path=${encodeURIComponent(d.path)}`)
      .then((r) => r.json())
      .then((j) => !dead && setGit(j.error ? { error: j.error } : { hunks: (parsePatch(j.patch)[0]?.hunks ?? []) as Hunk[] }));
    return () => void (dead = true);
  }, [sessionId, d.mode, d.path]);
  useEffect(() => {
    seen.current = null;
    setCur(0);
    setNote(null);
  }, [d.path, d.from, d.mode]);

  // follow the agent: jump to whatever file it changes next
  useEffect(() => {
    if (!d.follow) return;
    const latest = turns.at(-1)?.files.reduce<FileGroup | null>((m, f) => (!m || f.lastTs > m.lastTs ? f : m), null);
    const t = turns.at(-1);
    if (latest && t && (!samePath(latest.path, d.path) || t.from !== d.from)) useBrain.getState().setDiff({ ...d, path: latest.path, from: t.from, to: t.to, step: -1, mode: 'turn' });
  }, [turns, d]);

  const step = d.step ?? -1;
  const e = step >= 0 ? edits[step] : null;
  let hunks: Hunk[] | null = null;
  let sub = '';
  if (d.mode === 'git') {
    hunks = git && 'hunks' in git ? git.hunks : null;
    sub = git && 'error' in git ? git.error : 'Uncommitted, against the last commit (git)';
  } else if (e) {
    hunks = e.hunks;
    sub = `edit ${step + 1} of ${edits.length} · ${e.agentId === 'main' ? 'main' : 'subagent'} · ${e.tool} · ${clock(e.ts)}`;
  } else if (net?.exact && net.hunks) {
    hunks = net.hunks;
    sub = edits.length ? `whole turn: ${edits.length} edit${edits.length === 1 ? '' : 's'}${d.to == null ? ', up to now' : ''}, plus anything else that changed the file` : 'whole turn';
  } else if (group?.isNew && edits.length === 1) {
    hunks = edits[0].hunks;
    sub = `new file · ${edits[0].agentId === 'main' ? 'main' : 'subagent'} · ${clock(edits[0].ts)}`;
  } else if (edits.length) {
    hunks = edits.flatMap((x) => x.hunks ?? []);
    sub = net?.tooBig ? 'too big to show as one diff: showing each edit in turn' : 'each edit in turn (no snapshot of the file from before)';
  }
  const stats = hunks ? hunkStats(hunks) : { add: group?.add ?? 0, del: group?.del ?? 0 };
  const lang = langOf(d.path);
  const rel = relPath(d.path, cwd);
  const href = (line: number) => `vscode://file/${d.path.replace(/\\/g, '/')}:${line}`;

  // hunks that weren't there before this render slide in
  const fresh = useMemo(() => {
    const now = new Set((hunks ?? []).map(sig));
    const prev = seen.current;
    seen.current = now;
    return prev ? new Set([...now].filter((s) => !prev.has(s))) : new Set<string>();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hunks]);

  const say = (t: string) => {
    setNote(t);
    setTimeout(() => setNote(null), 3000);
  };
  const ask = async (a: number, b: number) => {
    const ref = `@${rel}:${a}${b > a ? `-${b}` : ''} `;
    if (terminal) {
      const r = await fetch(`/api/terminals/${encodeURIComponent(terminal.terminalId)}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: ref, submit: false }) });
      say(r.ok ? `Added ${ref.trim()} to your prompt in the terminal` : "Couldn't type into the terminal");
    } else {
      if (desktop?.writeClipboard) desktop.writeClipboard(ref);
      else void navigator.clipboard?.writeText(ref).catch(() => {});
      say(`Copied ${ref.trim()} (this session isn't running here)`);
    }
  };
  const copy = () => {
    if (!hunks) return;
    const text = formatPatch({ oldFileName: `a/${rel}`, newFileName: `b/${rel}`, oldHeader: '', newHeader: '', hunks } as any);
    if (desktop?.writeClipboard) desktop.writeClipboard(text);
    else void navigator.clipboard?.writeText(text).catch(() => {});
    say('Copied the patch');
  };
  const set = (p: Partial<DiffTarget>) => useBrain.getState().setDiff({ ...d, ...p });
  const close = () => useBrain.getState().setDiff(null);

  // review keys (when wide): j/k file, n/p hunk, s split, Esc close
  const files = d.mode === 'turn' ? (turn?.files ?? []) : [];
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, [contenteditable], .xterm')) return;
      if (ev.key === 'Escape') return close();
      if (!wide) return;
      const i = files.findIndex((f) => samePath(f.path, d.path));
      if ((ev.key === 'j' || ev.key === 'k') && files.length) {
        const f = files[Math.max(0, Math.min(files.length - 1, i + (ev.key === 'j' ? 1 : -1)))];
        if (f) set({ path: f.path, step: -1, follow: false });
      } else if (ev.key === 'n' || ev.key === 'p') {
        const hs = body.current?.querySelectorAll('.dh') ?? [];
        const k = Math.max(0, Math.min(hs.length - 1, cur + (ev.key === 'n' ? 1 : -1)));
        setCur(k);
        hs[k]?.scrollIntoView({ block: 'start' });
      } else if (ev.key === 's') setSplit(!split);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const steps = edits.length > 1 ? edits : [];
  return (
    <div className={`diffview${wide ? ' wide' : ''}`}>
      {wide && d.mode === 'turn' ? (
        <div className="dv-files">
          <div className="dv-files-h">
            <span>{turn?.prompt ? 'Its task' : 'This turn'}</span>
            {turn?.prompt ? turn.prompt.slice(0, 160) : null}
          </div>
          <div className="dv-files-gl">
            Files <span>{files.length}</span>
          </div>
          {files.map((f) => (
            <button key={f.path} className={`dfile${samePath(f.path, d.path) ? ' sel' : ''}`} onClick={() => set({ path: f.path, step: -1, follow: false })}>
              <span className="df-t">
                <span className="nm">{f.rel.split('/').pop()}</span>
                <span className="dir">{f.rel.split('/').slice(0, -1).join('/')}</span>
              </span>
              <Counts add={f.add} del={f.del} />
            </button>
          ))}
          <div className="dv-keys">
            <span><b>j k</b> file</span>
            <span><b>n p</b> hunk</span>
            <span><b>s</b> split</span>
            <span><b>Esc</b> close</span>
          </div>
        </div>
      ) : null}
      <div className="dv-main">
        <div className="dv-h">
          <span className="dv-path" title={d.path}>
            {rel.includes('/') ? <span className="dir">{rel.split('/').slice(0, -1).join('/')}/</span> : null}
            <b>{rel.split('/').pop()}</b>
          </span>
          {group?.isNew ? <span className="dsrc new">new</span> : null}
          {d.mode === 'git' ? <span className="dsrc git">git</span> : null}
          <Counts add={stats.add} del={stats.del} />
          <span className="sp" />
          {d.mode === 'turn' ? (
            <button className={`btn ghost${d.follow ? ' on' : ''}`} onClick={() => set({ follow: !d.follow })} title="Jump to whatever file Claude changes next">
              <Icon name="Radar" size={12} /> Follow
            </button>
          ) : null}
          <div className="seg">
            <button className={`seg-b${split ? '' : ' on'}`} onClick={() => setSplit(false)}>Unified</button>
            <button className={`seg-b${split ? ' on' : ''}`} onClick={() => setSplit(true)}>Split</button>
          </div>
          <span className="dv-vr" />
          <a className="btn ghost" href={href(hunks?.[0]?.newStart ?? 1)} title="Open in VS Code">
            <Icon name="ExternalLink" size={13} /> Open
          </a>
          <button className="btn ghost" onClick={copy} disabled={!hunks?.length}>
            <Icon name="Copy" size={13} /> Copy patch
          </button>
          <button className="icon-btn" title={wide ? 'Back to the side-by-side layout' : 'Review: the whole turn, file by file'} onClick={() => useBrain.getState().setDiffWide(!wide)}>
            <Icon name={wide ? 'Minimize2' : 'Maximize2'} size={13} />
          </button>
          <button className="icon-btn" title="Close (Esc)" onClick={close}><Icon name="X" size={14} /></button>
        </div>
        <div className="dv-sub">
          {steps.length ? (
            <div className="seg">
              <button className={`seg-b${step < 0 ? ' on' : ''}`} onClick={() => set({ step: -1 })}>Net</button>
              {steps.slice(0, 20).map((x, i) => (
                <button key={x.id} className={`seg-b${step === i ? ' on' : ''}`} onClick={() => set({ step: i })} title={`${x.tool} · ${clock(x.ts)}`}>{i + 1}</button>
              ))}
            </div>
          ) : null}
          <span>{sub}</span>
          {note ? <span className="dv-note">{note}</span> : null}
        </div>
        <div className="dv-body" ref={body}>
          {hunks == null ? (
            <div className="dv-empty">{d.mode === 'git' && !git ? 'Loading…' : e && !e.hunks ? 'This edit is too big to show here. Open the file instead.' : net === null && d.mode === 'turn' && !edits.length ? 'Loading…' : 'No changes to show.'}</div>
          ) : !hunks.length ? (
            <div className="dv-empty">No changes{d.mode === 'turn' && d.to == null ? ' (the file is back where it started)' : ''}.</div>
          ) : (
            hunks.map((h, i) => <HunkView key={`${sig(h)}:${i}`} h={h} lang={lang} split={split} fresh={fresh.has(sig(h))} cur={wide && i === cur} onAsk={(a, b) => void ask(a, b)} href={href} />)
          )}
        </div>
      </div>
    </div>
  );
}

/** Open the changes of the file a droplet stands for (a read-only file has none: search the transcript instead). */
export function openDroplet(sessionId: string, path: string | undefined, name: string, changed: boolean | undefined) {
  if (path && changed) return openChanges(sessionId, path);
  useBrain.getState().setRightTab('transcript');
  window.dispatchEvent(new CustomEvent('cora:search', { detail: name }));
}

/** A compact, read-only diff (no line numbers): what an Edit/Write wants to do, on its permission card. */
export function MiniDiff({ hunks, path }: { hunks: Hunk[]; path: string }) {
  const lang = langOf(path);
  return (
    <div className="minidiff">
      {hunks.map((h, hi) => (
        <table key={hi} className="dt u">
          <tbody>
            {rows(h).flatMap((r, i) => {
              if (r.t === 'c') return [<tr key={i}><td className="m"> </td><td {...html(highlight(r.s, lang))} /></tr>];
              const w = r.d != null && r.a != null ? words(r.d, r.a, lang) : null;
              const out = [];
              if (r.d != null) out.push(<tr key={`${i}d`} className="d"><td className="m">−</td><td {...html(w ? w.old : highlight(r.d, lang))} /></tr>);
              if (r.a != null) out.push(<tr key={`${i}a`} className="a"><td className="m">+</td><td {...html(w ? w.new : highlight(r.a, lang))} /></tr>);
              return out;
            })}
          </tbody>
        </table>
      ))}
    </div>
  );
}
