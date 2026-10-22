import { useEffect, useMemo, useRef, useState } from 'react';
import { displayPath, type AgentInfo, type BrainEvent } from '@cora/shared';
import { sessionEvents, useBrain } from '../state/store';
import { derive, fileOf, type AgentView } from '../scene/derive';
import { latestByTitle } from '../lib/explainVersions';
import { openChanges } from '../lib/changes';
import { maskSecrets } from '../lib/mask';
import { explainFrom } from './Viewer';
import { Icon } from './Icon';
import './liveBoard.css';

/** How far back "Touching" looks, and how many of each it lists. */
const TOUCH_MS = 10 * 60_000;
const TOUCH_SHOWN = 6;
/** The calls bar: this many buckets over the last two minutes. */
const SPARK = 10;
const SPARK_MS = 120_000;

type Touch = { key: string; label: string; agents: string[]; ts: number; note: string; path?: string; changed?: boolean; live?: boolean; failed?: boolean };

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`);
const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(ms < 60_000 ? 1 : 0)}s`;

/**
 * The scene area with 3D off (Settings › Scene): what the scene shows, flat. One row per agent (helpers under the agent
 * that started them) with what it's doing now, its last line and a bar of its calls; what they're touching (files, the
 * web, the shell); and the session's explains. Built from the same derived view as the 3D scene.
 */
export function LiveBoard({ sessionId }: { sessionId: string }) {
  const version = useBrain((s) => s.versions[sessionId]);
  const allAgents = useBrain((s) => s.agents);
  const model = useBrain((s) => s.sessions[sessionId]?.model);
  const cwd = useBrain((s) => s.sessions[sessionId]?.cwd);
  const slots = useRef(new Map<string, number>());
  // the timers tick
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => void slots.current.clear(), [sessionId]);

  const agents = useMemo(() => {
    const list = Object.values(allAgents).filter((a) => a.sessionId === sessionId);
    if (!list.some((a) => a.agentId === 'main')) list.push({ sessionId, agentId: 'main', parentAgentId: null, parentToolUseId: null, label: 'main', agentType: 'main', colorIdx: -1, startedAt: 0, endedAt: null, state: 'idle' } satisfies AgentInfo);
    return list;
  }, [allAgents, sessionId]);
  const events = sessionEvents(sessionId);
  const d = useMemo(() => {
    const r = derive(events, agents, slots.current, now, model);
    slots.current = r.slots;
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, agents, model, Math.floor(now / 5000)]);

  // per agent: its call in flight (since when), its calls over the last two minutes, the files it touched, its report,
  // and whether it runs in the background (its Agent call returned at once)
  const per = useMemo(() => {
    const open = new Map<string, Map<string, BrainEvent>>();
    const spark = new Map<string, number[]>();
    const files = new Map<string, Set<string>>();
    const report = new Map<string, string>();
    const spawnEnd = new Map<string, number>();
    for (const e of events) {
      if (e.kind === 'report' && e.text) report.set(e.agentId, e.text);
      if (e.kind !== 'tool' || !e.toolUseId) continue;
      if ((e.tool?.name === 'Agent' || e.tool?.name === 'Task') && e.phase === 'end') spawnEnd.set(e.toolUseId, e.ts);
      const m = open.get(e.agentId) ?? new Map<string, BrainEvent>();
      open.set(e.agentId, m);
      if (e.phase === 'start') {
        m.set(e.toolUseId, e);
        const ago = now - e.ts;
        if (ago < SPARK_MS) {
          const b = spark.get(e.agentId) ?? new Array(SPARK).fill(0);
          b[Math.min(SPARK - 1, Math.max(0, SPARK - 1 - Math.floor((ago / SPARK_MS) * SPARK)))]++;
          spark.set(e.agentId, b);
        }
        const f = fileOf(e);
        if (f) (files.get(e.agentId) ?? files.set(e.agentId, new Set()).get(e.agentId)!).add(f.path);
      } else m.delete(e.toolUseId);
    }
    return { open, spark, files, report, spawnEnd };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, Math.floor(now / 5000)]);

  // helpers under the agent that started them
  const rows = useMemo(() => {
    const kids = new Map<string, AgentView[]>();
    for (const a of d.agents) if (!a.isMain) (kids.get(a.parentId) ?? kids.set(a.parentId, []).get(a.parentId)!).push(a);
    const out: Array<{ a: AgentView; depth: number }> = [];
    const walk = (a: AgentView, depth: number) => {
      out.push({ a, depth });
      for (const k of kids.get(a.a.agentId) ?? []) walk(k, depth + 1);
    };
    const main = d.agents.find((a) => a.isMain);
    if (main) walk(main, 0);
    // any whose parent isn't on show
    for (const a of d.agents) if (!out.some((r) => r.a === a)) out.push({ a, depth: 1 });
    return out;
  }, [d]);

  const touching = useMemo(() => touchedBy(events, now, cwd), [version, cwd, Math.floor(now / 5000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const explains = useMemo(() => latestByTitle(d.explains.flatMap((x) => {
    const p = explainFrom(x.event);
    return p ? [{ ...p, ts: x.ts }] : [];
  })).reverse(), [d.explains]);
  const waiting = d.agents.filter((a) => a.thinking && !a.diedAt).length;
  const color = Object.fromEntries(d.agents.map((a) => [a.a.agentId, a.color]));

  return (
    <div className="live-board">
      <div className="lb-grid">
        <section className="lb-card">
          <div className="lb-h">
            Agents <span className="n">{d.agents.filter((a) => !a.diedAt && a.a.state !== 'done').length} live</span>
            <span className="sp" />
            {waiting ? (
              <span className="lb-model">
                <i /> {waiting} waiting on the model
              </span>
            ) : null}
          </div>
          {rows.map(({ a, depth }) => (
            <AgentRow key={a.a.agentId} a={a} depth={depth} now={now} open={per.open.get(a.a.agentId)} spark={per.spark.get(a.a.agentId)} files={per.files.get(a.a.agentId)?.size ?? 0} report={per.report.get(a.a.agentId)} background={!!a.a.parentToolUseId && per.spawnEnd.has(a.a.parentToolUseId) && a.a.state !== 'done' && (per.spawnEnd.get(a.a.parentToolUseId) ?? 0) < a.lastActivity - 2000} />
          ))}
          {d.overflow ? <div className="lb-more">+{d.overflow} more agents</div> : null}
        </section>
        <div className="lb-side">
          <section className="lb-card">
            <div className="lb-h">
              Touching<span className="sp" />
              <span className="lb-model">last 10 min</span>
            </div>
            {(['Files', 'Web', 'Shell', 'Tools'] as const).map((g) =>
              touching[g].length ? (
                <div key={g} className="lb-grp">
                  <div className="lb-gh">{g}</div>
                  {touching[g].slice(0, TOUCH_SHOWN).map((t) => (
                    <div key={t.key} className={`lb-row${now - t.ts < 4000 ? ' hit' : ''}`} title={t.path ?? t.label}>
                      <span className="who">
                        {t.agents.slice(0, 4).map((id) => (
                          <i key={id} style={{ background: color[id] ?? 'var(--ink4)' }} />
                        ))}
                      </span>
                      <span className="p">{t.label}</span>
                      <span className={`m${t.failed ? ' bad' : t.live ? ' run' : ''}`}>
                        {t.note}
                        {t.changed && t.path ? (
                          <button className="lb-diff" onClick={() => openChanges(sessionId, t.path!)}>
                            diff
                          </button>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null,
            )}
            {!touching.Files.length && !touching.Web.length && !touching.Shell.length && !touching.Tools.length ? <div className="lb-empty">Nothing in the last 10 minutes.</div> : null}
          </section>
          {explains.length ? (
            <section className="lb-card">
              <div className="lb-h">
                Explains <span className="n">{explains.length}</span>
              </div>
              {explains.slice(0, 6).map((x) => (
                <button key={x.toolUseId} className="lb-ex" onClick={() => useBrain.getState().setViewer(x)}>
                  <span className={`ti ${x.format}`}>
                    <Icon name={x.format === 'html' ? 'Monitor' : 'FileText'} size={11} />
                  </span>
                  <span className="t">{x.title}</span>
                  {x.live ? <span className="live" title="live" /> : null}
                  <span className="ago">{ago(now - x.ts)}</span>
                </button>
              ))}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** One agent: who, how it is, what it's doing now (and for how long), its last line or report, its calls. */
function AgentRow({ a, depth, now, open, spark, files, report, background }: { a: AgentView; depth: number; now: number; open?: Map<string, BrainEvent>; spark?: number[]; files: number; report?: string; background: boolean }) {
  const done = a.a.state === 'done' || !!a.diedAt;
  const call = open?.size ? [...open.values()].sort((x, y) => y.ts - x.ts)[0] : undefined;
  const state = done ? 'done' : call ? 'working' : a.thinking ? 'thinking' : a.a.state === 'idle' ? 'idle' : 'working';
  const bars = spark ?? new Array(SPARK).fill(0);
  const max = Math.max(1, ...bars);
  return (
    <div className={`lb-ag ${state}`} style={{ ['--ac' as string]: a.color, paddingLeft: 12 + depth * 22 }}>
      <span className="d" />
      <div className="mid">
        <div className="top">
          <b>{a.name}</b>
          {!a.isMain && a.a.agentType ? <span className={`chip${background ? ' bg' : ''}`}>{background ? 'background' : a.a.agentType}</span> : null}
          <span className={`st ${state}`}>{state === 'done' ? '✓ done' : state}</span>
        </div>
        {state === 'working' && call ? (
          <div className="now">
            <span className="spin" />
            <span className="t">{maskSecrets(`${call.tool?.name ?? ''} ${call.tool?.summary ?? ''}`).text}</span>
            <span className="el">{secs(now - call.ts)}</span>
          </div>
        ) : state === 'thinking' ? (
          <div className="now">
            <span className="t think">waiting on the model</span>
            <span className="el">{secs(now - a.lastActivity)}</span>
          </div>
        ) : state !== 'done' && a.status.text ? (
          <div className="now">
            <span className="t">{maskSecrets(a.status.text).text}</span>
          </div>
        ) : null}
        {done && report ? (
          <div className="rep">
            <b>Report</b> · {report}
          </div>
        ) : a.bubble?.text ? (
          <div className="said">{a.bubble.text}</div>
        ) : null}
      </div>
      <div className="side">
        <div className="spark">
          {bars.map((c, i) => (
            <i key={i} style={{ height: 3 + (19 * c) / max, opacity: c ? 1 : 0.25 }} />
          ))}
        </div>
        <div className="counts">
          {a.tools} call{a.tools === 1 ? '' : 's'}
          {files ? ` · ${files} file${files === 1 ? '' : 's'}` : ''}
        </div>
      </div>
    </div>
  );
}

/** What the session's agents touched lately, newest first: files, the web, the shell, other tools. */
export function touchedBy(events: BrainEvent[], now: number, cwd?: string): Record<'Files' | 'Web' | 'Shell' | 'Tools', Touch[]> {
  const out = { Files: new Map<string, Touch>(), Web: new Map<string, Touch>(), Shell: new Map<string, Touch>(), Tools: new Map<string, Touch>() };
  const ended = new Map<string, BrainEvent>();
  for (const e of events) if (e.kind === 'tool' && e.phase === 'end' && e.toolUseId) ended.set(e.toolUseId, e);
  for (const e of events) {
    if (e.kind !== 'tool' || e.phase !== 'start' || !e.tool || now - e.ts > TOUCH_MS) continue;
    const end = e.toolUseId ? ended.get(e.toolUseId) : undefined;
    const r = e.tool.resource ?? '';
    const f = fileOf(e);
    const put = (g: keyof typeof out, key: string, t: Omit<Touch, 'key' | 'agents' | 'ts'>) => {
      const had = out[g].get(key);
      const agents = had ? (had.agents.includes(e.agentId) ? had.agents : [...had.agents, e.agentId]) : [e.agentId];
      out[g].set(key, { ...had, ...t, key, agents, ts: e.ts, changed: had?.changed || t.changed });
    };
    if (f) {
      const ch = end?.tool?.change;
      const changed = f.op === 'edit' || f.op === 'write';
      put('Files', f.path, { label: displayPath(f.path, cwd), path: f.path, changed, note: ch ? `+${ch.add} −${ch.del}` : f.op === 'read' ? 'read' : f.op === 'write' ? 'written' : 'edited' });
    } else if (r === 'shell') {
      // each command once, as it last ran
      put('Shell', e.tool.summary, { label: e.tool.summary, note: !end ? 'running' : end.tool?.failed ? 'failed' : end.durationMs != null ? secs(end.durationMs) : 'done', live: !end, failed: !!end?.tool?.failed });
    } else if (r.startsWith('web') || r === 'browser') {
      // a browser tool (Playwright): what it did, not its input as JSON
      const label = r === 'browser' ? `${e.tool.name.replace(/^mcp__([^_]+)__/, '$1 · ')}${/^[[{]/.test(e.tool.summary.trim()) ? '' : ` ${e.tool.summary}`}` : e.tool.summary;
      put('Web', label, { label, note: end?.tool?.resultSummary ?? (end ? 'done' : 'loading'), live: !end });
    } else if (r.startsWith('mcp:')) {
      put('Tools', `${e.tool.name} ${e.tool.summary}`, { label: `${e.tool.name.replace(/^mcp__([^_]+)__/, '$1 · ')} ${e.tool.summary}`.trim(), note: end ? 'done' : 'running', live: !end });
    }
  }
  const newest = (m: Map<string, Touch>) => [...m.values()].sort((a, b) => b.ts - a.ts);
  return { Files: newest(out.Files), Web: newest(out.Web), Shell: newest(out.Shell), Tools: newest(out.Tools) };
}
