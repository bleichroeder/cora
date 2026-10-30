import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SlackBannerView } from './SlackBanner';
import { type SlackDraft, type SlackSent, type SlackTarget, type SlackAttachment } from '@cora/shared';
import { useBrain } from '../state/store';
import { decideDraft, findSlack, undoSent, useSlack, stopGrant } from '../state/slack';
import { useTools } from '../state/tools';
import { desktop } from '../lib/desktop';
import { sessionName } from '../lib/format';
import { slackTool } from '../lib/tools';
import { Icon } from './Icon';
import './tools.css';
import './popovers.css';

const KIND_ICON: Record<SlackTarget['kind'], string> = { channel: 'Hash', person: 'AtSign', group: 'Users' };

/**
 * Slack messages sessions want to send, each waiting for you: change who it's for or what it says, then send it as
 * you, take it to Slack to finish there, or discard it. Shown over whatever you're looking at.
 */
export function SlackOutbox() {
  const drafts = useSlack((s) => s.drafts);
  if (!drafts.length) return null;
  return (
    <div className="slack-outbox" role="region" aria-label="Slack messages waiting for you">
      {drafts.map((d) => (
        <DraftCard key={d.id} d={d} />
      ))}
    </div>
  );
}

/** A message Cora sent straight away because you asked: who it went to, and Undo while there's time (with the toasts). */
export function SentCard({ m, inline = false }: { m: SlackSent; /** in Cora's conversation: one line */ inline?: boolean }) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((m.until - now) / 1000));
  const granted = useSlack((s) => !!m.own && s.grants.some((g) => g.channel === m.own));
  return (
    <div className={`sd-sent${inline ? ' inline' : ''}`} role="status">
      <span className="sd-logo-tile">
        <Icon name="Send" size={13} />
      </span>
      <span className="sd-sent-t">
        <b>
          Sent to {m.to.label}
          {m.own && inline ? <span className="sd-own"> · on its own</span> : null}
          {inline && m.files?.length ? <span className="sd-own"> · {m.files.length === 1 ? m.files[0].name : `${m.files.length} files`}</span> : null}
        </b>
        {inline ? null : (
          <span>
            {m.own ? <span className="sd-own">On its own · </span> : null}
            {m.text.replace(/\s+/g, ' ')}
          </span>
        )}
        {m.files?.length ? inline ? null : <Attachments files={m.files} kind="sent" id={m.id} small /> : null}
        {err ? <span className="sd-err">{err}</span> : null}
      </span>
      {left > 0 ? (
        <button className="btn ghost" disabled={busy} onClick={() => (setBusy(true), void undoSent(m.id).then((e) => (setBusy(false), setErr(e))))} title="Delete it from Slack">
          <Icon name="Undo2" size={13} /> Undo <span className="sd-left">{left}s</span>
        </button>
      ) : null}
      {m.own && granted ? (
        <button className="btn ghost" onClick={() => void stopGrant(m.own)} title={`Stop Cora writing to ${m.to.label} by itself: its messages there come to you to confirm again`}>
          <Icon name="Square" size={11} />
          {inline ? ' Stop' : null}
        </button>
      ) : null}
      <a className="btn ghost" href={m.link} target="_blank" rel="noreferrer" title="Open it in Slack">
        <Icon name="ExternalLink" size={13} />
      </a>
    </div>
  );
}

function DraftCard({ d }: { d: SlackDraft }) {
  const [text, setText] = useState(d.text);
  const [to, setTo] = useState(d.to);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<null | 'send' | 'open' | 'discard'>(null);
  const [err, setErr] = useState<string | null>(null);
  // Cora's banner on top (a message with files has none)
  const [banner, setBanner] = useState(d.banner !== false);
  const session = useBrain((s) => (d.sessionId ? s.sessions[d.sessionId] : undefined));
  const tools = useBrain((s) => s.prefs.tools);
  const ta = useRef<HTMLTextAreaElement>(null);

  // the box fits its text (up to a point)
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`;
  }, [text]);

  const act = async (action: 'send' | 'opened' | 'discard') => {
    if (busy) return;
    setErr(null);
    setBusy(action === 'opened' ? 'open' : action);
    if (action === 'opened') {
      // the words go with you: paste them in Slack
      if (desktop?.writeClipboard) desktop.writeClipboard(text);
      else void navigator.clipboard?.writeText(text).catch(() => {});
    }
    const r = await decideDraft(d.id, { action, text, to, ...(action === 'send' ? { banner } : {}) });
    setBusy(null);
    if (!r.ok) return setErr(r.error ?? 'failed');
    if (action === 'opened' && r.url) {
      const slack = slackTool(tools);
      if (slack && desktop?.browser) useTools.getState().show(slack.id, r.url);
      else window.open(r.url, '_blank', 'noopener');
    }
  };
  const focusSession = () => d.sessionId && useBrain.getState().setFocus(d.sessionId);

  return (
    <div className="sd-card">
      <div className="sd-h">
        <Icon name="MessageSquare" size={13} className="sd-logo" />
        <b>Slack message</b>
        <span className="dim">
          from{' '}
          {session ? (
            <button className="linkish" onClick={focusSession} title="Go to the session">
              {sessionName(session)}
            </button>
          ) : (
            'a session'
          )}
        </span>
        <span className="spacer" />
        {!d.waiting ? <span className="sd-later" title="Claude carried on: it knows this message is waiting for you">waiting for you</span> : null}
      </div>
      <div className="sd-to">
        <span className="k">To</span>
        {picking ? (
          <Recipient
            onPick={(t) => {
              setTo(t);
              setPicking(false);
            }}
            onCancel={() => setPicking(false)}
          />
        ) : (
          <button className="sd-chip" onClick={() => setPicking(true)} title="Send it to someone else">
            <Icon name={KIND_ICON[to.kind]} size={12} />
            <span>{to.label.replace(/^#/, '')}</span>
            {to.detail ? <span className="dim">{to.detail}</span> : null}
            <Icon name="Pencil" size={11} className="sd-edit" />
          </button>
        )}
        {d.threadTs ? (
          <span className="sd-thread">
            <Icon name="MessagesSquare" size={12} /> in a thread
            {d.threadLink ? (
              <button className="linkish" onClick={() => (desktop?.browser && slackTool(tools) ? useTools.getState().show(slackTool(tools)!.id, d.threadLink) : window.open(d.threadLink, '_blank', 'noopener'))}>
                see it
              </button>
            ) : null}
          </span>
        ) : null}
        {d.at ? (
          <span className="sd-thread" title="Slack holds it and sends it then">
            <Icon name="Clock" size={12} /> sends {new Date(d.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
          </span>
        ) : null}
      </div>
      {banner && d.bannerQ && !d.files?.length ? <BannerPreview q={d.bannerQ} /> : null}
      <textarea
        ref={ta}
        className="sd-text"
        value={text}
        spellCheck
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void act('send');
          }
        }}
      />
      {err ? (
        <div className="sd-err">
          <Icon name="TriangleAlert" size={12} /> {err}
        </div>
      ) : null}
      {d.files?.length ? <Attachments files={d.files} kind="draft" id={d.id} /> : null}
      <div className="sd-actions">
        <button className="btn ghost" disabled={!!busy} onClick={() => void act('discard')} title="Don't send it (the session is told)">
          Discard
        </button>
        <span className="spacer" />
        {!d.files?.length ? (
          <label className="sd-banner" title="Cora's banner on top of the message: your orb, and what it's about">
            <input type="checkbox" checked={banner} disabled={!!busy} onChange={(e) => setBanner(e.target.checked)} /> Cora banner
          </label>
        ) : null}
        <button className="btn ghost" disabled={!!busy} onClick={() => void act('opened')} title={d.files?.length ? "Copy it and open the conversation in Slack, to finish and send it there (attach the files there yourself)" : 'Copy it and open the conversation in Slack, to finish and send it there'}>
          <Icon name="ExternalLink" size={12} /> Open in Slack
        </button>
        <button className="btn allow" disabled={!!busy || !text.trim()} onClick={() => void act('send')} title="Send it as you (Ctrl+Enter)">
          <Icon name={busy === 'send' ? 'LoaderCircle' : 'Send'} size={12} /> {busy === 'send' ? 'Sending…' : d.at ? 'Schedule' : 'Send'}
        </button>
      </div>
    </div>
  );
}

/** Who else to send it to: type a name, pick from Slack's people and channels. */
function Recipient({ onPick, onCancel }: { onPick(t: SlackTarget): void; onCancel(): void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SlackTarget[]>([]);
  const [sel, setSel] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => void findSlack(q).then((r) => (setHits(r), setSel(0))), 180);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <span className="sd-pick">
      <input
        autoFocus
        value={q}
        placeholder="name, @handle, #channel or email"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          else if (e.key === 'ArrowDown') (e.preventDefault(), setSel((i) => Math.min(hits.length - 1, i + 1)));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((i) => Math.max(0, i - 1)));
          else if (e.key === 'Enter' && hits[sel]) (e.preventDefault(), onPick(hits[sel]));
        }}
        onBlur={() => setTimeout(onCancel, 150)}
      />
      {hits.length ? (
        <span className="sd-hits" role="listbox">
          {hits.map((h, i) => (
            <span
              key={h.id}
              role="option"
              aria-selected={i === sel}
              className={`sd-hit${i === sel ? ' on' : ''}`}
              onMouseDown={(e) => (e.preventDefault(), onPick(h))}
              onMouseEnter={() => setSel(i)}
            >
              <Icon name={KIND_ICON[h.kind]} size={12} />
              <span>{h.label.replace(/^#/, '')}</span>
              {h.detail ? <span className="dim">{h.detail}</span> : null}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** What Cora just sent, in its conversation (console or command mode): one line each, while it can be undone. */
export function CoraSentInline() {
  const sent = useSlack((s) => s.sent);
  if (!sent.length) return null;
  return (
    <div className="cora-sent-inline">
      {sent.map((m) => (
        <SentCard key={m.id} m={m} inline />
      ))}
    </div>
  );
}

const size = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** The files going with a message: images as thumbnails (click: full size), anything else as its name and size. */
function Attachments({ files, kind, id, small = false }: { files: SlackAttachment[]; kind: 'draft' | 'sent'; id: string; small?: boolean }) {
  const src = (i: number) => `/api/slack/files/${kind}/${encodeURIComponent(id)}/${i}`;
  return (
    <span className={`sd-files${small ? ' small' : ''}`}>
      {files.map((f, i) =>
        f.image ? (
          <a key={i} className="sd-thumb" href={src(i)} target="_blank" rel="noreferrer" title={`${f.name} · ${size(f.size)}\n${f.path}`}>
            <img src={src(i)} alt={f.name} />
          </a>
        ) : (
          <span key={i} className="sd-file" title={f.path}>
            <Icon name="FileText" size={12} /> {f.name} <i>{size(f.size)}</i>
          </span>
        ),
      )}
    </span>
  );
}

/** The banner that will go on top of it, as it will look (so what it says is checked with the words): scaled to the card. */
function BannerPreview({ q }: { q: Record<string, string> }) {
  const box = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(0.8);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setK(el.clientWidth / 480));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="sd-preview" ref={box} style={{ ['--k' as string]: k } as React.CSSProperties} title="The banner it sends: untick Cora banner to send without it">
      <SlackBannerView q={q} />
    </div>
  );
}
