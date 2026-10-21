import { useEffect, useState } from 'react';
import { DEFAULT_TICKET_START, isJiraHost, type JiraAlertLevel, type JiraEventKind, type JiraStartMode, type JiraWatchSettings, type Settings, type TicketStart } from '@cora/shared';
import { useJiraWatch } from '../state/jiraWatch';
import { useOrch } from '../state/orchestrator';
import { ago } from '../lib/format';
import { jiraSite, refreshJira, setJiraSite, useJira } from '../state/jira';
import { useBrain } from '../state/store';
import { Icon } from './Icon';
import { openInBrowser } from './JiraChip';
import { Choice, Group, Row, Section, Toggle } from './settingsUi';

/** Settings › Jira (desktop app): which site, whether the browser is signed in to it, the projects it knows. */
export function JiraSection({ server, save }: { server: Settings | null; save(p: object): Promise<void> }) {
  const st = useJira();
  const site = jiraSite(st);
  // watching: the site to watch follows the one found or typed here
  const watch = server?.jira?.watch;
  useEffect(() => {
    if (watch?.on && site && site !== watch.site) void save({ jira: { watch: { site } } });
  }, [site, watch?.on, watch?.site]);
  const [draft, setDraft] = useState(st.site);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(st.site), [st.site]);
  const bad = draft.trim() !== '' && !isJiraHost(draft.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
  const refresh = async () => {
    setBusy(true);
    await refreshJira({ projects: true });
    setBusy(false);
  };
  const signIn = () => {
    if (!site) return;
    useBrain.getState().setModal(null);
    openInBrowser(`https://${site}/`, useBrain.getState().focus ?? undefined);
  };

  return (
    <Section id="jira" title="Jira" intro={<>Ticket keys and Jira links in transcripts become chips with the ticket&apos;s status; hover for its summary. Read-only, through your Jira login in Cora&apos;s browser: no API token.</>}>
      <Row label="Site" hint={st.site ? 'Set by you. Clear it to find it again on its own.' : st.detected ? 'Found on its own (your login in Cora’s browser, or Jira links in transcripts).' : 'Not found yet: sign in to Jira in Cora’s browser, or type it.'}>
        <input
          className="set-input"
          value={draft}
          placeholder={st.detected ?? 'yourcompany.atlassian.net'}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => !bad && setJiraSite(draft)}
          onKeyDown={(e) => e.key === 'Enter' && !bad && setJiraSite(draft)}
        />
        {bad ? <span className="ny-err">a host name, like yourcompany.atlassian.net</span> : null}
      </Row>
      <Row label="Login" hint={st.auth === 'ok' && st.projects.length ? `${st.projects.length} projects: ${st.projects.slice(0, 12).join(', ')}${st.projects.length > 12 ? '…' : ''}` : undefined}>
        {!site ? (
          <span className="dim">no site yet</span>
        ) : st.auth === 'ok' ? (
          <span className="jset-me">
            <Icon name="CircleCheck" size={13} style={{ color: '#4ade80' }} /> Signed in{st.me?.name ? ` as ${st.me.name}` : ''}
          </span>
        ) : st.auth === 'signed-out' ? (
          <button className="btn" onClick={signIn}><Icon name="LogIn" size={12} /> Sign in to {site} in Cora&apos;s browser</button>
        ) : st.auth === 'offline' ? (
          <span className="dim">Couldn&apos;t reach {site}</span>
        ) : (
          <span className="dim">checking…</span>
        )}
        {site ? (
          <button className="btn ghost" onClick={() => void refresh()} disabled={busy} title="Check the login and reload the project list">
            <Icon name="RefreshCw" size={12} /> {busy ? 'Checking…' : 'Check again'}
          </button>
        ) : null}
      </Row>
      {server ? <TicketStartRow t={server.jira.ticket} save={save} /> : null}
      {watch ? (
        <Group label="Watch Jira for me">
          <WatchRows w={watch} save={save} site={site} />
        </Group>
      ) : null}
    </Section>
  );
}

const KINDS: Array<[JiraEventKind, string, string]> = [
  ['assigned', 'Assigned to you', 'A ticket put in your name by someone else.'],
  ['mentioned', '@mentions', 'Someone tags you in a comment or a description.'],
  ['commented', 'Comments on your tickets', "Someone else comments on a ticket that's yours."],
  ['status', 'Status changes on your tickets', 'Someone else moves one of your tickets (to QA, back to In Progress…).'],
  ['watched', 'Tickets you watch', "Comments and moves on tickets you watch that aren't yours."],
];
const STARTS: Array<[JiraStartMode, string]> = [
  ['tell', 'Just tell me'],
  ['offer', 'Offer to start it'],
  ['auto', 'Start it on its own'],
];
const START_HINT: Record<JiraStartMode, string> = {
  tell: "A card and, if you like, Cora's voice: as set above.",
  offer: 'Cora picks a folder and offers to start it with /jira; you can pick another.',
  auto: 'It runs /jira KEY and stops after its summary and plan. At most 2 at a time; beyond that it offers instead.',
};
const LEVELS: Array<[JiraAlertLevel, string]> = [
  ['off', 'Off'],
  ['quiet', 'Quietly'],
  ['notify', 'Notify'],
  ['say', 'Notify and say it'],
];

/** Watch Jira for me: the switch, how it's going, and how loudly each kind is told (the page's Group holds them). */
function WatchRows({ w, save, site }: { w: JiraWatchSettings; save(p: object): Promise<void>; site: string | null }) {
  const status = useJiraWatch((s) => s.status);
  const orchOn = useOrch((s) => !!s.status?.enabled);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const line =
    status.state === 'paused'
      ? `Paused: ${status.message ?? 'waiting for Jira'}`
      : status.state === 'error'
        ? (status.message ?? 'Jira checks are failing')
        : status.checkedAt
          ? `Checking every 30 s (2 min while you're away) · last checked ${ago(status.checkedAt, now)} ago${status.mentionFallback ? ' · finding mentions in comments' : ''}`
          : 'Checking every 30 s: the first check is on its way.';
  return (
    <>
      <Toggle
        label="Watch Jira"
        hint={w.on ? line : "Cora looks at Jira every 30 seconds (every 2 minutes while you're away) through your login in its browser (read-only) and tells you what you'd want to know."}
        checked={w.on}
        onChange={(on) => void save({ jira: { watch: { on, ...(on && site ? { site } : {}) } } })}
      />
      {w.on
        ? KINDS.map(([k, label, hint]) => (
            <Row key={k} label={label} hint={hint}>
              <Choice value={w.kinds[k]} onChange={(v) => void save({ jira: { watch: { kinds: { [k]: v } } } })} options={LEVELS} />
            </Row>
          ))
        : null}
      {w.on ? (
        <Row label="When a ticket is assigned to you" hint={orchOn ? START_HINT[w.start] : 'Needs Cora on (Settings → Cora Orchestrator); until then it just tells you.'}>
          <span className={orchOn ? undefined : 'set-dim'}>
            <Choice value={w.start} onChange={(start) => void save({ jira: { watch: { start } } })} options={STARTS} />
          </span>
        </Row>
      ) : null}
    </>
  );
}

/**
 * How a session started from a ticket begins: your own command (your /jira skill, found by itself on Auto), or Cora's
 * ticket prompt, which needs no skill and no Jira tool (Cora reads the ticket through your Jira login).
 */
function TicketStartRow({ t, save }: { t: TicketStart | undefined; save(p: object): Promise<void> }) {
  const cur = { ...DEFAULT_TICKET_START, ...t };
  const [cmd, setCmd] = useState(cur.command);
  const [auto, setAuto] = useState<string | null>(null);
  useEffect(() => {
    void fetch('/api/ticket-start')
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => setAuto(u ? (u.use === 'command' ? `your ${u.command}` : "Cora's ticket prompt") : null))
      .catch(() => {});
  }, [cur.with, cur.command]);
  const hint =
    cur.with === 'auto'
      ? `Your own /jira when you have one, else Cora's ticket prompt.${auto ? ` Now: ${auto}.` : ''}`
      : cur.with === 'cora'
        ? "Cora writes the first prompt from the ticket (its summary, status and description), then asks for a plan. No skill or Jira tool needed."
        : 'Your own slash command, given the ticket key (e.g. /jira PROJ-123).';
  return (
    <Row label="Start ticket sessions with" hint={hint}>
      <Choice value={cur.with} onChange={(w) => void save({ jira: { ticket: { with: w } } })} options={[['auto', 'Auto'], ['cora', "Cora's prompt"], ['command', 'My command']]} />
      {cur.with === 'command' ? (
        <input className="set-input code" style={{ width: 110 }} value={cmd} spellCheck={false} placeholder="/jira" onChange={(e) => setCmd(e.target.value)} onBlur={() => cmd.trim() && cmd.trim() !== cur.command && void save({ jira: { ticket: { command: cmd.trim() } } })} />
      ) : null}
    </Row>
  );
}
