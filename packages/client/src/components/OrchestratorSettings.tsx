import { useEffect, useState } from 'react';
import { CORA_COLORS, DEFAULT_CORA_COLOR, HARD_LIMITS, INSTRUCTIONS_MAX, type Settings, type WorkServer } from '@cora/shared';
import { useBrain } from '../state/store';
import { forgetCora, newCora, restartCora, useOrch } from '../state/orchestrator';
import { Choice, Group, Row, Section, Toggle } from './settingsUi';
import { hashColor } from '../lib/format';
import { Icon } from './Icon';
import './cora.css';

const MODELS: Array<[string, string]> = [
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
];

/**
 * Settings → Cora Orchestrator: the whole feature on or off (off: no eye, no tools, no agent), its model, whether it
 * speaks, and its memory.
 */
export function OrchestratorSection({ server, save }: { server: Settings | null; save(p: object): Promise<void> }) {
  const status = useOrch((s) => s.status);
  const color = useBrain((s) => s.prefs.coraColor) ?? DEFAULT_CORA_COLOR;
  const o = server?.orchestrator;
  const [memory, setMemory] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [custom, setCustom] = useState('');
  // your instructions: edited here, applied (saved, and Cora started again) when you say
  const [instr, setInstr] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [other, setOther] = useState(false);
  useEffect(() => {
    if (!o?.enabled) return;
    void fetch('/api/orchestrator/memory')
      .then((r) => r.json())
      .then((j) => setMemory(typeof j.text === 'string' ? j.text : ''))
      .catch(() => {});
  }, [o?.enabled]);
  if (!o) return null;
  const saveMemory = async () => {
    await fetch('/api/orchestrator/memory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: memory ?? '' }) });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  const known = MODELS.some(([m]) => m === o.model);
  const instrNow = instr ?? o.instructions ?? '';
  const instrChanged = instr != null && instr.trim() !== (o.instructions ?? '');
  const applyInstr = async () => {
    // saving them starts Cora again with them
    await save({ orchestrator: { instructions: instrNow } });
    setInstr(null);
    setApplied(true);
    setTimeout(() => setApplied(false), 2000);
  };

  return (
    <Section id="orchestrator" title="Cora Orchestrator" intro="Your assistant: it sees every session, pipeline and ticket, starts and directs sessions, and asks you before it acts. Talk to it from the bridge at the top of the nav, or hold Ctrl+Space.">
      <Toggle label="Turn on Cora" hint={o.enabled ? 'A Claude Code session of its own, on your Claude login.' : 'Off: no bridge, no tools, nothing running.'} checked={o.enabled} onChange={(v) => void save({ orchestrator: { enabled: v } })} />
      <Row label="Colour" hint="Cora's eye, its cards and console, and the app's icon.">
        <span className="cora-swatches">
          {CORA_COLORS.map(([c, name]) => (
            <button key={c} className={`swatch${color === c ? ' on' : ''}`} style={{ ['--sc' as string]: c } as React.CSSProperties} title={name} aria-label={name} aria-pressed={color === c} onClick={() => useBrain.getState().setPrefs({ coraColor: c })} />
          ))}
        </span>
      </Row>
      {o.enabled ? (
        <>
          <Row label="Status" hint="Kept out of your session list.">
            <span className={`orch-status${status?.error ? ' bad' : ''}`}>
              <span className={`dl-glyph ${status?.error ? 'bad' : status?.running ? 'ok' : 'run'}`} />
              {status?.error ? status.error : status?.running ? 'Running' : 'Starting…'}
            </span>
            <button className="btn" onClick={() => void restartCora()} title="Start Cora's session again (it keeps its conversation)">
              <Icon name="RotateCw" size={12} /> Start again
            </button>
            <button
              className="btn"
              onClick={() => window.confirm('Start a new conversation with Cora? It keeps what it remembers, your instructions, its goals and the Slack threads it watches.') && void newCora()}
              title="A fresh conversation, on the model above (when the current one can't go on). Its memory, your instructions, goals and Slack watches are kept."
            >
              <Icon name="MessageSquarePlus" size={12} /> New conversation
            </button>
          </Row>
          <Row label="Model" hint="The strongest works best. A change starts it again.">
            {other || !known ? (
              <input
                className="set-input code"
                placeholder={known ? 'a model name, e.g. claude-opus-5-5' : o.model}
                value={custom}
                spellCheck={false}
                autoFocus={other}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && custom.trim() && void save({ orchestrator: { model: custom.trim() } }).then(() => (setCustom(''), setOther(false)))}
              />
            ) : null}
            <Choice value={known && !other ? o.model : 'other'} onChange={(v) => (v === 'other' ? setOther(true) : (setOther(false), void save({ orchestrator: { model: v } })))} options={[...MODELS, ['other', 'Other…']]} />
          </Row>
          <Toggle label="Say replies aloud" hint="A short spoken line, with your voice settings." checked={o.speak} onChange={(v) => void save({ orchestrator: { speak: v } })} />
          <Row
            wide
            label="Your instructions"
            hint="In Cora's system prompt every time it starts: how it sounds and how it works for you. They never lift the hard limits or what needs your OK. Applying starts Cora again (it keeps its conversation)."
          >
            <textarea
              className="set-input orch-instr"
              rows={6}
              maxLength={INSTRUCTIONS_MAX}
              value={instrNow}
              spellCheck
              placeholder={'e.g. Be warm but brief, and a little dry. Call me David. Lead with what needs me. When you write to people on Slack, sign as Cora.'}
              onChange={(e) => setInstr(e.target.value)}
            />
            <span className="orch-instr-act">
              <span className="dim">
                {instrNow.length} / {INSTRUCTIONS_MAX}
              </span>
              {applied ? <span className="dim">Applied: Cora is starting again</span> : null}
              <button className="btn ghost" disabled={!instrChanged} onClick={() => setInstr(null)}>
                Undo changes
              </button>
              <button className="btn allow" disabled={!instrChanged} onClick={() => void applyInstr()}>
                Apply
              </button>
            </span>
          </Row>
          <Group label="Autopilot and away">
            <MandateRows o={o} save={save} />
          </Group>
          <Group label="Outside autopilot">
            <Row label="Cora hears" hint="What it's told about on its own. On autopilot it hears everything about its goal.">
              <Choice value={o.events} onChange={(v) => void save({ orchestrator: { events: v } })} options={[['important', 'The important things'], ['off', 'Nothing']]} />
            </Row>
            <Row label="Briefs" hint="Back after a few hours away, it catches you up. Brief me and Wrap up are in its console any time.">
              <Choice value={o.briefs ?? 'welcome'} onChange={(v) => void save({ orchestrator: { briefs: v } })} options={[['welcome', 'When I’m back'], ['off', 'Only when I ask']]} />
            </Row>
          </Group>
          <Group label="Memory">
            <Row wide label="What Cora keeps about you" hint="About you and your work; it adds to it as you go. Edit freely.">
              <textarea className="set-input orch-memory" value={memory ?? ''} rows={8} spellCheck onChange={(e) => setMemory(e.target.value)} />
              <span className="orch-mem-a">
                <button className="btn" disabled={memory == null} onClick={() => void saveMemory()}>
                  {saved ? 'Saved' : 'Save'}
                </button>
                <button
                  className="btn ghost bad"
                  onClick={() => {
                    if (window.confirm('Forget everything? Cora starts a fresh session and its memory is cleared.')) void forgetCora().then(() => setMemory(''));
                  }}
                >
                  Forget everything
                </button>
              </span>
            </Row>
          </Group>
          <Group label="Work tools">
            <WorkTools servers={o?.workServers ?? {}} save={(workServers) => save({ orchestrator: { workServers } })} />
          </Group>
          <Group label="Never">
            <Row wide label="Hard limits" hint="Refused whatever the mandate says, in every mode.">
              <ul className="orch-limits">
                {HARD_LIMITS.map((l) => (
                  <li key={l}>
                    <Icon name="Lock" size={11} /> {l}
                  </li>
                ))}
              </ul>
            </Row>
          </Group>
        </>
      ) : null}
    </Section>
  );
}

const BUDGETS: Array<[string, string]> = [
  ['1000000', '1M'],
  ['5000000', '5M'],
  ['20000000', '20M'],
  ['50000000', '50M'],
];

/** The mandate: where Cora may work on its own (autopilot and control), what else it may do, and what it never does. */
function MandateRows({ o, save }: { o: Settings['orchestrator']; save(p: object): Promise<void> }) {
  const sessions = useBrain((s) => s.sessions);
  const [path, setPath] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const repos = o.mandate.repos;
  const setRepos = async (next: string[]) => {
    setErr(null);
    try {
      await save({ orchestrator: { mandate: { repos: next } } });
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  // folders your sessions work in, not in the mandate yet
  const suggestions = [...new Set(Object.values(sessions).map((s) => s.cwd).filter(Boolean))].filter((c) => !repos.some((r) => norm(r) === norm(c))).slice(0, 8);
  const add = (p: string) => {
    const t = p.trim();
    if (t) void setRepos([...repos, t]);
    setPath('');
  };
  const known = BUDGETS.some(([b]) => Number(b) === o.budget);
  return (
    <>
      <Row wide label="Where Cora may work on its own" hint="Its sessions' prompts there are answered by the rules: reads, edits, tests, builds, commits, pushes to feature branches. Anywhere else, they come to you.">
        <div className="orch-repos">
          {repos.length ? (
            repos.map((r) => (
              <span key={r} className="orch-repo">
                <span className="dl-tile" style={{ ['--sc' as any]: hashColor(norm(r)) }}>
                  {(r.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()}
                </span>
                <span className="orch-path">{r}</span>
                <button className="icon-btn" title="Remove" onClick={() => void setRepos(repos.filter((x) => x !== r))}>
                  <Icon name="X" size={12} />
                </button>
              </span>
            ))
          ) : (
            <span className="orch-none">No folders yet: on autopilot, everything would come to you.</span>
          )}
        </div>
        <span className="orch-add">
          <input className="set-input code" value={path} placeholder="C:\code\my-repo" spellCheck={false} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add(path)} />
          <button className="btn" disabled={!path.trim()} onClick={() => add(path)}>
            Add
          </button>
        </span>
        {suggestions.length ? (
          <span className="orch-sugg">
            <span>Yours:</span>
            {suggestions.map((c) => (
              <button key={c} className="orch-chip" onClick={() => add(c)} title="Add to the mandate">
                {c}
              </button>
            ))}
          </span>
        ) : null}
        {err ? <span className="ny-err">{err}</span> : null}
      </Row>
      <Toggle label="Deploys too" hint="kubectl, helm, terraform, pipelines, images. Publishing packages always asks." checked={o.mandate.deploy} onChange={(v) => void save({ orchestrator: { mandate: { deploy: v } } })} />
      <Row label="Budget per goal" hint="Tokens its sessions may use (output plus uncached input) before it stops and tells you.">
        <Choice value={known ? String(o.budget) : 'x'} onChange={(v) => v !== 'x' && void save({ orchestrator: { budget: Number(v) } })} options={[...BUDGETS, ...(known ? [] : ([['x', `${Math.round(o.budget / 1000)}k`]] as Array<[string, string]>))]} />
      </Row>
    </>
  );
}

/**
 * Your own work MCP servers for Cora (beyond Jira and Confluence, GitLab, Elasticsearch and AWS docs, built in): the
 * server's name as Claude Code knows it, what it's for, and its read-only tools, which Cora may use without asking.
 */
function WorkTools({ servers, save }: { servers: Record<string, WorkServer>; save(s: Record<string, WorkServer>): Promise<void> }) {
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [tools, setTools] = useState('');
  const list = Object.entries(servers);
  const read = tools.split(/[\s,]+/).filter(Boolean);
  const ok = /^[\w.-]{1,64}$/.test(name.trim()) && read.length > 0 && read.every((t) => /^[\w.-]{1,100}$/.test(t));
  const add = async () => {
    await save({ ...servers, [name.trim()]: { about: about.trim() || name.trim(), read } });
    setName('');
    setAbout('');
    setTools('');
  };
  return (
    <>
      {list.map(([n, w]) => (
        <Row key={n} label={n} hint={`${w.about} · ${w.read.length} read-only tool${w.read.length === 1 ? '' : 's'}: ${w.read.slice(0, 6).join(', ')}${w.read.length > 6 ? '…' : ''}`}>
          <button
            className="btn ghost"
            onClick={() => {
              const next = { ...servers };
              delete next[n];
              void save(next);
            }}
          >
            Remove
          </button>
        </Row>
      ))}
      <Row
        wide
        label={list.length ? 'Add another' : 'Your own'}
        hint="An MCP server you've added to Claude Code that Cora should know: its name there, what it's for, and the tools that only read (comma or space between them). Cora uses those without asking; anything else it asks first. Jira and Confluence, GitLab, Elasticsearch and AWS docs are known already."
      >
        <span className="orch-wt">
          <input className="set-input code" placeholder="server name" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
          <input className="set-input" placeholder="what it's for" value={about} maxLength={200} onChange={(e) => setAbout(e.target.value)} />
          <textarea className="set-input code" placeholder="read-only tools, e.g. get_status, search_notes" rows={2} value={tools} spellCheck={false} onChange={(e) => setTools(e.target.value)} />
          <button className="btn" disabled={!ok} onClick={() => void add()}>
            Add
          </button>
        </span>
      </Row>
    </>
  );
}
