import { useEffect, useRef, useState } from 'react';
import { MAX_MAIL_RULES, type MailRule, type MailWatch } from '@cora/shared';
import { desktop } from '../lib/desktop';
import { loadGmail, setGmail, useGmail } from '../state/gmail';
import { Group, Row, Section, Toggle } from './settingsUi';
import { Icon } from './Icon';

/**
 * Settings › Gmail: Cora reads your mail and writes drafts through your own Google app (a Desktop app client in your
 * Google Cloud project), so nobody else's app sits between you and your mail. Set up once: the app's JSON, then sign
 * in with Google in your browser. It never sends on its own.
 */

const openOut = (url: string) => (desktop?.openExternal ? desktop.openExternal(url) : void window.open(url, '_blank', 'noopener'));
const CONSOLE = 'https://console.cloud.google.com';
const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly\nhttps://www.googleapis.com/auth/gmail.compose\nhttps://www.googleapis.com/auth/calendar.readonly';

async function call(method: string, url: string, body?: unknown): Promise<{ ok: true; v: any } | { ok: false; error: string }> {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) }).catch(() => null);
  if (!r) return { ok: false, error: "Couldn't reach Cora" };
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, v: j } : { ok: false, error: j.error ?? `HTTP ${r.status}` };
}

export function GmailSection() {
  // shared with the Settings nav (its "connected" word)
  const st = useGmail((g) => g.status);
  const setSt = setGmail;
  const [json, setJson] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const load = loadGmail;
  useEffect(() => void load(), []);
  // signing in happens in your browser: look until it's done (or for five minutes)
  const until = useRef(0);
  useEffect(() => {
    if (!waiting) return;
    until.current = Date.now() + 5 * 60_000;
    const t = setInterval(async () => {
      const s = await load();
      if (s?.connected || Date.now() > until.current) (setWaiting(false), clearInterval(t));
    }, 2000);
    return () => clearInterval(t);
  }, [waiting]);

  const saveClient = async () => {
    setBusy(true);
    setErr(null);
    const r = await call('POST', '/api/gmail/client', { json });
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setSt(r.v);
    setJson('');
    setReplacing(false);
  };
  const connect = async () => {
    setErr(null);
    const r = await call('POST', '/api/gmail/connect');
    if (!r.ok) return setErr(r.error);
    openOut(r.v.url);
    setWaiting(true);
  };
  const disconnect = async () => {
    const r = await call('POST', '/api/gmail/disconnect');
    if (r.ok) setSt(r.v);
  };
  const config = async (c: { rules?: MailRule[]; important?: boolean; drafts?: boolean; draftTo?: string[]; send?: boolean }) => {
    setErr(null);
    const r = await call('POST', '/api/gmail/config', c);
    if (r.ok) setSt(r.v);
    else setErr(r.error);
    return r.ok;
  };
  const stopWatch = async (id: string) => {
    const r = await call('POST', `/api/gmail/watches/${encodeURIComponent(id)}/stop`);
    if (r.ok) setSt(r.v);
    else setErr(r.error);
  };
  const watch = async (on: boolean) => {
    const r = await call('POST', '/api/gmail/watch', { watch: on });
    if (r.ok) setSt(r.v);
  };
  const copyScopes = () => {
    if (desktop?.writeClipboard) desktop.writeClipboard(SCOPES);
    else void navigator.clipboard?.writeText(SCOPES);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const pasteRow = (
    <Row wide label={st?.client ? 'Replace the app' : '6. Paste its JSON'} hint="The file you downloaded (client_secret_….json): open it and paste everything here. It stays in Cora's data folder on this computer.">
      <textarea className="set-input gm-json" rows={4} value={json} spellCheck={false} placeholder='{"installed":{"client_id":"…","client_secret":"…"}}' onChange={(e) => setJson(e.target.value)} />
      <span className="tpl-acts">
        <button className="btn allow" disabled={busy || !json.trim()} onClick={() => void saveClient()}>
          {busy ? 'Checking…' : 'Save'}
        </button>
        {st?.client ? (
          <button className="btn ghost" onClick={() => (setReplacing(false), setJson(''), setErr(null))}>
            Cancel
          </button>
        ) : null}
        {err ? <span className="ny-err">{err}</span> : null}
      </span>
    </Row>
  );

  return (
    <Section id="gmail" title="Gmail" intro="Cora reads your mail and writes drafts through your own Google app, so no one else's app sits between you and your mail. It never sends on its own: drafts wait in Gmail for you.">
      {st && !st.client ? (
        <Group label="Set up your Google app (once)">
          <Row label="1. A Google Cloud project" hint="A new project just for Cora is cleanest. With a work Google account, make it inside your company's organization.">
            <button className="btn" onClick={() => openOut(`${CONSOLE}/projectcreate`)}>
              <Icon name="ExternalLink" size={12} /> New project
            </button>
          </Row>
          <Row label="2. Turn on the Gmail and Calendar APIs" hint="In that project (the calendar is for Cora's Today and her briefs before calls).">
            <button className="btn" onClick={() => openOut(`${CONSOLE}/apis/library/gmail.googleapis.com`)}>
              <Icon name="ExternalLink" size={12} /> Gmail API
            </button>
            <button className="btn ghost" onClick={() => openOut(`${CONSOLE}/apis/library/calendar-json.googleapis.com`)}>
              <Icon name="ExternalLink" size={12} /> Calendar API
            </button>
          </Row>
          <Row
            label="3. The sign-in screen"
            hint={
              <>
                Google Auth Platform → Get started: app name <b>Cora</b>, your email. Audience <b>Internal</b> with a work account (no warning, no expiry). With a personal account: <b>External</b>, add yourself as a test user, then <b>Publish</b> (or Google signs you out every 7 days).
              </>
            }
          >
            <button className="btn" onClick={() => openOut(`${CONSOLE}/auth/overview`)}>
              <Icon name="ExternalLink" size={12} /> Sign-in screen
            </button>
          </Row>
          <Row label="4. What Cora may do" hint="Data Access → Add or remove scopes → paste these three in the manual box (read mail; write drafts; read your calendar) → Update → Save.">
            <button className="btn" onClick={copyScopes}>
              <Icon name={copied ? 'Check' : 'Copy'} size={12} /> {copied ? 'Copied' : 'Copy the two'}
            </button>
            <button className="btn ghost" onClick={() => openOut(`${CONSOLE}/auth/scopes`)}>
              <Icon name="ExternalLink" size={12} /> Data Access
            </button>
          </Row>
          <Row label="5. A Desktop app client" hint="Clients → Create client → Application type Desktop app → Create → Download JSON.">
            <button className="btn" onClick={() => openOut(`${CONSOLE}/auth/clients/create`)}>
              <Icon name="ExternalLink" size={12} /> Create client
            </button>
          </Row>
          {pasteRow}
        </Group>
      ) : null}

      {st?.client ? (
        <Group label="Your mail">
          <Row label="Google app" hint={`Your own${st.project ? `, in project ${st.project}` : ''}.`}>
            <span className="jset-me">
              <Icon name="CircleCheck" size={13} style={{ color: '#4ade80' }} /> Ready
            </span>
            {!replacing ? (
              <button className="btn ghost" onClick={() => setReplacing(true)}>
                Replace
              </button>
            ) : null}
          </Row>
          {replacing ? pasteRow : null}
          {st.connected ? (
            <Row label="Account" hint={st.error ? `Last problem: ${st.error}` : 'Cora reads your mail and writes drafts. Disconnecting also removes its access at Google.'}>
              <span className="jset-me">
                <Icon name={st.error ? 'CircleAlert' : 'CircleCheck'} size={13} style={{ color: st.error ? '#fbbf24' : '#4ade80' }} /> <b>{st.email}</b>
              </span>
              {st.error ? (
                <button className="btn" onClick={() => void connect()}>
                  Connect again
                </button>
              ) : null}
              <button className="btn ghost" onClick={() => void disconnect()}>
                Disconnect
              </button>
            </Row>
          ) : (
            <Row label="Account" hint={waiting ? 'Finish signing in with Google in your browser, then come back.' : 'Google asks you to sign in and allow Cora, in your browser.'}>
              <button className="btn allow" disabled={waiting} onClick={() => void connect()}>
                <Icon name="Mail" size={12} /> {waiting ? 'Waiting for Google…' : 'Connect Gmail'}
              </button>
              {waiting ? (
                <button className="btn ghost" onClick={() => setWaiting(false)}>
                  Cancel
                </button>
              ) : null}
              {err ? <span className="ny-err">{err}</span> : null}
            </Row>
          )}
        </Group>
      ) : null}

      {st?.connected ? (
        <Group label="What Cora watches for">
          <Toggle
            label="Watch my inbox"
            hint={`Every minute, new mail matching one of these: Cora hears about it, and its Slack bot can tell you while you're away. Everything else is left alone.${st.lastCheck ? ` Last looked ${new Date(st.lastCheck).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : ''}`}
            checked={st.watch}
            onChange={(on) => void watch(on)}
          />
          {st.rules.map((r) => (
            <RuleRow key={r.id} rule={r} onSave={(n) => config({ rules: st.rules.map((x) => (x.id === r.id ? n : x)) })} onRemove={() => void config({ rules: st.rules.filter((x) => x.id !== r.id) })} />
          ))}
          {st.rules.length < MAX_MAIL_RULES ? <AddRule onAdd={(r) => config({ rules: [...st.rules, r] })} first={!st.rules.length} /> : null}
          <Toggle label="Also what Gmail marks important" hint="Unread, not promotions, social, updates or forums. Off by default: with a busy inbox it's a lot." checked={st.important} onChange={(important) => void config({ important })} />
          {!st.rules.length && !st.important ? (
            <Row label="Nothing yet">
              <span className="dim">Add something to watch for, or Cora watches nothing.</span>
            </Row>
          ) : null}
        </Group>
      ) : null}

      {st?.connected ? (
        <Group label="Waiting for">
          {st.watches.length ? (
            st.watches.map((w) => <WatchRow key={w.id} w={w} onStop={() => void stopWatch(w.id)} />)
          ) : (
            <Row label="Nothing" hint={'Tell Cora, or a session, what you\'re waiting for and what to do when it comes: "when QA replies about the login bug, look into it and ask me before replying".'}>
              <span className="dim">No email is being waited for.</span>
            </Row>
          )}
        </Group>
      ) : null}

      {st?.connected ? (
        <Group label="Drafts">
          <Toggle
            label="Let Cora write drafts"
            hint="Off: Cora can read your mail but never writes an email. On: it writes drafts when you ask (a reply, or a new email); they wait in Gmail for you to check and send. It never sends."
            checked={st.drafts}
            onChange={(drafts) => void config({ drafts })}
          />
          {st.drafts ? <DraftTo list={st.draftTo} onSave={(draftTo) => config({ draftTo })} /> : null}
          {st.drafts ? (
            <Toggle
              label="Sessions can ask to send"
              hint="When you ask a session to send an email, it waits in Cora for your Send: change who it's to, the subject or the words first, finish it in Gmail, or discard it. Nothing is ever sent without your click. Off: it stays a draft in Gmail."
              checked={!!st.send}
              onChange={(send) => void config({ send })}
            />
          ) : null}
        </Group>
      ) : null}
      {err && st?.connected ? <div className="ny-err">{err}</div> : null}
    </Section>
  );
}

const EXAMPLES = 'from:ana@example.com · from:@bigclient.com · subject:(outage OR incident) · to:support@example.com · from:boss is:unread';

/** One thing Cora watches for: its name and Gmail search, editable in place. */
function RuleRow({ rule, onSave, onRemove }: { rule: MailRule; onSave(r: MailRule): Promise<boolean>; onRemove(): void }) {
  const [edit, setEdit] = useState(false);
  const [label, setLabel] = useState(rule.label);
  const [query, setQuery] = useState(rule.query);
  if (!edit)
    return (
      <Row label={rule.label} hint={<code>{rule.query}</code>}>
        <button className="btn" onClick={() => setEdit(true)}>
          <Icon name="PencilLine" size={12} /> Edit
        </button>
        <button className="icon-btn" title="Stop watching for this" onClick={onRemove}>
          <Icon name="Trash2" size={13} />
        </button>
      </Row>
    );
  return (
    <Row wide label={<input className="set-input gm-label" value={label} placeholder="Name" aria-label="Name" onChange={(e) => setLabel(e.target.value)} />} hint={`A Gmail search, as in Gmail's search box: ${EXAMPLES}`}>
      <span className="gm-rule">
        <input className="set-input code" value={query} spellCheck={false} placeholder="from:ana@example.com" onChange={(e) => setQuery(e.target.value)} />
        <button className="btn allow" disabled={!query.trim()} onClick={() => void onSave({ ...rule, label: label.trim() || query.trim(), query: query.trim() }).then((ok) => ok && setEdit(false))}>
          Save
        </button>
        <button className="btn ghost" onClick={() => (setEdit(false), setLabel(rule.label), setQuery(rule.query))}>
          Cancel
        </button>
      </span>
    </Row>
  );
}

/** A new thing to watch for. */
function AddRule({ onAdd, first }: { onAdd(r: MailRule): Promise<boolean>; first: boolean }) {
  const [label, setLabel] = useState('');
  const [query, setQuery] = useState('');
  const add = () => void onAdd({ id: '', label: label.trim() || query.trim(), query: query.trim() }).then((ok) => ok && (setLabel(''), setQuery('')));
  return (
    <Row wide label={first ? 'Watch for' : 'Add another'} hint={`A name, and a Gmail search, as in Gmail's search box: ${EXAMPLES}`}>
      <span className="gm-rule">
        <input className="set-input gm-label" value={label} placeholder="Name (e.g. Boss)" onChange={(e) => setLabel(e.target.value)} />
        <input className="set-input code" value={query} spellCheck={false} placeholder="from:ana@example.com" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && query.trim() && add()} />
        <button className="btn allow" disabled={!query.trim()} onClick={add}>
          <Icon name="Plus" size={12} /> Add
        </button>
      </span>
    </Row>
  );
}

/** Who Cora's drafts may go to: addresses or @domains, or anyone. */
function DraftTo({ list, onSave }: { list: string[]; onSave(l: string[]): Promise<boolean> }) {
  const [text, setText] = useState(list.join(', '));
  const dirty = text.split(/[\s,]+/).filter(Boolean).join(',') !== list.join(',');
  return (
    <Row wide label="Only to" hint="Addresses or domains, comma-separated (ana@example.com, @example.com). Empty: anyone.">
      <span className="gm-rule">
        <input className="set-input code" value={text} spellCheck={false} placeholder="Anyone (or e.g. @example.com)" onChange={(e) => setText(e.target.value)} />
        <button className="btn allow" disabled={!dirty} onClick={() => void onSave(text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))}>
          Save
        </button>
      </span>
    </Row>
  );
}

/** An email being waited for: what, from whom, what happens when it comes; Stop. */
function WatchRow({ w, onStop }: { w: MailWatch; onStop(): void }) {
  const until = new Date(w.until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const act = w.act === 'tell' ? 'Tell me' : w.act === 'ask' ? 'Ask me, then' : 'Start';
  return (
    <Row
      label={w.about}
      hint={
        <>
          From <code>{w.from}</code> · {w.mode === 'thread' ? 'following the thread' : 'one email'} · until {until} · set by {w.by}
          {w.hits ? ` · ${w.hits} so far` : ''}
          <br />
          {act}
          {w.act === 'tell' ? '' : `: ${w.then}`}
        </>
      }
    >
      <button className="btn ghost" onClick={onStop}>
        Stop
      </button>
    </Row>
  );
}
