import { DEFAULT_CALENDAR, type CalendarBrief, type Settings } from '@cora/shared';
import { refreshCalendar, useCalendar } from '../state/calendar';
import { Group, Row, Section, Toggle } from './settingsUi';
import { openSettings } from './SettingsModal';

const LEADS = [5, 10, 15, 20, 30, 45, 60];

/**
 * Settings › Calendar: Cora reads your Google calendar (read
 * only, through Gmail's sign-in) and, before each call, what you get: an Inbox item, her brief, a notification, a
 * standup's notes drafted.
 */
export function CalendarSection({ server, save }: { server: Settings | null; save(p: object): Promise<void> }) {
  const status = useCalendar((s) => s.status);
  const c = { ...DEFAULT_CALENDAR, ...server?.calendar };
  const set = (p: Partial<typeof c>) => void save({ calendar: p });
  const word =
    status?.state === 'connected'
      ? `Reading your primary calendar (read only)${status.lastCheck ? `, last at ${new Date(status.lastCheck).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}.`
      : status?.state === 'scope'
        ? "Cora's Google sign-in doesn't have the calendar permission yet."
        : 'Not connected: the calendar uses the Google sign-in in Settings › Gmail.';
  return (
    <Section id="calendar" title="Calendar" intro="Cora sees your calls today and tomorrow (your Google calendar, read only) and helps you prepare for them. Nothing is ever written to your calendar.">
      <Group label="Your calendar">
        <Row label={word} hint={status?.error ?? (status?.state === 'scope' ? "Reconnect in Settings › Gmail and tick the calendar on Google's page. If Google says the calendar isn't allowed: add the calendar.readonly scope to your Google app (Google Auth Platform › Data access) and turn on the Google Calendar API." : undefined)}>
          {status?.state === 'connected' ? (
            <button className="btn" onClick={() => void refreshCalendar()}>
              Read it again
            </button>
          ) : (
            <button className="btn" onClick={() => openSettings('gmail')}>
              {status?.state === 'scope' ? 'Reconnect…' : 'Connect…'}
            </button>
          )}
        </Row>
      </Group>
      {server ? (
        <Group label="Before a call">
          <Row label="How long before" hint="When Cora tells you about a call, and does the rest below.">
            <select value={c.lead} onChange={(e) => set({ lead: Number(e.target.value) })}>
              {LEADS.map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
              <option value={0}>Never</option>
            </select>
          </Row>
          <Row label="Cora's brief" hint="Who it's with, what it's about, what's connected to it (tickets, merge requests, Slack, sessions), and what you might raise. She offers prep notes after it.">
            <select value={c.brief} onChange={(e) => set({ brief: e.target.value as CalendarBrief })}>
              <option value="spoken">Spoken (when voice is on)</option>
              <option value="written">Written only</option>
              <option value="off">Off</option>
            </select>
          </Row>
          <Toggle label="An Inbox item" hint="The call, with Join, Prep notes and Ask Cora; Cora's brief joins it once she's written it." checked={c.inbox} onChange={(v) => set({ inbox: v })} />
          <Toggle label="A desktop notification" hint="Google usually sends one already. Without Cora's agent, you get one anyway." checked={c.notify} onChange={(v) => set({ notify: v })} />
          <Toggle label="An alert when it starts" hint="A notification when the call starts (click it to join), Cora's one line, and your phone when you're away: the heads-up comes minutes before, and minutes are easy to lose." checked={c.startAlert} onChange={(v) => set({ startAlert: v })} />
          <Toggle label="Slack status during calls" hint={`Your Slack status says "In a call" while you're in one, and Slack clears it when the call ends. Nothing about the call itself; a status you set yourself is left alone.`} checked={c.slackStatus} onChange={(v) => set({ slackStatus: v })} />
          <Toggle label="Draft standup notes" hint="Before a standup, its notes from the Standup template (yesterday, today, blockers), from your work since the last one." checked={c.standupDraft} onChange={(v) => set({ standupDraft: v })} />
        </Group>
      ) : null}
    </Section>
  );
}
