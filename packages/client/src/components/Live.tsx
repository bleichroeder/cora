import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { answerAsk, copyLink, endLive, follow, goLive, liveNote, placeOnScreen, removeGuest, setFollowOnly, setLiveArea, setLiveMode, setLiveReach, useLive } from '../state/live';
import { Icon } from './Icon';
import './popovers.css';
import './live.css';

/**
 * Go live's pieces: your
 * red Live chip and its popover, a guest's bar along the top, everyone's pointers, the guests' asks for you.
 */

const AREAS: Array<{ id: string; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'notes', label: 'Notes' },
  { id: 'messages', label: 'Slack & mail' },
  { id: 'console', label: "Cora's console" },
];
const MODES: Array<{ id: 'view' | 'interactive' | 'drive'; label: string; hint: string }> = [
  { id: 'view', label: 'View', hint: 'They watch, following you' },
  { id: 'interactive', label: 'Interactive', hint: "They prompt sessions; their answers to a session's prompts wait for yours" },
  { id: 'drive', label: 'Drive', hint: "They answer prompts and type into Claude's terminals themselves (never a shell)" },
];
const REACH: Array<{ id: 'public' | 'tailnet'; label: string; hint: string }> = [
  { id: 'public', label: 'Anyone with the link', hint: 'In any browser. Only this share is public (through Tailscale Funnel); the rest of Cora stays yours.' },
  { id: 'tailnet', label: 'Your tailnet', hint: 'Only devices on your tailnet, or ones you share this PC with.' },
];
const COLORS = ['#a78bfa', '#60a5fa', '#3ddc97', '#fbbf24', '#f87171', '#2dd4bf', '#fb923c'];
/** a guest's colour (theirs on every screen), the host's Cora pink */
export const liveColor = (id: string) => {
  if (!id.startsWith('guest:') && id.length && !/^[0-9a-f]+$/.test(id)) return 'var(--cora)';
  let h = 0;
  for (const c of id.replace(/^guest:/, '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** Your Live chip (by the session's title): Go live, or live with the guests' faces; the popover holds the rest. */
export function LiveChip() {
  const role = useLive((s) => s.role);
  const live = useLive((s) => s.live);
  const open = useLive((s) => s.open);
  const asks = useLive((s) => s.asks.length);
  const [busy, setBusy] = useState(false);
  if (role === 'guest') return null;
  if (!live)
    return (
      <>
        <button
          className={`dl-btn live-go live-anchor${open ? ' on' : ''}`}
          disabled={busy}
          title="Go live: a link to your Cora for a coworker (copied for you); they watch, or help, in their browser"
          onClick={async () => {
            setBusy(true);
            await goLive();
            setBusy(false);
          }}
        >
          <Icon name="Radio" size={13} />
          <span className="bt-l">{busy ? 'Going live…' : 'Go live'}</span>
        </button>
        {open ? <LivePop /> : null}
      </>
    );
  return (
    <>
      <button className={`dl-btn live-chip live-anchor${open ? ' on' : ''}`} onClick={() => useLive.setState({ open: !open })} title="You're live: who's watching, and the share's controls">
        <i className="live-dot" />
        Live
        {live.guests.length ? (
          <span className="live-faces">
            {live.guests.slice(0, 4).map((g) => (
              <span key={g.id} style={{ background: liveColor(g.id) }} title={g.name}>
                {g.name[0]?.toUpperCase()}
              </span>
            ))}
          </span>
        ) : null}
        {asks ? <b className="live-askn">{asks}</b> : null}
      </button>
      {open ? <LivePop /> : null}
    </>
  );
}

function LivePop() {
  const live = useLive((s) => s.live);
  const ref = useRef<HTMLDivElement>(null);
  // under the chip, its right edge with the chip's (drawn over everything: the header is its own stacking context)
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const b = document.querySelector('.live-anchor')?.getBoundingClientRect();
      setAt(b ? { top: b.bottom + 6, right: Math.max(8, window.innerWidth - b.right) } : null);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);
  const [copied, setCopied] = useState(false);
  // a click anywhere else, or Esc, closes it
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (ref.current && !ref.current.contains(el) && !el?.closest?.('.live-anchor')) useLive.setState({ open: false });
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && useLive.setState({ open: false });
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => (document.removeEventListener('pointerdown', away), document.removeEventListener('keydown', esc));
  }, []);
  const copy = () => {
    if (!live?.link) return;
    copyLink(live.link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  if (!at) return null;
  if (!live) return createPortal(<LiveSetup ref={ref} at={at} />, document.body);
  const n = live.guests.length;
  return createPortal(
    <div className="session-menu live-pop" ref={ref} style={{ top: at.top, right: at.right }}>
      <div className="sm-h">
        <span className="lp-tile">
          <i className="live-dot" />
        </span>
        <span className="sm-t">
          <b>You're live</b>
          <span>
            {n ? `${n} watching · ` : 'no one yet · '}
            {ago(live.startedAt)}
          </span>
        </span>
      </div>

      <div className="sm-gl">Watching</div>
      {n ? (
        live.guests.map((g) => (
          <div key={g.id} className="lp-g">
            <span className="lp-face" style={{ background: liveColor(g.id) }}>
              {g.name[0]?.toUpperCase()}
            </span>
            <span className="sm-t">
              <b>{g.name}</b>
              <span>
                {g.login ? `${g.login} · ` : ''}
                {ago(g.since)}
              </span>
            </span>
            <button className="sm-i" onClick={() => void removeGuest(g.id)} title={`Remove ${g.name}: their screen closes now`} aria-label={`Remove ${g.name}`}>
              <Icon name="UserX" size={14} />
            </button>
          </div>
        ))
      ) : (
        <p className="lp-hint">{live.reach === 'public' ? 'Send them the link (it was copied for you). A browser is all they need.' : 'Send them the link. Their device needs this PC shared to it on Tailscale.'}</p>
      )}

      <div className="sm-gl">Guests can</div>
      <div className="lp-seg" role="radiogroup" aria-label="What guests can do">
        {MODES.map((m) => (
          <button key={m.id} className={live.mode === m.id ? 'on' : ''} onClick={() => void setLiveMode(m.id)} role="radio" aria-checked={live.mode === m.id}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="lp-mode-hint">{MODES.find((m) => m.id === live.mode)?.hint}.</div>
      <button className={`lp-follow${live.followOnly ? ' on' : ''}`} onClick={() => void setFollowOnly(!live.followOnly)} role="switch" aria-checked={live.followOnly} title="Guests stay on your view; their clicks show you where they're pointing">
        <i />
        <span>
          <b>Follow only</b>
          <small>{live.followOnly ? 'They stay on your view; a click of theirs pulses on your screen' : 'They can look around on their own'}</small>
        </span>
      </button>

      <div className="sm-gl">Private areas</div>
      <div className="lp-areas">
        {AREAS.map((a) => {
          const on = live.open.includes(a.id);
          return (
            <button key={a.id} className={on ? 'on' : ''} onClick={() => void setLiveArea(a.id, !on)} title={on ? 'Open to your guests: click to make it private again' : 'Private: click to open it to your guests'} aria-pressed={on}>
              <Icon name={on ? 'Eye' : 'Lock'} size={12} />
              <span>{a.label}</span>
            </button>
          );
        })}
      </div>

      <div className="sm-gl">Who can open it</div>
      <div className="lp-seg" role="radiogroup" aria-label="Who can open the link">
        {REACH.map((r) => (
          <button key={r.id} className={live.reach === r.id ? 'on' : ''} onClick={() => live.reach !== r.id && void setLiveReach(r.id)} role="radio" aria-checked={live.reach === r.id}>
            {r.label}
          </button>
        ))}
      </div>
      <div className="lp-mode-hint">{REACH.find((r) => r.id === live.reach)?.hint}</div>

      <div className="sm-gl">Link</div>
      <div className="sm-name">
        <input readOnly value={live.link ?? ''} onFocus={(e) => e.currentTarget.select()} aria-label="The share's link" />
        <button className="sm-i" onClick={copy} title="Copy the link" aria-label="Copy the link">
          <Icon name={copied ? 'Check' : 'Copy'} size={14} />
        </button>
      </div>

      <div className="sm-sep" />
      <button className="sm-row bad" onClick={() => void endLive().then(() => useLive.setState({ open: false }))}>
        <Icon name="CircleStop" size={14} />
        End share
      </button>
    </div>,
    document.body,
  );
}

/** Going live couldn't: public links need Tailscale Funnel turned on for this PC, once (one click in Tailscale). */
function LiveSetup({ ref, at }: { ref: React.RefObject<HTMLDivElement | null>; at: { top: number; right: number } }) {
  const setup = useLive((s) => s.setup);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  if (!setup) return null;
  const openTs = () => {
    if (!setup.enableUrl) return;
    const d = (globalThis as { coraDesktop?: { openExternal?(u: string): void } }).coraDesktop;
    if (d?.openExternal) d.openExternal(setup.enableUrl);
    else window.open(setup.enableUrl, '_blank', 'noopener');
    setOpened(true);
  };
  const again = async (reach: 'public' | 'tailnet' = 'public') => {
    setBusy(true);
    await goLive(reach);
    setBusy(false);
  };
  return (
    <div className="session-menu live-pop" ref={ref} style={{ top: at.top, right: at.right }}>
      <div className="sm-h">
        <span className="lp-tile off">
          <Icon name="Radio" size={14} />
        </span>
        <span className="sm-t">
          <b>{setup.enableUrl ? 'One step first' : "Couldn't go live"}</b>
          <span>{setup.enableUrl ? 'once, then every link just works' : 'Tailscale'}</span>
        </span>
      </div>
      <p className="lp-hint lp-setup">
        {setup.enableUrl ? 'Public links go through Tailscale Funnel. Turn it on for this PC in Tailscale (one click), then come back and go live.' : setup.error}
      </p>
      {setup.enableUrl ? (
        <button className="dl-btn lp-primary" onClick={openTs}>
          <Icon name="ExternalLink" size={13} /> Turn on Funnel in Tailscale
        </button>
      ) : null}
      <button className={`dl-btn lp-primary${setup.enableUrl && !opened ? ' quiet' : ''}`} disabled={busy} onClick={() => void again()}>
        <Icon name="Radio" size={13} /> {busy ? 'Going live…' : setup.enableUrl ? "Done: go live" : 'Try again'}
      </button>
      <div className="sm-sep" />
      <button className="sm-row" disabled={busy} onClick={() => void again('tailnet')} title="Only devices on your tailnet (or ones you share this PC with) can open the link">
        <Icon name="Network" size={14} />
        Share on your tailnet only
      </button>
    </div>
  );
}

/** A guest's bar along the top: whose Cora, and whether you're following them. */
export function GuestBar() {
  const live = useLive((s) => s.live);
  const following = useLive((s) => s.following);
  if (!live) return null;
  const mode = live.followOnly ? `following ${live.host}: click to point something out` : live.mode === 'view' ? 'watching' : live.mode === 'interactive' ? 'you can prompt sessions' : 'you can drive';
  return (
    <div className="guest-bar">
      <i />
      <b>{live.host}'s Cora</b> · live · {mode}
      <span className="gb-sp" />
      {following && !live.followOnly ? <span className="gb-f">following {live.host}</span> : null}
      {live.followOnly ? null : <button onClick={() => follow(!following)}>{following ? 'Stop following' : `Follow ${live.host}`}</button>}
    </div>
  );
}

/** Someone pointing at something (a guest's click in Follow only): a ring pulsing there, with their name. */
export function LivePings() {
  const pings = useLive((s) => s.pings);
  if (!pings.length) return null;
  return (
    <div className="live-pings" aria-hidden>
      {pings.map((p) => {
        const col = p.id === 'me' ? 'var(--cora)' : liveColor(p.id);
        return (
          <div key={p.key} className="live-ping" style={{ ...placeOnScreen(p), ['--pc' as any]: col }}>
            <i />
            <i />
            {p.id === 'me' ? null : <span style={{ background: col }}>{p.name}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Everyone else's pointers, wearing their names (they fade when still). */
export function LiveCursors() {
  const cursors = useLive((s) => s.cursors);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const now = Date.now();
  return (
    <div className="live-cursors" aria-hidden>
      {Object.values(cursors).map((c) => {
        const still = now - c.at > 6000;
        if (now - c.at > 60_000) return null;
        const col = liveColor(c.id);
        return (
          <div key={c.id} className={`live-cur${still ? ' still' : ''}`} style={placeOnScreen(c)}>
            <svg width="16" height="18" viewBox="0 0 16 18">
              <path d="M1 1l13 7-6 1.5L5 16z" fill={col} stroke="#0b0e14" strokeWidth="1.2" />
            </svg>
            <span style={{ background: col }}>{c.name}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Your guests' asks (an answer to a session's prompt, in an interactive share): yours to allow. And this screen's notes. */
export function LiveAsks() {
  const asks = useLive((s) => s.asks);
  const role = useLive((s) => s.role);
  const note = useLive((s) => s.note);
  return (
    <div className="live-asks">
      {role === 'host'
        ? asks.map((a) => (
            <div key={a.id} className="live-ask">
              <span className="la-who">
                <b>{a.guest}</b> wants to {a.what}
              </span>
              <span className="la-btns">
                <button className="no" onClick={() => void answerAsk(a.id, false)}>
                  Deny
                </button>
                <button className="yes" onClick={() => void answerAsk(a.id, true).then((r) => !r.ok && r.error && liveNote(r.error))}>
                  Allow
                </button>
              </span>
            </div>
          ))
        : null}
      {note ? <div className="live-note">{note}</div> : null}
    </div>
  );
}

/** A private area, as a guest sees it: a quiet card. */
export function PrivateCard({ host, what }: { host?: string; what?: string }) {
  const h = useLive((s) => s.live?.host) ?? host ?? 'Your host';
  return (
    <div className="live-private">
      <Icon name="Lock" size={14} />
      <b>Private</b>
      <span>{what ? `${what}: ` : ''}{h} keeps this to themselves</span>
    </div>
  );
}

/** A guest's card at the top of the nav (where Cora's own is on the host's). */
export function GuestCard() {
  const host = useLive((s) => s.live?.host ?? '');
  return (
    <div className="guest-card">
      <span className="gc-orb" />
      <span>
        <b>{host}'s Cora</b>
        <small>live, shared with you</small>
      </span>
    </div>
  );
}
