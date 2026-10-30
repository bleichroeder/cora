import { useEffect, useMemo, useState } from 'react';
import { INBOX_SOURCES, askCoraText, isUnread, newCount, sessionBrief, unreadCounts, type InboxItem, type InboxSource } from '@cora/shared';
import { dayGroups, markRead, openFromInbox, openItem, setFilter, setInboxOpen, setUnreadOnly, shownItems, useInbox } from '../state/inbox';
import { askCora, useOrch } from '../state/orchestrator';
import { joinCall, prepNotes } from '../state/calendar';
import { openNewSession } from './Launchers';
import { useBrain } from '../state/store';
import { seenTicket } from '../state/jiraWatch';
import { openInBrowser } from './JiraChip';
import { BrandIcon, BRAND_COLOR, SOURCE_LABEL } from './BrandIcon';
import { Icon } from './Icon';
import './inbox.css';

const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** "today 10:59", "yesterday 21:25", "Fri 16:10" */
const whenText = (t: number) => {
  const d = new Date(t).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  return `${d === today ? 'today' : d === today - 86_400_000 ? 'yesterday' : new Date(t).toLocaleDateString([], { weekday: 'short', month: d < today - 6 * 86_400_000 ? 'short' : undefined, day: d < today - 6 * 86_400_000 ? 'numeric' : undefined })} ${hhmm(t)}`;
};

/** One row under Cora's card: each source's logo with what's unread, or "all caught up". Opens the Inbox. */
export function InboxRow() {
  const items = useInbox((s) => s.items);
  const on = useBrain((s) => s.inbox);
  const counts = unreadCounts(items);
  const srcs = INBOX_SOURCES.filter((s) => counts[s]);
  return (
    <button className={`inbox-row${on ? ' on' : ''}${srcs.length ? '' : ' quiet'}`} onClick={() => setInboxOpen(!on)} title="Inbox: everything Cora told you, kept 14 days">
      <Icon name="Inbox" size={14} />
      <b>Inbox</b>
      <span className="ir-srcs">
        {srcs.length
          ? srcs.map((s) => (
              <span key={s} className="ir-src" title={`${counts[s]} unread from ${SOURCE_LABEL[s]}`}>
                <BrandIcon source={s} size={12} />
                {counts[s]}
              </span>
            ))
          : 'all caught up'}
      </span>
    </button>
  );
}

/**
 * The Inbox: a drawer by the nav, where Cora's console opens; with the console open it opens beside it, so you can
 * read and talk to Cora at once. Filters, the list by day, and the open item.
 */
export function InboxView() {
  const open = useBrain((st) => st.inbox);
  const beside = useOrch((st) => st.open && !!st.status?.enabled);
  const s = useInbox();
  const shown = useMemo(() => shownItems(s), [s.items, s.filter, s.unreadOnly]);
  const groups = useMemo(() => dayGroups(shown), [shown]);
  const counts = unreadCounts(s.items);
  const total = INBOX_SOURCES.reduce((n, k) => n + counts[k], 0);
  // a filter for each source that has something (and the one you're on)
  const sources = INBOX_SOURCES.filter((k) => k === s.filter || s.items.some((i) => i.source === k));
  const sel = s.items.find((i) => i.id === s.sel) ?? null;
  // nothing open: the newest shown (without marking it read)
  useEffect(() => {
    if (open && !sel && shown[0]) useInbox.setState({ sel: shown[0].id, selReadAt: shown[0].readAt });
  }, [open, sel, shown]);
  return (
    <div className={`inbox-view${open ? ' on' : ''}${beside ? ' beside' : ''}`} aria-hidden={!open}>
      <div className="ib-head">
        <h2>Inbox</h2>
        <div className="ib-filters">
          <button className={`ib-f${s.filter === 'all' ? ' on' : ''}`} onClick={() => setFilter('all')}>
            All {total ? <span className="n">{total}</span> : null}
          </button>
          {sources.map((k) => (
            <button key={k} className={`ib-f${s.filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>
              <BrandIcon source={k} size={12} />
              {SOURCE_LABEL[k]} {counts[k] ? <span className="n">{counts[k]}</span> : null}
            </button>
          ))}
        </div>
        <span className="ib-sp" />
        <label className="ib-unread">
          <input type="checkbox" checked={s.unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          <span className="ib-sw" />
          Unread
        </label>
        <button className="btn ghost" disabled={!total} onClick={() => markRead(s.filter === 'all' ? { all: true } : { source: s.filter })}>
          Mark all read
        </button>
        <button className="icon-btn" title="Close (Esc)" onClick={() => setInboxOpen(false)}>
          <Icon name="X" size={14} />
        </button>
      </div>
      <div className="ib-panes">
        <div className="ib-list">
          {groups.map((g) => (
            <section key={g.label}>
              <div className="ib-day">{g.label}</div>
              {g.items.map((i) => (
                <Row key={i.id} i={i} on={i.id === s.sel} />
              ))}
            </section>
          ))}
          {!shown.length ? <div className="ib-empty">{s.items.length ? (s.unreadOnly ? 'Nothing unread here.' : `Nothing from ${SOURCE_LABEL[s.filter as InboxSource]} lately.`) : 'Nothing yet. What Cora tells you about Jira, email, GitLab and its own work collects here for 14 days.'}</div> : null}
        </div>
        <div className="ib-detail">{sel ? <Detail i={sel} readAt={s.sel === sel.id ? s.selReadAt : sel.readAt} /> : null}</div>
      </div>
    </div>
  );
}

function Tile({ source }: { source: InboxSource }) {
  return (
    <span className="ib-tile" style={{ ['--c' as any]: BRAND_COLOR[source] }}>
      <BrandIcon source={source} size={14} />
    </span>
  );
}

function Row({ i, on }: { i: InboxItem; on: boolean }) {
  const unread = isUnread(i);
  const n = newCount(i);
  const top = i.entries[0];
  return (
    <button className={`ib-it${on ? ' on' : ''}${unread ? '' : ' read'}${i.state === 'failed' ? ' failed' : ''}`} onClick={() => openItem(i.id)}>
      <Tile source={i.source} />
      <span className="h">{i.title}</span>
      <span className="w">
        {unread && n > 1 ? <em>{n} new</em> : null}
        {unread ? <i /> : null}
        {hhmm(top?.at ?? i.at)}
      </span>
      <span className="d">
        {i.did ? `${i.did} · ` : ''}
        {top ? `${top.who ? `${top.who}: ` : ''}${top.text}` : ''}
      </span>
    </button>
  );
}

/** The whole item: its messages (oldest first, a marker where you left off), why it's here, what Cora did, and Open. */
function Detail({ i, readAt }: { i: InboxItem; readAt: number | null }) {
  const sessions = useBrain((s) => s.sessions);
  const entries = [...i.entries].reverse();
  const firstNew = readAt == null ? -1 : entries.findIndex((e) => e.got > readAt);
  const session = i.sessionId ? sessions[i.sessionId] : undefined;
  const coraOn = useOrch((st) => !!st.status?.enabled);
  const [replying, setReplying] = useState(false);
  // a "Git sign-in needed" note: sign in from here (Git's own sign-in window, because you asked)
  const signInHost = i.key.startsWith('git-sign-in:') && i.state === 'failed' ? i.key.slice('git-sign-in:'.length) : null;
  const [signing, setSigning] = useState<'idle' | 'busy' | { error: string }>('idle');
  const signIn = async () => {
    setSigning('busy');
    const r = await fetch('/api/git/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: signInHost }) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    setSigning(r?.ok ? 'idle' : { error: j.error ?? "Couldn't reach Cora" });
  };
  const canReply = i.source === 'slack' || (i.source === 'mail' && !!i.mailId);
  // a call coming up (your calendar): Join and its prep notes, instead of Open
  const call = i.key.startsWith('cal:') ? i.key.slice('cal:'.length) : null;
  const [prepping, setPrepping] = useState<'idle' | 'busy' | { error: string }>('idle');
  const prep = async () => {
    if (!call) return;
    setPrepping('busy');
    const err = await prepNotes(call);
    setPrepping(err ? { error: err } : 'idle');
    if (!err) setInboxOpen(false);
  };
  const start = () => {
    const cwd = session?.cwd;
    if (i.source === 'jira') return openNewSession(cwd, 'jira', { ticket: { key: i.key.replace(/^jira:/, '') } });
    // a GitLab to-do about an issue: started from the issue itself
    const gl = i.source === 'gitlab' ? /^gl:(.+)#(\d+)$/.exec(i.key) : null;
    if (gl) return openNewSession(cwd, 'gitlab', { issue: { project: gl[1], iid: Number(gl[2]) } });
    openNewSession(cwd, 'blank', { brief: sessionBrief(i) });
  };
  const open = () => {
    if (!i.link) return;
    // in your Tool for that site, else a window of its own: never the focused session's browser
    if (i.source === 'jira') seenTicket(i.key.replace(/^jira:/, ''));
    openFromInbox(i.link);
  };
  return (
    <>
      <div className="ib-dh">
        <Tile source={i.source} />
        <span>
          <b>{i.title}</b>
          <span>
            {SOURCE_LABEL[i.source]} · {whenText(i.entries[0]?.at ?? i.at)}
          </span>
        </span>
      </div>
      <div className="ib-msgs">
        {entries.map((e, n) => (
          <div key={e.id}>
            {n === firstNew && n > 0 ? <div className="ib-new">New since you looked</div> : null}
            <div className="ib-msg">
              <div className="who">
                {e.who ?? SOURCE_LABEL[i.source]} <span>{hhmm(e.at)}</span>
              </div>
              <p>{e.text}</p>
            </div>
          </div>
        ))}
        {i.mailId ? <MailBody key={i.id} id={i.id} /> : null}
        {i.source === 'slack' && i.link ? <SlackThread key={i.id} id={i.id} dm={!i.key.split(':')[2]} /> : null}
      </div>
      <div className="ib-why">
        Why it's here: <b>{i.why}</b>
      </div>
      {i.did ? (
        <div className="ib-why">
          What Cora did: <b>{i.did}</b>
        </div>
      ) : null}
      {replying ? <ReplyBox key={i.id} i={i} onDone={() => setReplying(false)} /> : null}
      {prepping === 'busy' ? <div className="ib-why">Drafting its prep notes (a minute or so)…</div> : null}
      {typeof prepping === 'object' ? (
        <div className="ib-why">
          No prep notes: <b>{prepping.error}</b>
        </div>
      ) : null}
      {signing === 'busy' ? <div className="ib-why">Signing in: answer Git's sign-in window (it may be behind this one).</div> : null}
      {typeof signing === 'object' ? (
        <div className="ib-why">
          Didn't sign in: <b>{signing.error}</b>
        </div>
      ) : null}
      <div className="ib-acts">
        {signInHost ? (
          <button className="btn allow" disabled={signing === 'busy'} title={`Run one git fetch that may ask you to sign in to ${signInHost}; then Cora fetches the rest`} onClick={() => void signIn()}>
            <Icon name="LogIn" size={12} /> {signing === 'busy' ? 'Signing in…' : 'Sign in…'}
          </button>
        ) : null}
        {call && i.link ? (
          <button className="btn allow" onClick={() => joinCall(i.link!)}>
            {/calendar\.google\.com/.test(i.link) ? (
              <>
                <Icon name="ExternalLink" size={12} /> Open in Calendar
              </>
            ) : (
              <>
                <Icon name="Video" size={12} /> Join
              </>
            )}
          </button>
        ) : null}
        {call ? (
          <button className="btn" disabled={prepping === 'busy'} onClick={() => void prep()}>
            <Icon name="NotebookText" size={12} /> Prep notes
          </button>
        ) : null}
        {canReply && !replying ? (
          <button className="btn allow" onClick={() => setReplying(true)}>
            <Icon name="Reply" size={12} /> {i.source === 'mail' ? 'Reply (a draft)…' : 'Reply…'}
          </button>
        ) : null}
        <button className="btn" disabled={!coraOn} title={coraOn ? 'Open Cora with this item, to ask about it' : "Cora's agent is off (Settings › Cora Orchestrator)"} onClick={() => askCora(askCoraText(i))}>
          <span className="brand-lens" style={{ width: 11, height: 11 }} /> Ask Cora
        </button>
        {i.source !== 'cora' ? (
          <button className="btn" onClick={start}>
            <Icon name="Plus" size={12} /> Start a session
          </button>
        ) : null}
        {i.link && !call ? (
          <button className="btn" onClick={open}>
            <Icon name="ExternalLink" size={12} /> Open in {i.source === 'mail' ? 'Gmail' : SOURCE_LABEL[i.source]}
          </button>
        ) : null}
        {session ? (
          <button className="btn ghost" onClick={() => (setInboxOpen(false), useBrain.getState().setFocus(session.id))}>
            <Icon name="SquareTerminal" size={12} /> Go to its session
          </button>
        ) : null}
      </div>
    </>
  );
}

/** Your reply, written here: Slack sends it as you (in its thread or DM); email makes a Gmail draft to check and send. */
function ReplyBox({ i, onDone }: { i: InboxItem; onDone(): void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mail = i.source === 'mail';
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/inbox/${encodeURIComponent(i.id)}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setErr(j.error ?? `HTTP ${r.status}`);
    if (mail && j.link) openInBrowser(j.link, undefined, true);
    onDone();
  };
  return (
    <div className="ib-reply">
      <textarea
        value={text}
        autoFocus
        rows={3}
        placeholder={mail ? 'Your reply: it becomes a draft in Gmail for you to check and send' : `Reply ${i.key.split(':')[2] ? 'in the thread' : 'in the DM'} as you (Ctrl+Enter sends)`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => (e.key === 'Enter' && (e.ctrlKey || e.metaKey) ? (e.preventDefault(), void send()) : e.key === 'Escape' ? (e.stopPropagation(), onDone()) : null)}
      />
      <span className="ib-reply-b">
        {err ? <span className="ny-err">{err}</span> : <span className="dim">{mail ? 'Nothing is sent: Gmail opens the draft.' : 'Sent as you (you can undo it for a few seconds).'}</span>}
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn allow" disabled={busy || !text.trim()} onClick={() => void send()}>
          {busy ? 'Sending…' : mail ? 'Make the draft' : 'Send'}
        </button>
      </span>
    </div>
  );
}

/** A Slack item's whole thread (or a DM's latest), on demand: lines of text. */
function SlackThread({ id, dm }: { id: string; dm: boolean }) {
  const [t, setT] = useState<{ lines?: string[]; error?: string } | null>(null);
  if (!t)
    return (
      <button
        className="btn ghost ib-more"
        onClick={() =>
          void fetch(`/api/inbox/${encodeURIComponent(id)}/thread`)
            .then((r) => r.json())
            .then(setT, () => setT({ error: 'Could not read it' }))
        }
      >
        <Icon name="MessagesSquare" size={12} /> {dm ? 'Show the conversation' : 'Show the whole thread'}
      </button>
    );
  return t.error ? <div className="ib-why">{t.error}</div> : <pre className="ib-mail">{(t.lines ?? []).join('\n')}</pre>;
}

/** An email read whole, on demand (its text, as text). */
function MailBody({ id }: { id: string }) {
  const [m, setM] = useState<{ body?: string; error?: string } | null>(null);
  if (!m)
    return (
      <button
        className="btn ghost ib-more"
        onClick={() =>
          void fetch(`/api/inbox/${encodeURIComponent(id)}/mail`)
            .then((r) => r.json())
            .then(setM, () => setM({ error: 'Could not read it' }))
        }
      >
        <Icon name="Mail" size={12} /> Read the whole email
      </button>
    );
  return m.error ? <div className="ib-why">{m.error}</div> : <pre className="ib-mail">{m.body}</pre>;
}
