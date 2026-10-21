import { useEffect, useState } from 'react';
import { useBrain } from '../state/store';
import { connectSlack, disconnectSlack, loadSlack, setAppToken, setBotToken, slackAppUrl, stopGrant, stopWatch, useSlack } from '../state/slack';
import { sessionName } from '../lib/format';
import type { Settings } from '@cora/shared';
import { BotRow, BotSettings } from './SlackBotSettings';
import { FollowRows } from './SlackFollowSettings';
import { NoteTemplateRows } from './NoteTemplatesSettings';
import { desktop } from '../lib/desktop';
import { DEFAULT_TOOLS, TOOL_TINTS, cleanTag, newTool, type ToolDef } from '../lib/tools';
import { Group, Row, Section, Toggle } from './settingsUi';
import { Icon } from './Icon';

const openOut = (url: string) => (desktop?.openExternal ? desktop.openExternal(url) : void window.open(url, '_blank', 'noopener'));

/**
 * Slack: connect your own Slack app (a user token, so messages go out as you). Sessions can then look people and
 * channels up, read conversations and draft messages; each message waits for you to send it.
 */
/** The sign-off on messages Cora sends for you, so whoever reads one knows Cora wrote it. */
function SignRow({ server, save }: { server: Settings; save(p: object): Promise<void> }) {
  const [sign, setSign] = useState(server.slack?.sign ?? ':cora:');
  const [err, setErr] = useState<string | null>(null);
  const commit = async () => {
    const v = sign.trim();
    if (v === (server.slack?.sign ?? ':cora:')) return;
    setErr(null);
    await save({ slack: { sign: v } }).catch((e: Error) => setErr(e.message));
  };
  return (
    <Row label="Sign Cora's messages" hint="Added to the end of every message Cora sends for you (not the replies you type yourself). A custom emoji needs to exist in your workspace. Empty: no sign-off.">
      <input className="set-input code" style={{ width: 160 }} value={sign} spellCheck={false} placeholder="none" onChange={(e) => setSign(e.target.value)} onBlur={() => void commit()} onKeyDown={(e) => e.key === 'Enter' && void commit()} />
      {err ? <span className="ny-err">{err}</span> : null}
    </Row>
  );
}

export function SlackSection({ server, save }: { server: Settings | null; save(p: object): Promise<void> }) {
  const status = useSlack((s) => s.status);
  const manifest = useSlack((s) => s.manifest);
  const grants = useSlack((s) => s.grants);
  const sessions = useBrain((s) => s.sessions);
  const bot = useSlack((s) => s.bot);
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  // a refresh token (token rotation on) also needs the app's credentials
  const rotating = /^xoxe-/.test(token.trim());
  const ready = !!token.trim() && (!rotating || (!!clientId.trim() && !!secret.trim()));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [botToken, setBotTok] = useState('');
  const [appToken, setApp] = useState('');
  // a refresh token for the app-level token; the Client ID and Secret are only needed when Cora doesn't have them yet
  const appRotating = /^xoxe-/.test(appToken.trim());
  const [appErr, setAppErr] = useState<string | null>(null);
  useEffect(() => void loadSlack(), []);

  const saveApp = async (t: string) => {
    setBusy(true);
    setAppErr(null);
    const e = await setAppToken(t, appRotating && (clientId.trim() || secret.trim()) ? { clientId, clientSecret: secret } : undefined);
    setBusy(false);
    if (e) setAppErr(e);
    else {
      setApp('');
      setClientId('');
      setSecret('');
    }
  };

  const connect = async () => {
    setBusy(true);
    setErr(null);
    const e = await connectSlack(token, rotating ? { clientId, clientSecret: secret } : undefined);
    // Cora's own bot, from the same page, if given
    const be = !e && botToken.trim() ? await setBotToken(botToken) : null;
    setBusy(false);
    if (e || be) setErr(e ?? `Connected as you, but the bot token: ${be}`);
    if (!e) {
      setToken('');
      setClientId('');
      setSecret('');
      if (!be) setBotTok('');
    }
  };
  const copyManifest = () => {
    if (!manifest) return;
    const json = JSON.stringify(manifest, null, 2);
    if (desktop?.writeClipboard) desktop.writeClipboard(json);
    else void navigator.clipboard?.writeText(json).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Section
      id="slack"
      title="Slack"
      intro={<>Sessions and Cora can look people and channels up, read a conversation or a thread for context, and draft messages for you to send as you; a message you ask Cora for goes out at once (with a few seconds to undo). Cora&apos;s own bot messages you as Cora while you&apos;re away (it pings your phone, with buttons for prompts) and takes instructions in that DM.</>}
    >
      {status.connected ? (
        <Row label="Account" hint={`Your token is kept in Cora's data folder on this computer. Disconnecting here doesn't remove the Slack app; remove it at api.slack.com/apps.`}>
          <span className="jset-me">
            <Icon name="CircleCheck" size={13} style={{ color: '#4ade80' }} /> Connected as <b>{status.user}</b> in {status.team}
          </span>
          <button className="btn ghost" onClick={() => void disconnectSlack()}>
            Disconnect
          </button>
        </Row>
      ) : null}
      {status.connected ? (
        <Row
          label="What's waiting"
          hint={
            status.search === false ? (
              <>
                Cora's briefs can include your Slack DMs and mentions, but the app can't search yet. At api.slack.com/apps open Cora's app, add the <b>search:read</b> user scope under OAuth &amp; Permissions, then <b>Reinstall to Workspace</b>.
              </>
            ) : (
              "Cora's briefs include your Slack DMs and mentions."
            )
          }
        >
          {status.search ? (
            <span className="jset-me">
              <Icon name="CircleCheck" size={13} style={{ color: '#4ade80' }} /> Can see your DMs and mentions
            </span>
          ) : status.search === false ? (
            <button className="btn" onClick={() => void loadSlack(true)}>
              <Icon name="RefreshCw" size={12} /> Check again
            </button>
          ) : (
            <span className="dim">checking…</span>
          )}
        </Row>
      ) : null}
      {status.connected && server ? <SignRow server={server} save={save} /> : null}
      {status.connected && grants.length ? (
        <Row label="Cora on its own" hint="Conversations you told Cora to carry on by itself: its messages there go out without asking (each can still be undone).">
          {grants.map((g) => (
            <span key={g.channel} className="jset-me">
              {g.label}
              {g.about ? ` · ${g.about}` : ''} · until {new Date(g.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              <button className="btn ghost" onClick={() => void stopGrant(g.channel)}>
                Stop
              </button>
            </span>
          ))}
        </Row>
      ) : null}
      {status.connected ? (
        <Row
          label="Live events"
          hint={
            status.live && status.live !== 'off' ? (
              <>Sessions can watch a Slack thread and hear a reply the moment it&apos;s posted. Cora connects out to Slack, so nothing here has to be reachable.</>
            ) : (
              <>
                So sessions can watch a thread and hear replies at once. At api.slack.com/apps, in Cora&apos;s app: turn on <b>Socket Mode</b>; under <b>Event Subscriptions</b>, subscribe to events on behalf of users (message.channels, message.groups, message.im, message.mpim) and <b>Reinstall to Workspace</b>; under{' '}
                <b>Basic Information → App-Level Tokens</b>, make one with <b>connections:write</b> and paste it here (xapp-…; with token rotation on, its <b>Refresh Token</b>, xoxe-1-…, and Cora renews it).
                Client ID and Secret: only if you didn&apos;t connect with a refresh token above.
              </>
            )
          }
        >
          {status.live && status.live !== 'off' ? (
            <>
              <span className="jset-me">
                {status.live === 'live' ? (
                  <>
                    <Icon name="CircleCheck" size={13} style={{ color: '#4ade80' }} /> Listening
                  </>
                ) : status.live === 'connecting' ? (
                  <span className="dim">connecting{status.liveError ? ` (${status.liveError})` : ''}…</span>
                ) : (
                  <span className="ny-err">Slack refused it: {status.liveError ?? 'error'}</span>
                )}
              </span>
              <button className="btn ghost" disabled={busy} onClick={() => void saveApp('')}>
                Turn off
              </button>
            </>
          ) : (
            <>
              <input
                className="set-input"
                type="password"
                value={appToken}
                placeholder="xapp-… or xoxe-1-…"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setApp(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && appToken.trim() && void saveApp(appToken)}
              />
              {appRotating ? (
                <>
                  <input className="set-input" value={clientId} placeholder="Client ID (if needed)" spellCheck={false} autoComplete="off" onChange={(e) => setClientId(e.target.value)} />
                  <input className="set-input" type="password" value={secret} placeholder="Client Secret (if needed)" spellCheck={false} autoComplete="off" onChange={(e) => setSecret(e.target.value)} />
                </>
              ) : null}
              <button className="btn allow" disabled={busy || !appToken.trim()} onClick={() => void saveApp(appToken)}>
                Turn on
              </button>
            </>
          )}
          {appErr ? <span className="ny-err">{appErr}</span> : null}
        </Row>
      ) : null}
      {status.connected && status.watches?.length ? (
        <Row label="Watching for replies" hint="Threads your sessions (or Cora) are waiting on: when someone replies, it's typed into that session. Stop one and the session isn't told.">
          {status.watches.map((w) => (
            <span key={w.id} className="jset-me" title={w.about ?? w.where}>
              {w.where}
              {w.about ? ` · ${w.about}` : ''} · {sessions[w.sessionId] ? sessionName(sessions[w.sessionId]) : 'Cora'} · until {new Date(w.until).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
              <button className="btn ghost" onClick={() => void stopWatch(w.id)}>
                Stop
              </button>
            </span>
          ))}
        </Row>
      ) : null}
      {status.connected ? (
        <Group label="Inbox: channels I follow">
          {status.live !== 'live' ? <Row label="Needs live events" hint="Cora hears Slack's messages through live events (above): turn them on for DMs, mentions and the channels you follow to come into the Inbox.">{null}</Row> : null}
          <FollowRows server={server} save={save} />
        </Group>
      ) : null}
      {status.connected ? <BotRow /> : null}
      {status.connected && bot?.connected ? (
        <Group label="Cora while you're away">
          <BotSettings server={server} save={save} />
        </Group>
      ) : null}
      {status.connected ? null : (
        <>
          <Row label="1. Create the app" hint={<>Slack opens with Cora&apos;s app filled in: it works as you, and has Cora&apos;s own bot. Pick your workspace, create it, then press <b>Install to Workspace</b> (your admin may need to approve).</>}>
            <button className="btn" disabled={!manifest} onClick={() => manifest && openOut(slackAppUrl(manifest))}>
              <Icon name="ExternalLink" size={12} /> Create Cora&apos;s Slack app
            </button>
            <button className="btn ghost" disabled={!manifest} onClick={copyManifest} title="To create it by hand: From a manifest">
              <Icon name="Copy" size={12} /> {copied ? 'Copied' : 'Copy the manifest'}
            </button>
          </Row>
          <Row
            label="2. Paste its tokens"
            hint={
              <>
                From the app&apos;s <b>OAuth &amp; Permissions</b> page: the <b>User OAuth Token</b> (xoxp-…; with token rotation on, its Refresh Token) and the <b>Bot User OAuth Token</b> (xoxb-…).
              </>
            }
          >
            <input
              className="set-input"
              type="password"
              value={token}
              placeholder="xoxp-… or xoxe-1-…"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ready && void connect()}
            />
            {rotating ? (
              <>
                <input className="set-input" value={clientId} placeholder="Client ID" spellCheck={false} autoComplete="off" onChange={(e) => setClientId(e.target.value)} />
                <input
                  className="set-input"
                  type="password"
                  value={secret}
                  placeholder="Client Secret"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setSecret(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && ready && void connect()}
                />
              </>
            ) : null}
            <input className="set-input" type="password" value={botToken} placeholder="xoxb-… (Cora's bot)" spellCheck={false} autoComplete="off" onChange={(e) => setBotTok(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ready && void connect()} />
            <button className="btn allow" disabled={busy || !ready} onClick={() => void connect()}>
              {busy ? 'Checking…' : 'Connect'}
            </button>
            {err || (!status.connected && status.error) ? <span className="ny-err">{err ?? (status as { error?: string }).error}</span> : null}
          </Row>
        </>
      )}
    </Section>
  );
}

/** Tools: web apps in the left nav's drawer (Slack to start with). */
export function ToolsSection({ server, save }: { server?: Settings | null; save?(p: object): Promise<void> } = {}) {
  const tools = useBrain((s) => s.prefs.tools);
  const set = (next: ToolDef[]) => useBrain.getState().setPrefs({ tools: next });
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const add = () => {
    const t = newTool(name, url, tools);
    if (typeof t === 'string') return setErr(t);
    set([...tools, t]);
    setName('');
    setUrl('');
    setErr(null);
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...tools];
    const [t] = next.splice(i, 1);
    next.splice(i + d, 0, t);
    set(next);
  };
  const edit = (i: number, p: Partial<ToolDef>) => set(tools.map((t, j) => (j === i ? { ...t, ...p } : t)));

  return (
    <Section id="tools" title="Tools" intro={<>Web apps that stay open for the whole app: the nav&apos;s Tools buttons (Ctrl+1…9) open them in a drawer beside the session. They share logins with Cora&apos;s browser. Give tools that look alike a tint and a tag (PRD, STG, DEV), and put related ones in a folder.</>}>
      {tools.map((t, i) => (
        <Row key={t.id} wide>
          <span className="tl-tool">
            <span className="tl-line">
              <input className="set-input tl-name" value={t.name} onChange={(e) => edit(i, { name: e.target.value })} aria-label="Name" />
              <input className="set-input tl-url" value={t.url} spellCheck={false} onChange={(e) => edit(i, { url: e.target.value })} aria-label="Address" />
              <button className="icon-btn" disabled={i === 0} title="Move up" onClick={() => move(i, -1)}>
                <Icon name="ArrowUp" size={12} />
              </button>
              <button className="icon-btn" disabled={i === tools.length - 1} title="Move down" onClick={() => move(i, 1)}>
                <Icon name="ArrowDown" size={12} />
              </button>
              <button className="icon-btn" title="Remove" onClick={() => set(tools.filter((_, j) => j !== i))}>
                <Icon name="Trash2" size={12} />
              </button>
            </span>
            {/* how it looks in the nav: a tint, a tag, a folder */}
            <span className="tl-look">
              <span className="tl-lab">Tint</span>
              <button className={`tl-sw none${t.tint ? '' : ' on'}`} title="No tint" onClick={() => edit(i, { tint: undefined })} />
              {TOOL_TINTS.map((c) => (
                <button key={c} className={`tl-sw${t.tint === c ? ' on' : ''}`} style={{ ['--sc' as string]: c } as React.CSSProperties} title={`Tint it ${c}`} onClick={() => edit(i, { tint: c })} />
              ))}
              <span className="tl-lab">Tag</span>
              <input className="set-input tl-tag" value={t.tag ?? ''} placeholder="PRD" maxLength={3} spellCheck={false} aria-label="Tag" onChange={(e) => edit(i, { tag: cleanTag(e.target.value) || undefined })} />
              <span className="tl-lab">Folder</span>
              <input className="set-input tl-folder" value={t.folder ?? ''} placeholder="none" list="tl-folders" spellCheck={false} aria-label="Folder" onChange={(e) => edit(i, { folder: e.target.value.slice(0, 30) || undefined })} />
            </span>
          </span>
        </Row>
      ))}
      <datalist id="tl-folders">
        {[...new Set(tools.map((t) => t.folder?.trim()).filter(Boolean))].map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <Row wide label={tools.length ? 'Add one' : 'Your tools'} hint={!tools.some((t) => t.id === 'slack') ? <button className="linkish" onClick={() => set([...DEFAULT_TOOLS, ...tools])}>Put Slack back</button> : 'Your Jira board, GitLab merge requests, Grafana, Kibana…'}>
        <input className="set-input tl-name" value={name} placeholder="Name" onChange={(e) => setName(e.target.value)} />
        <input className="set-input tl-url" value={url} placeholder="https://…" spellCheck={false} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn" disabled={!url.trim()} onClick={add}>
          <Icon name="Plus" size={12} /> Add
        </button>
        {err ? <span className="ny-err">{err}</span> : null}
      </Row>
      {server && save ? (
        <Group label="Cora's browser">
          <Toggle
            label="Your Chrome bookmarks and history"
            hint="Suggested as you type an address, and your bookmarks bar on a new tab: read from this PC's Chrome (and Edge) profiles, never sent anywhere. Sign-ins can't come over: the browsers keep those encrypted for themselves."
            checked={server.browser?.chrome !== false}
            onChange={(on) => void save({ browser: { chrome: on } })}
          />
        </Group>
      ) : null}
      <Group label="Notes templates">
        <NoteTemplateRows />
      </Group>
    </Section>
  );
}
