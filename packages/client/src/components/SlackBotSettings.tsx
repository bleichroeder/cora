import { useState } from 'react';
import { DEFAULT_SLACK_BOT, type FinishedMode, type Settings } from '@cora/shared';
import { loadSlack, setBotToken, testBot, useSlack } from '../state/slack';
import { Choice, Row, Switch, Toggle } from './settingsUi';
import { Icon } from './Icon';

/**
 * Cora's own Slack bot, inside Settings › Slack: its token, then (once it's there) what it tells you while you're
 * away. While you're away it messages you as itself (its messages ping your phone; a prompt comes with Allow and
 * Deny), and what you write in that DM goes to Cora. Messaging as you is unchanged.
 */

const AWAY: Array<[number, string]> = [
  [5, '5 min'],
  [10, '10 min'],
  [15, '15 min'],
  [30, '30 min'],
  [60, '1 hour'],
];
const FINISHED: Array<[FinishedMode, string]> = [
  ['ping', 'Ping'],
  ['digest', 'Digest'],
  ['off', 'Off'],
];
const CAPS: Array<[number, string]> = [
  [20, '20'],
  [40, '40'],
  [100, '100'],
];

/** The bot's row: connected (test, disconnect), or its token to paste. */
export function BotRow() {
  const bot = useSlack((s) => s.bot);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const connect = async (t: string) => {
    setBusy(true);
    setErr(null);
    const e = await setBotToken(t);
    setBusy(false);
    if (e) setErr(e);
    else (setToken(''), void loadSlack());
  };
  const test = async () => {
    setBusy(true);
    const e = await testBot();
    setBusy(false);
    setTested(e ? `Not sent: ${e}` : 'Sent: look in your DM with Cora');
    setTimeout(() => setTested(null), 6000);
  };
  if (bot?.connected)
    return (
      <Row label="Cora's own bot" hint={`Cora messages you as itself here, so it pings your phone. ${bot.sentToday} message${bot.sentToday === 1 ? '' : 's'} today.${bot.error ? ` Last error: ${bot.error}.` : ''}`}>
        <span className="jset-me">
          <Icon name="CircleCheck" size={13} style={{ color: '#4ade80' }} /> <b>@{bot.name}</b>
        </span>
        <button className="btn" disabled={busy} onClick={() => void test()}>
          <Icon name="Send" size={12} /> Send a test message
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => void connect('')}>
          Disconnect
        </button>
        {tested ? <span className={tested.startsWith('Sent') ? 'dim' : 'ny-err'}>{tested}</span> : null}
      </Row>
    );
  return (
    <>
      <Row
        label="Cora's own bot"
        hint={<>Cora messages you as itself (it pings your phone while you&apos;re away) and takes instructions in that DM. The <b>Bot User OAuth Token</b> (xoxb-…) from the app&apos;s OAuth &amp; Permissions page.</>}
      >
        <input className="set-input" type="password" value={token} placeholder="xoxb-…" spellCheck={false} autoComplete="off" onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && token.trim() && void connect(token)} />
        <button className="btn allow" disabled={busy || !token.trim()} onClick={() => void connect(token)}>
          {busy ? 'Checking…' : 'Connect'}
        </button>
        {err ? <span className="ny-err">{err}</span> : null}
      </Row>
    </>
  );
}

/**
 * What Cora's bot does while you're away: the rows of the Slack section's group (the section puts them under its
 * label; only a Group placed straight in a Section gets its own panel).
 */
export function BotSettings({ server, save }: { server: Settings | null; save(p: object): Promise<void> }) {
  const bot = useSlack((s) => s.bot);
  const status = useSlack((s) => s.status);
  if (!bot?.connected) return null;
  const c = server?.slackBot ?? DEFAULT_SLACK_BOT;
  const set = (p: object) => void save({ slackBot: p });
  const live = status.connected && status.live === 'live';
  return (
    <>
      {!live ? (
        <Row label="Needs live events" hint="Its buttons and your messages to it come through Slack's live connection.">
          <span className="ny-err">Turn on Live events above</span>
        </Row>
      ) : null}
      <Toggle label="Message me while I'm away" hint={bot.away ? `You're away now${bot.quiet ? ' (quiet hours)' : ''}.` : "You're at your PC now."} checked={c.alerts} onChange={(alerts) => set({ alerts })} />
      <Row label="Away after" hint="No keyboard or mouse for this long, or the screen locked.">
        <Choice value={c.awayMinutes} onChange={(awayMinutes) => set({ awayMinutes })} options={AWAY} />
      </Row>
      <Toggle label="Whatever waits for your OK" hint="Prompts (Allow / Deny; they wait up to an hour instead of two minutes), Slack drafts (Send / Discard) and Cora's cards (Yes / No). What was waiting when you left comes then." checked={c.ping.prompts} onChange={(prompts) => set({ ping: { prompts } })} />
      <Toggle label="Failures" hint="A pipeline a session follows failed; a dev bump didn't roll out." checked={c.ping.failures} onChange={(failures) => set({ ping: { failures } })} />
      <Toggle label="Tickets assigned to me" checked={c.ping.tickets} onChange={(tickets) => set({ ping: { tickets } })} />
      <Toggle label="Email I watch for" hint="Once Gmail is connected: new mail matching what you told Cora to watch for (Settings → Gmail)." checked={c.ping.mail !== false} onChange={(mail) => set({ ping: { mail } })} />
      <Row label="Finished sessions" hint="Digest: one message every 30 minutes while you're away.">
        <Choice value={c.finished} onChange={(finished) => set({ finished })} options={FINISHED} />
      </Row>
      <Row label="Quiet hours" hint="No messages between these times.">
        <Switch checked={c.quiet.on} onChange={(on) => set({ quiet: { on } })} />
        <input className="set-input" style={{ width: 118, flex: 'none' }} type="time" value={c.quiet.from} disabled={!c.quiet.on} onChange={(e) => e.target.value && set({ quiet: { from: e.target.value } })} />
        <span className="dim">to</span>
        <input className="set-input" style={{ width: 118, flex: 'none' }} type="time" value={c.quiet.to} disabled={!c.quiet.on} onChange={(e) => e.target.value && set({ quiet: { to: e.target.value } })} />
      </Row>
      <Row label="At most a day">
        <Choice value={c.dailyCap} onChange={(dailyCap) => set({ dailyCap })} options={CAPS} />
      </Row>
      <Toggle label="Take instructions in that DM" hint="What you write to Cora there goes to Cora's agent (it needs to be on), and its reply comes back. Only your messages count." checked={c.instructions} onChange={(instructions) => set({ instructions })} />
    </>
  );
}
