import { useEffect, useState } from 'react';
import type { CalEvent } from '@cora/shared';
import { joinCall, markStandup, openNote, prepNotes, refreshCalendar, useCalendar } from '../../state/calendar';
import { openSettings } from '../SettingsModal';
import { Icon } from '../Icon';
import './today.css';

const hm = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
/** 3:30 PM → 3:30 (the rows' time column; the hour is clear from the order) */
const short = (t: number) => hm(t).replace(/\s?[AP]M$/, '');
const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
};
const dayOf = (t: number) => new Date(t).toDateString();
const weekday = (t: number) => new Date(t).toLocaleDateString('en-US', { weekday: 'short' });
/** A free stretch worth showing between calls. */
const GAP_MS = 30 * 60_000;
/** Join shows from this long before a call. */
const JOIN_EARLY_MS = 15 * 60_000;

const others = (e: CalEvent) => e.attendees.filter((a) => !a.self);
const nameOf = (a: CalEvent['attendees'][number]) => a.name ?? a.email.split('@')[0];
const who = (e: CalEvent, max = 2) => {
  const o = others(e).map(nameOf);
  return o.length > max ? `${o.slice(0, max).join(', ')} and ${o.length - max} more` : o.join(', ');
};
const initials = (s: string) =>
  s
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
const FACE = ['#f0abfc', '#fcd34d', '#93c5fd', '#a7f3d0', '#fca5a5', '#c4b5fd', '#fdba74'];
const faceColor = (s: string) => FACE[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % FACE.length];
const where = (link?: string) => (!link ? null : /meet\.google/.test(link) ? 'Google Meet' : /zoom\.us/.test(link) ? 'Zoom' : /teams\./.test(link) ? 'Teams' : /webex/.test(link) ? 'Webex' : 'video link');

/**
 * Cora's board: your calls. A strip of the day on top, the next call as the one card (a countdown, who,
 * Join, Prep), then the rest as rows: later today and tomorrow, with the calls already done folded at the foot. When
 * the day's calls are over, the strip and the card turn to tomorrow.
 */
export function TodayPanel() {
  const status = useCalendar((s) => s.status);
  const events = useCalendar((s) => s.events);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [earlier, setEarlier] = useState(false);

  if (!status) return <div className="lb-empty">Reading your calendar…</div>;
  if (status.state !== 'connected')
    return (
      <div className="td-off">
        <Icon name="CalendarClock" size={22} />
        <p>{status.state === 'scope' ? "Cora's Google sign-in can't read your calendar yet. Reconnect in Settings › Gmail and tick the calendar on Google's page." : 'Connect Google in Settings › Gmail, and Cora sees your calls (read only).'}</p>
        <button className="lb-pop" onClick={() => openSettings('gmail')}>
          {status.state === 'scope' ? 'Reconnect' : 'Connect'}
        </button>
      </div>
    );

  const todayKey = dayOf(now);
  const today = events.filter((e) => dayOf(e.start) === todayKey);
  const tomorrow = events.filter((e) => dayOf(e.start) !== todayKey && e.start > now);
  const done = today.filter((e) => e.end <= now);
  const live = today.find((e) => e.start <= now && e.end > now);
  const next = events.find((e) => e.start > now);
  const focus = live ?? next;
  // the strip shows today while it has calls to come, then tomorrow
  const stripDay = today.some((e) => e.end > now) || !tomorrow.length ? today : tomorrow.filter((e) => dayOf(e.start) === dayOf(tomorrow[0].start));
  const stripIsToday = stripDay === today;
  const later = today.filter((e) => e.start > now && e !== focus);
  const tomorrowRest = tomorrow.filter((e) => e !== focus);

  const prep = async (e: CalEvent) => {
    if (e.prep) return openNote(e.prep);
    setBusy(e.id);
    setSaid(null);
    const err = await prepNotes(e.id);
    setBusy(null);
    if (err) setSaid(err);
  };

  return (
    <div className="td-panel">
      <div className="td-stripw">
        <span className="td-day">
          {stripIsToday ? weekday(now) : `Tomorrow · ${weekday(stripDay[0]?.start ?? now + 86_400_000)}`}
          <button className="td-refresh" title="Read your calendar again" onClick={() => void refreshCalendar()}>
            <Icon name="RefreshCw" size={11} />
          </button>
        </span>
        <Strip calls={stripDay} now={stripIsToday ? now : null} focus={focus} />
      </div>

      {focus ? (
        <div className={`td-hero${live ? ' live' : ''}`}>
          <div className={`td-when${live || dayOf(focus.start) === todayKey ? '' : ' tm'}`}>
            {live ? (
              <>
                On now <big>until {short(live.end)}</big>
              </>
            ) : dayOf(focus.start) === todayKey ? (
              <>
                Next in <Countdown ms={focus.start - now} />
              </>
            ) : (
              <>
                {dayOf(focus.start) === dayOf(now + 86_400_000) ? 'Tomorrow' : weekday(focus.start)} <big>{short(focus.start)}<small>{hm(focus.start).slice(-2)}</small></big>
              </>
            )}
          </div>
          <div className="td-t">
            {focus.title}
            {focus.standup ? <span className="td-chip">standup</span> : null}
          </div>
          <div className="td-meta">
            {[`${short(focus.start)} – ${hm(focus.end)}`, where(focus.link), focus.prep ? 'prep notes ready' : focus.standup ? 'its notes are drafted before it' : null].filter(Boolean).join(' · ')}
          </div>
          {others(focus).length ? (
            <div className="td-who">
              <span className="td-faces">
                {others(focus)
                  .slice(0, 3)
                  .map((a) => (
                    <span key={a.email} className="td-face" style={{ background: faceColor(a.email) }} title={nameOf(a)}>
                      {initials(nameOf(a))}
                    </span>
                  ))}
                {others(focus).length > 3 ? <span className="td-face more">+{others(focus).length - 3}</span> : null}
              </span>
              <span>{who(focus)}</span>
            </div>
          ) : null}
          <div className="td-acts">
            {focus.link && (live || focus.start - now <= JOIN_EARLY_MS) ? (
              <button className="td-btn go" onClick={() => joinCall(focus.link!)}>
                <Icon name="Video" size={12} /> Join
              </button>
            ) : null}
            <button className="td-btn" disabled={busy === focus.id} onClick={() => void prep(focus)}>
              <Icon name={focus.prep ? 'NotebookText' : 'Sparkles'} size={12} /> {busy === focus.id ? 'Drafting…' : focus.prep ? 'Open prep notes' : 'Prep notes'}
            </button>
            <HoverActs e={focus} prep={null} />
          </div>
        </div>
      ) : (
        <div className="td-none">No calls today or tomorrow.</div>
      )}

      {status.error ? <div className="td-said">{status.error}</div> : null}
      {said ? <div className="td-said">{said}</div> : null}

      <div className="td-list">
        {later.length ? <Rows label="Later today" calls={later} now={now} busy={busy} onPrep={prep} /> : null}
        {tomorrowRest.length ? <Rows label="Tomorrow" calls={tomorrowRest} now={now} busy={busy} onPrep={prep} /> : null}
        {earlier && done.length ? <Rows label="Earlier today" calls={done} now={now} busy={busy} onPrep={prep} past /> : null}
      </div>
      {done.length ? (
        <button className="td-earlier" onClick={() => setEarlier(!earlier)}>
          {done.length === today.length ? `${done.length} call${done.length === 1 ? '' : 's'} today, all done` : `${done.length} earlier today`}
          <i />
          <Icon name={earlier ? 'ChevronDown' : 'ChevronUp'} size={11} />
        </button>
      ) : null}
    </div>
  );
}

/** 12 min; 1h 20m (the hours big, the minutes small). */
function Countdown({ ms }: { ms: number }) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60)
    return (
      <big>
        {m}
        <small>min</small>
      </big>
    );
  return (
    <big>
      {Math.floor(m / 60)}h<small>{m % 60 ? `${m % 60}m` : ''}</small>
    </big>
  );
}

/** The day's calls on one bar (8 to 6, wider when a call falls outside), with now marked. */
function Strip({ calls, now, focus }: { calls: CalEvent[]; now: number | null; focus?: CalEvent }) {
  const base = new Date(calls[0]?.start ?? now ?? Date.now());
  base.setHours(0, 0, 0, 0);
  const hour = (t: number) => (t - base.getTime()) / 3_600_000;
  const h0 = Math.min(8, ...calls.map((e) => Math.floor(hour(e.start))));
  const h1 = Math.max(18, ...calls.map((e) => Math.ceil(hour(e.end))));
  const x = (h: number) => `${(Math.max(h0, Math.min(h1, h)) - h0) / (h1 - h0) * 100}%`;
  const ticks: number[] = [];
  for (let h = h0 + (h0 % 2); h <= h1; h += 2) ticks.push(h);
  return (
    <div className="td-strip">
      <div className="bar" />
      {calls.map((e) => (
        <div
          key={e.id}
          className={`seg${now != null && e.end <= now ? ' past' : ''}${e.standup ? ' su' : ''}${e === focus ? ' next' : ''}`}
          style={{ left: x(hour(e.start)), width: `max(4px, calc(${x(hour(e.end))} - ${x(hour(e.start))}))` }}
          title={`${hm(e.start)} ${e.title}`}
        />
      ))}
      {now != null && hour(now) >= h0 && hour(now) <= h1 ? <div className="nw" style={{ left: x(hour(now)) }} /> : null}
      {ticks.map((h) => (
        <span key={h} className="tk" style={{ left: x(h) }}>
          {h % 12 || 12}
          {h >= 12 && h < 24 ? 'p' : 'a'}
        </span>
      ))}
    </div>
  );
}

function Rows({ label, calls, now, busy, onPrep, past }: { label: string; calls: CalEvent[]; now: number; busy: string | null; onPrep(e: CalEvent): void; past?: boolean }) {
  return (
    <>
      <div className="td-lbl">
        {label} <b>{calls.length}</b>
        <i />
      </div>
      {calls.map((e, n) => {
        const prev = calls[n - 1];
        return (
          <div key={e.id}>
            {prev && dayOf(prev.start) === dayOf(e.start) && e.start - prev.end >= GAP_MS ? (
              <div className="td-gap">
                <span>free {span(e.start - prev.end)}</span>
                <i />
              </div>
            ) : null}
            <div className={`td-row${past || e.end <= now ? ' past' : ''}`}>
              <span className="tm">{short(e.start)}</span>
              <span className="body">
                <span className="nm">
                  {e.title}
                  {e.standup ? <span className="td-chip">standup</span> : null}
                  {e.prep ? <Icon name="NotebookText" size={11} className="has-prep" /> : null}
                </span>
                {!past && others(e).length ? <span className="cx">{who(e, 3)}</span> : null}
              </span>
              <span className="dur">{span(e.end - e.start)}</span>
              {!past ? <HoverActs e={e} prep={() => onPrep(e)} busy={busy === e.id} /> : null}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** What a call's row offers on hover: its prep, standup or not (its whole series), open it in Google Calendar. */
function HoverActs({ e, prep, busy }: { e: CalEvent; prep: (() => void) | null; busy?: boolean }) {
  return (
    <span className="td-hov">
      {prep ? (
        <button disabled={busy} onClick={prep} title={e.prep ? 'Open its prep notes' : e.standup ? 'Draft its Standup notes' : 'Draft prep notes for it'}>
          {busy ? 'Drafting…' : e.prep ? 'Notes' : 'Prep'}
        </button>
      ) : null}
      <button onClick={() => void markStandup(e.id, !e.standup)} title={e.standup ? 'Not a standup (this whole series)' : 'A standup: Cora drafts its notes before it (this whole series)'}>
        {e.standup ? 'Not standup' : 'Standup'}
      </button>
      {e.url ? (
        <button onClick={() => joinCall(e.url!)} title="Open it in Google Calendar">
          <Icon name="ExternalLink" size={11} />
        </button>
      ) : null}
    </span>
  );
}
