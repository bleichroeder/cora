import { GlRestart } from './GlGuard';
import { MemeRows } from './MemeSettings';
import { EnvironmentsSection, GitlabSection, fetchGitlabStatus, type GitlabStatus } from './EnvironmentsSettings';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SlackSection, ToolsSection } from './SlackSettings';
import { SecuritySection } from './SecuritySettings';
import { LockSection } from './LockSettings';
import { OrchestratorSection } from './OrchestratorSettings';
import type { InboxSource, Settings } from '@cora/shared';
import { BrandIcon } from './BrandIcon';
import { SetupList } from './Setup';
import { useSetup } from '../state/setup';
import { useBrain, type UiPrefs } from '../state/store';
import { desktop } from '../lib/desktop';
import { clearEnded } from './SessionMenu';
import { Icon } from './Icon';
import { loadShellKinds, useShells } from '../state/shells';
import { VoiceSection } from './VoiceSettings';
import { Boundary } from './Boundary';
import { Choice, Group, Row, Section, SettingsPage, Toggle } from './settingsUi';
import { spaceOf, type SpaceSettings } from '../scene/system/settings';
import { jumpToHyperspace } from '../scene/system/warp';
import { useVoice } from '../lib/voice';
import { useJira } from '../state/jira';
import { useSlack } from '../state/slack';
import './settings.css';
import { JiraSection } from './JiraSettings';
import { GmailSection } from './GmailSettings';
import { OnePasswordSection } from './OnePasswordSettings';
import { loadGmail, useGmail } from '../state/gmail';

/** The pages, in the nav's groups (Notifications and Jira only in the desktop app). */
export const SETTINGS_SECTIONS: Array<{ id: string; label: string; icon: string; group: string; desktop?: boolean; /** a service's own logo */ brand?: InboxSource }> = [
  { id: 'setup', label: 'Setup', icon: 'ListChecks', group: 'Cora' },
  { id: 'orchestrator', label: 'Cora Orchestrator', icon: 'Eye', group: 'Cora' },
  { id: 'voice', label: 'Voice', icon: 'Mic', group: 'Cora' },
  { id: 'sessions', label: 'Sessions', icon: 'Tag', group: 'Sessions' },
  { id: 'explains', label: 'Explains', icon: 'FileText', group: 'Sessions' },
  { id: 'terminal', label: 'Terminal', icon: 'SquareTerminal', group: 'Sessions' },
  { id: 'notifications', label: 'Notifications', icon: 'Bell', group: 'Sessions', desktop: true },
  { id: 'jira', label: 'Jira', icon: 'Ticket', group: 'Connected', desktop: true, brand: 'jira' },
  { id: 'gitlab', label: 'GitLab', icon: 'GitBranch', group: 'Connected', brand: 'gitlab' },
  { id: 'slack', label: 'Slack', icon: 'MessageSquare', group: 'Connected', brand: 'slack' },
  { id: 'gmail', label: 'Gmail', icon: 'Mail', group: 'Connected', brand: 'mail' },
  { id: 'onepassword', label: '1Password', icon: 'KeyRound', group: 'Connected', desktop: true },
  { id: 'tools', label: 'Tools', icon: 'Wrench', group: 'Connected' },
  { id: 'environments', label: 'Environments', icon: 'Network', group: 'This machine' },
  { id: 'scene', label: 'Scene', icon: 'Orbit', group: 'This machine' },
  { id: 'lock', label: 'Lockdown', icon: 'Lock', group: 'This machine' },
  { id: 'security', label: 'Updates & security', icon: 'ShieldCheck', group: 'This machine' },
  { id: 'data', label: 'Data', icon: 'Database', group: 'This machine' },
];
const NAV = SETTINGS_SECTIONS;

/** The page the next opening shows (the command palette and Cora's console open Settings at one). */
let openAt: string | null = null;
export function openSettings(section?: string) {
  // already open (a page's "Set it up"): it turns to that page
  if (useBrain.getState().modal === 'settings') {
    if (section) window.dispatchEvent(new CustomEvent('cora:settings-page', { detail: section }));
    return;
  }
  openAt = section ?? null;
  useBrain.getState().setModal('settings');
}

/** Find a setting: hides the rows that don't match (and the panels, groups and pages left empty), lights the words. */
function useFind(pane: React.RefObject<HTMLDivElement | null>, query: string, deps: unknown[]): number | null {
  const [hits, setHits] = useState<number | null>(null);
  useLayoutEffect(() => {
    const p = pane.current;
    if (!p) return;
    const reg = (window as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    const apply = () => {
      const q = query.trim().toLowerCase();
      const ranges: Range[] = [];
      let n = 0;
      for (const row of p.querySelectorAll<HTMLElement>('.set-row')) {
        const hit = !q || (row.textContent ?? '').toLowerCase().includes(q);
        row.toggleAttribute('data-miss', !hit);
        if (!q || !hit) continue;
        n++;
        // the words, lit where they're read (the name and description)
        const label = row.querySelector('.set-l');
        if (!label) continue;
        const walk = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
        for (let t = walk.nextNode(); t; t = walk.nextNode()) {
          const text = (t.textContent ?? '').toLowerCase();
          for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
            const r = new Range();
            r.setStart(t, i);
            r.setEnd(t, i + q.length);
            ranges.push(r);
          }
        }
      }
      for (const el of p.querySelectorAll<HTMLElement>('.set-panel, .set-grp, .set-sec')) el.toggleAttribute('data-miss', !!q && !el.querySelector('.set-row:not([data-miss])'));
      setHits(q ? n : null);
      const H = (window as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
      if (reg && H) {
        if (ranges.length) reg.set('set-find', new H(...ranges));
        else reg.delete('set-find');
      }
    };
    apply();
    if (!query.trim()) return;
    // rows that come and go while searching (a switch that shows more) are matched too
    let raf = 0;
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    });
    mo.observe(p, { childList: true, subtree: true, characterData: true });
    return () => (mo.disconnect(), cancelAnimationFrame(raf));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, ...deps]);
  useEffect(() => () => void (window as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights?.delete('set-find'), []);
  return hits;
}

export function SettingsModal() {
  const close = () => useBrain.getState().setModal(null);
  const prefs = useBrain((s) => s.prefs);
  const setPrefs = useBrain((s) => s.setPrefs);
  const voiceOn = useVoice((v) => v.settings.enabled);
  const jiraAuth = useJira((j) => j.auth);
  const slackOn = useSlack((s) => s.status.connected);
  const gmail = useGmail((g) => g.status);
  useEffect(() => void loadGmail(), []);
  const [server, setServer] = useState<Settings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const nav = NAV.filter((n) => !n.desktop || desktop);
  const [current, setCurrent] = useState(() => {
    const at = openAt;
    openAt = null;
    return at && nav.some((n) => n.id === at) ? at : 'orchestrator';
  });
  const [query, setQuery] = useState('');
  useEffect(() => {
    const go = (e: Event) => {
      const at = (e as CustomEvent<string>).detail;
      if (!nav.some((n) => n.id === at)) return;
      setQuery('');
      setCurrent(at);
    };
    window.addEventListener('cora:settings-page', go);
    return () => window.removeEventListener('cora:settings-page', go);
  });
  const pane = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  const hits = useFind(pane, query, [server, current]);
  const searching = !!query.trim();

  useEffect(() => {
    void fetch('/api/settings').then((r) => r.json()).then(setServer);
  }, []);
  // Esc clears the search first, then closes; Ctrl+F finds a setting
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (find.current?.value) (setQuery(''), find.current.blur());
        else close();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        find.current?.focus();
        find.current?.select();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const go = (id: string) => {
    setQuery('');
    setCurrent(id);
    pane.current?.scrollTo({ top: 0 });
  };
  // GitLab: glab signed in there (asked once as Settings opens)
  const [gitlabSt, setGitlabSt] = useState<GitlabStatus | null>(null);
  useEffect(() => void fetchGitlabStatus().then(setGitlabSt), []);
  // a quiet word on the pages where on or off matters
  const setupLeft = useSetup((s) => (s.state ? s.state.items.filter((i) => i.status === 'needs' || i.status === 'partial').length : null));
  const stateOf = (id: string): [string, boolean] | null => {
    if (id === 'setup' && setupLeft != null) return setupLeft ? [`${setupLeft} to do`, false] : ['all set', true];
    if (id === 'orchestrator' && server) return server.orchestrator.enabled ? ['on', true] : ['off', false];
    if (id === 'voice') return voiceOn ? ['on', true] : ['off', false];
    // the Connected pages say the same words
    if (id === 'jira') return jiraAuth === 'ok' ? ['connected', true] : jiraAuth === 'signed-out' ? ['not connected', false] : null;
    if (id === 'slack') return slackOn ? ['connected', true] : ['not connected', false];
    if (id === 'gitlab') return gitlabSt ? (gitlabSt.state === 'connected' ? ['connected', true] : ['not connected', false]) : null;
    if (id === 'gmail') return gmail ? (gmail.connected && !gmail.error ? ['connected', true] : ['not connected', false]) : null;
    return null;
  };

  // what went wrong, for a row that says so itself
  const trySave = async (patch: object): Promise<string | null> => {
    setErr(null);
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) setServer(j);
    else setErr(j.error ?? 'failed');
    return r.ok ? null : ((j.error as string | undefined) ?? 'failed');
  };
  const save = async (patch: object) => {
    await trySave(patch);
  };
  const ui = (p: Partial<UiPrefs>) => setPrefs(p);
  // how space looks (Settings > Scene)
  const space = spaceOf(prefs.space);
  const setSpace = (p: Partial<SpaceSettings>) => ui({ space: { ...space, ...p } });

  return (
    <div className="modal-bg" onMouseDown={close}>
      <div className="modal settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="set-top">
          <span className="set-title">
            <Icon name="Settings" size={15} /> Settings
          </span>
          <label className={`set-find${searching ? ' on' : ''}`}>
            <Icon name="Search" size={14} />
            <input ref={find} value={query} placeholder="Find a setting" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
            <kbd>{searching ? 'Esc' : 'Ctrl F'}</kbd>
          </label>
          <button className="icon-btn set-x" onClick={close} title="Close (Esc)">
            <Icon name="X" size={15} />
          </button>
        </div>

        <div className="set-body">
          <nav className="set-nav">
            {[...new Set(nav.map((n) => n.group))].map((g) => (
              <div key={g} className="set-ng">
                <div className="set-gl">{g}</div>
                {nav
                  .filter((n) => n.group === g)
                  .map((n) => {
                    const st = stateOf(n.id);
                    return (
                      <button key={n.id} className={!searching && current === n.id ? 'on' : ''} onClick={() => go(n.id)}>
                        {n.brand ? <BrandIcon source={n.brand} size={15} /> : <Icon name={n.icon} size={15} />} {n.label}
                        {st ? (
                          <span className={`set-ns${st[1] ? '' : ' off'}`}>
                            <i />
                            {st[0]}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
              </div>
            ))}
          </nav>

          <div className={`set-pane${searching ? ' searching' : ''}`} ref={pane}>
            {searching ? (
              <div className="set-sec-h set-found">
                <h2>{hits === 1 ? '1 setting' : `${hits ?? 0} settings`}</h2>
                <p className="set-intro">{hits ? <>Matching &ldquo;{query.trim()}&rdquo; on every page.</> : <>Nothing matches &ldquo;{query.trim()}&rdquo;.</>}</p>
              </div>
            ) : null}
            <SettingsPage.Provider value={{ current, searching }}>
              <Section id="setup" bare title="Setup" intro="What each of Cora's features needs, and what's left to do. The same list as the first run.">
                <SetupList />
              </Section>

              <Boundary name="Cora Orchestrator settings">
                <OrchestratorSection server={server} save={(p) => save(p)} />
              </Boundary>

              <Boundary name="voice settings">
                <VoiceSection />
              </Boundary>

              <Section id="sessions" title="Sessions" intro="How sessions are named, and what stays on the list.">
                <ClaudeCodeRow />
                {server ? (
                  <Toggle
                    label="Name new sessions"
                    hint={<>A quick Haiku call names each from its first prompt (a small cost). A name you give always wins; right-click a session for &ldquo;Suggest a name&rdquo;.</>}
                    checked={server.autoName}
                    onChange={(autoName) => void save({ autoName })}
                  />
                ) : null}
                {server ? (
                  <Row
                    label="Board"
                    hint={
                      (server.board?.pages ?? 'show') === 'off'
                        ? "Sessions leave the Board to you."
                        : (server.board?.pages ?? 'show') === 'add'
                          ? 'As the work moves on (investigating, coding, reviewing, shipping), a session adds a page laid out for it; you go to it when you like. Never changes your own pages. For sessions started from now on.'
                          : 'As the work moves on (investigating, coding, reviewing, shipping), a session adds a page laid out for it and shows it (Undo takes it away). Never changes your own pages. For sessions started from now on.'
                    }
                  >
                    <Choice value={server.board?.pages ?? 'show'} onChange={(m) => void save({ board: { pages: m } })} options={[['off', 'Off'], ['add', 'Add pages'], ['show', 'Add and show']]} />
                  </Row>
                ) : null}
                {server ? <MemeRows server={server} save={trySave} /> : null}
                <Row label="Ended sessions" hint="Take them off the list. Their transcripts stay.">
                  <button className="btn" onClick={async () => { await clearEnded(); setCleared(true); }}>
                    <Icon name="EyeOff" size={12} /> {cleared ? 'Cleared' : 'Clear ended'}
                  </button>
                </Row>
              </Section>

              <Section id="explains" title="Explains" intro="Documents Claude writes into its reply and Cora shows in the viewer, instead of terminal text. For sessions started or resumed from Cora afterwards.">
                {server ? (
                  <>
                    <Row label="Explains" hint="Markdown costs about 1.5× the tokens of a terminal answer; HTML 4× or more.">
                      <Choice value={server.explains.mode} onChange={(mode) => void save({ explains: { mode } })} options={[['off', 'Off'], ['markdown', 'Markdown'], ['markdown+html', 'Markdown + HTML']]} />
                    </Row>
                    <Row label="How often" hint="How readily Claude reaches for one.">
                      <Choice value={server.explains.frequency} onChange={(frequency) => void save({ explains: { frequency } })} options={[['sparingly', 'Sparingly'], ['normal', 'Normal'], ['liberally', 'Liberally']]} />
                    </Row>
                    <Row label="In the terminal" hint="What Claude's reply says where the explain went.">
                      <Choice value={server.explains.reply} onChange={(reply) => void save({ explains: { reply } })} options={[['pointer', 'One-line pointer'], ['summary', 'Short summary']]} />
                    </Row>
                  </>
                ) : (
                  <div className="set-loading">loading…</div>
                )}
              </Section>

              <Section id="terminal" title="Terminal" intro="How you write to sessions hosted here, and how their replies show.">
                <Row label="Write prompts" hint="The composer takes several lines, files and screenshots, / commands and ↑ for earlier prompts. Claude's terminal shows itself when Claude Code asks you something.">
                  <Choice value={prefs.inputMode} onChange={(v) => ui({ inputMode: v })} options={[['composer', 'In the composer'], ['terminal', 'In the terminal']]} />
                </Row>
                {prefs.inputMode === 'composer' ? (
                  <Row label="Sending" hint="In the composer.">
                    <Choice value={prefs.composerEnter} onChange={(v) => ui({ composerEnter: v })} options={[['enter', 'Enter sends'], ['ctrl-enter', 'Ctrl+Enter sends']]} />
                  </Row>
                ) : (
                  <Toggle label="Only Claude's input area" hint="It grows for menus, permission prompts and questions." checked={prefs.compactTerminal} onChange={(v) => ui({ compactTerminal: v })} />
                )}
                <Toggle label="Collapse main's replies" hint="In the transcript, for sessions hosted here." checked={prefs.collapseHosted} onChange={(v) => ui({ collapseHosted: v })} />
                <DefaultShellRow value={prefs.defaultShell} onChange={(defaultShell) => ui({ defaultShell })} />
              </Section>

              {desktop ? (
                <Section id="notifications" title="Notifications" intro="Windows notifications while Cora isn't in front.">
                  <Toggle label="A session needs a permission decision" checked={prefs.notifyNeedsYou} onChange={(v) => ui({ notifyNeedsYou: v })} />
                  <Toggle label="A hosted session finishes its turn" checked={prefs.notifyFinished} onChange={(v) => ui({ notifyFinished: v })} />
                  <Toggle label="Claude creates an explain" checked={prefs.notifyExplains} onChange={(v) => ui({ notifyExplains: v })} />
                  <Toggle label="A GitLab pipeline finishes" hint="One a session follows." checked={prefs.notifyPipelines} onChange={(v) => ui({ notifyPipelines: v })} />
                </Section>
              ) : null}

              {desktop?.jira ? (
                <Boundary name="Jira settings">
                  <JiraSection server={server} save={(p) => save(p)} />
                </Boundary>
              ) : null}

              <Boundary name="GitLab settings">
                <GitlabSection server={server} save={trySave} />
              </Boundary>

              <Boundary name="Slack settings">
                <SlackSection server={server} save={(p) => save(p)} />
              </Boundary>
              <Boundary name="Gmail settings">
                <GmailSection />
              </Boundary>
              {desktop?.opFill ? (
                <Boundary name="1Password settings">
                  <OnePasswordSection server={server} save={(p) => save(p)} />
                </Boundary>
              ) : null}
              <ToolsSection server={server} save={(p) => save(p)} />

              <Section id="scene" title="Scene" intro="The space your sessions' agents work in.">
                <Toggle
                  label="Star systems"
                  hint={space.mode === 'systems' ? 'A star system behind your agents: a planet, maybe moons, rings and an asteroid belt. Hyperspace takes you to a new one.' : 'Off: the classic deep space (stars and nebulae).'}
                  checked={space.mode === 'systems'}
                  onChange={(on) => setSpace({ mode: on ? 'systems' : 'classic' })}
                />
                {space.mode === 'systems' ? (
                  <Group label="Star system">
                    <Row label="Planet size">
                      <Choice value={space.size} onChange={(size) => setSpace({ size })} options={[['small', 'Smaller'], ['normal', 'Normal'], ['large', 'Larger']]} />
                    </Row>
                    <Row label="Brightness" hint="How bright the planet and its moons are. Your agents stay the brightest thing either way.">
                      <Choice value={space.brightness} onChange={(brightness) => setSpace({ brightness })} options={[['dim', 'Dim'], ['normal', 'Normal'], ['bright', 'Bright']]} />
                    </Row>
                    <Toggle label="Moons" checked={space.moons} onChange={(moons) => setSpace({ moons })} />
                    <Toggle label="Rings" checked={space.rings} onChange={(rings) => setSpace({ rings })} />
                    <Toggle label="Asteroid belts" checked={space.belts} onChange={(belts) => setSpace({ belts })} />
                    <Toggle label="Clouds" checked={space.clouds} onChange={(clouds) => setSpace({ clouds })} />
                    <Toggle label="Suns" hint="Some systems show their star on screen, with the planet lit from it." checked={space.suns} onChange={(suns) => setSpace({ suns })} />
                    <Toggle label="City lights" hint="Lights on the night side of inhabited worlds." checked={space.cities} onChange={(cities) => setSpace({ cities })} />
                    <Toggle label="Hyperspace button" hint="A small button above the mic in the scene's corner, shown when the pointer is over the scene. Jump to hyperspace in the palette (Ctrl+K) works either way." checked={space.button} onChange={(button) => setSpace({ button })} />
                    <Row label="New system">
                      <button className="btn" onClick={() => (close(), setTimeout(() => void jumpToHyperspace(), 150))}>
                        <Icon name="Rocket" size={12} /> Jump to hyperspace
                      </button>
                    </Row>
                  </Group>
                ) : null}
                <Group label="Space">
                  <Row label="Stars">
                    <Choice value={space.stars} onChange={(stars) => setSpace({ stars })} options={[['fewer', 'Fewer'], ['normal', 'Normal'], ['more', 'More']]} />
                  </Row>
                  <Row label="Nebula">
                    <Choice value={space.nebula} onChange={(nebula) => setSpace({ nebula })} options={[['off', 'Off'], ['subtle', 'Subtle'], ['normal', 'Normal'], ['vivid', 'Vivid']]} />
                  </Row>
                  <Toggle label="Drifting particles" hint="The motes that drift around your agents (they also turn off on their own when the scene needs to save effort)." checked={space.motes} onChange={(motes) => setSpace({ motes })} />
                </Group>
                <Toggle label="Flowing tubes" hint="Prototype: tool calls as liquid tubes with light pulsing down them while they run. Off: lines with a travelling comet." checked={prefs.flowLinks} onChange={(v) => ui({ flowLinks: v })} />
                <Toggle
                  label="3D scene"
                  hint="Off: the scene area becomes a flat live board with no graphics engine: panels you arrange (agents, changes, tests, the pipeline, the browser, a Spotlight that follows what matters…), on pages, each session its own. The overview shows its grid."
                  checked={prefs.scene3d !== false}
                  onChange={(v) => ui({ scene3d: v })}
                />
                <Toggle
                  label="Cora's eye as an orb"
                  hint="Cora's card shows a main agent's orb in Cora's colour (it thinks, waits, listens and speaks like one) instead of the lens, with the 3D scene on or off (a small graphics canvas of its own)."
                  checked={prefs.coraEye !== 'lens'}
                  onChange={(v) => ui({ coraEye: v ? 'orb' : 'lens' })}
                />
                <Toggle
                  label="Timeline"
                  hint={`The strip under the ${prefs.scene3d !== false ? '3D scene' : 'live board'} with the session's activity over time${prefs.scene3d !== false ? ' (drag it to rewind the scene)' : ''}. The tab on its edge folds it away; folded, it does no work. Kept separately for the 3D scene and the live board.`}
                  checked={prefs.scene3d !== false ? (prefs.timeline?.scene ?? true) : (prefs.timeline?.board ?? false)}
                  onChange={(v) => ui({ timeline: { ...prefs.timeline, [prefs.scene3d !== false ? 'scene' : 'board']: v } })}
                />
                <Row label="3D engine" hint="If the 3D view is blank or frozen: tears it down and builds it again. Nothing else restarts. (It also restarts itself when the graphics process resets.)">
                  <GlRestart />
                </Row>
              </Section>

              <Boundary name="Environments settings">
                <EnvironmentsSection server={server} save={trySave} />
              </Boundary>

              <Boundary name="Lockdown settings">
                <LockSection />
              </Boundary>

              <Boundary name="Security settings">
                <SecuritySection />
              </Boundary>

              <Section id="data" title="Data" intro="What Cora keeps on this machine.">
                {server ? (
                  <Row label="Keep history for" hint="Older events and sessions are forgotten. Claude Code's own transcripts aren't touched.">
                    <Choice value={String(server.retentionDays) as '3' | '7' | '14' | '30'} onChange={(d) => void save({ retentionDays: Number(d) })} options={[['3', '3 days'], ['7', '7 days'], ['14', '14 days'], ['30', '30 days']]} />
                  </Row>
                ) : null}
              </Section>
            </SettingsPage.Provider>
            {err ? <div className="ny-err">{err}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Settings › Terminal: the shell + opens beside a session's Claude (the others are a click away, in its ⌄ menu). */
function DefaultShellRow({ value, onChange }: { value?: string; onChange(id: string): void }) {
  const kinds = useShells((s) => s.kinds);
  useEffect(() => void loadShellKinds(), []);
  if (!kinds?.length) return null;
  const cur = kinds.find((k) => k.id === value) ?? kinds[0];
  return (
    <Row label="New shell tabs" hint="What + opens next to a session's Claude. The others are in the menu beside it.">
      <select className="set-input" value={cur.id} onChange={(e) => onChange(e.target.value)}>
        {kinds.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name}
          </option>
        ))}
      </select>
      <button className="btn ghost" title="Look again (after installing Git or a WSL distro)" onClick={() => void loadShellKinds(true)}>
        <Icon name="RefreshCw" size={12} />
      </button>
    </Row>
  );
}

const CLAUDE_HOW: Record<string, string> = {
  npm: 'the npm install',
  native: "Claude's own installer",
  path: 'on your PATH',
  custom: 'a stand-in (development)',
  unix: 'on your PATH',
};

/** Settings › Sessions: which Claude Code Cora runs (sessions, names, drafts, Cora's agent all use it). */
function ClaudeCodeRow() {
  const [c, setC] = useState<{ how: string; path: string | null } | null>(null);
  useEffect(() => {
    void fetch('/api/claude')
      .then((r) => (r.ok ? r.json() : null))
      .then(setC)
      .catch(() => {});
  }, []);
  if (!c) return null;
  const bad = c.how === 'missing' || c.how === 'shim';
  const hint =
    c.how === 'missing'
      ? "Cora can't find claude.exe: install Claude Code (claude.ai/install), then restart Cora."
      : c.how === 'shim'
        ? "Found only the npm shim (claude.cmd), started through cmd.exe: some characters in a first prompt can't get through. Reinstalling Claude Code fixes it."
        : `Found ${CLAUDE_HOW[c.how] ?? c.how}. Sessions, names, drafts and Cora's agent all run it.`;
  return (
    <Row label="Claude Code" hint={hint}>
      {c.path ? <code className="dim">{c.path}</code> : <span className={bad ? 'ny-err' : 'dim'}>{c.how === 'missing' ? 'Not found' : 'claude.cmd'}</span>}
    </Row>
  );
}
