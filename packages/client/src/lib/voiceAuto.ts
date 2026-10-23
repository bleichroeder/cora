import { useEffect } from 'react';
import { SLACK_DM_MARK, SPEAK_TOOL, isPresentTool, shortToolName, type BrainEvent, type PendingRequest } from '@cora/shared';
import { sessionEvents, useBrain } from '../state/store';
import { buildSteps, saidId } from './steps';
import { sessionName } from './format';
import { coraLine, loadVoice, speak, stopSpeaking, useVoice } from './voice';
import { backgroundTasks, outcome, type BgTask } from './background';

/** Something to say from a session's newest events: a line Claude said with its speak tool, or a tool that failed. */
export type Cue = { kind: 'said'; id: string; text: string } | { kind: 'failed'; id: string; e: BrainEvent };

// you turned it down or stopped it yourself: not worth saying
const DECLINED = /doesn't want to proceed|was rejected|interrupted by user/i;

/**
 * The cues in a session's newest events: only calls made since `since` (not history on load), each once (`seen` is
 * updated, whether or not the caller says it, so turning voice on later doesn't replay them).
 */
export function voiceCues(evs: BrainEvent[], since: number, seen: Set<string>): Cue[] {
  const out: Cue[] = [];
  for (let i = Math.max(0, evs.length - 40); i < evs.length; i++) {
    const e = evs[i];
    // a reply's say-line: the turn's spoken summary (not when you're away and wrote from Slack: it goes back there)
    if (e.kind === 'say' && e.said && e.ts >= since) {
      const id = saidId(e).slice('said:'.length);
      if (!seen.has(id)) {
        seen.add(id);
        if (!fromSlackDm(evs, i)) out.push({ kind: 'said', id, text: e.said });
      }
      continue;
    }
    if (e.kind !== 'tool' || !e.toolUseId || e.ts < since) continue;
    if (e.phase === 'start' && e.tool?.name === SPEAK_TOOL) {
      if (seen.has(e.toolUseId)) continue;
      seen.add(e.toolUseId);
      const text = String((e.tool.input as { text?: unknown } | undefined)?.text ?? '').trim();
      if (text && !fromSlackDm(evs, i)) out.push({ kind: 'said', id: e.toolUseId, text });
    } else if (e.phase === 'end' && e.tool?.failed) {
      const id = `fail:${e.toolUseId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (e.tool.name === SPEAK_TOOL || isPresentTool(e.tool.name) || DECLINED.test(`${e.tool.resultSummary ?? ''} ${e.tool.preview ?? ''}`)) continue;
      out.push({ kind: 'failed', id, e });
    }
  }
  return out;
}

/** Did the turn the event at `i` is in start with the user's words from Cora's Slack DM? */
export function fromSlackDm(evs: BrainEvent[], i: number): boolean {
  for (let j = i; j >= 0 && j > i - 2000; j--) {
    const e = evs[j];
    if (e.kind === 'prompt' && e.agentId === 'main') return (e.text ?? '').trimStart().startsWith(SLACK_DM_MARK);
  }
  return false;
}

/** A failed tool, said out loud: "A command failed in canvas." */
export function failureAnnouncement(e: BrainEvent, where: string): string {
  const name = e.tool?.name ?? '';
  const inp = (e.tool?.input ?? {}) as { file_path?: unknown };
  const file = typeof inp.file_path === 'string' ? inp.file_path.split(/[\\/]/).pop() : null;
  const what = /^(Bash|PowerShell)$/.test(name)
    ? 'A command'
    : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)
      ? `Editing ${file ?? 'a file'}`
      : `The ${shortToolName(name).replace(/ · /g, ' ')} tool`;
  return `${what} failed in ${where}.`;
}

/** Claude's spoken summary; from a session you're not looking at, it says which. */
export const saidLine = (text: string, where: string | null) => (where ? `In ${where}: ${text}` : text);

/** What a permission prompt is asking, said out loud. */
export function announcement(p: PendingRequest, where: string): string {
  if (p.kind === 'question') return `Claude has a question for you in ${where}.`;
  if (p.kind === 'elicitation') return `Claude needs your input in ${where}.`;
  const inp = (p.toolInput ?? {}) as { command?: unknown; file_path?: unknown; url?: unknown };
  const file = typeof inp.file_path === 'string' ? inp.file_path.split(/[\\/]/).pop() : null;
  // the first few words of a command, with paths and URLs cut to their last part (said, not spelled out)
  const cmd =
    typeof inp.command === 'string'
      ? inp.command
          .split(/\s+/)
          .slice(0, 4)
          .map((w) => w.replace(/^https?:\/\//, '').split(/[\\/]/).filter(Boolean).pop() ?? w)
          .join(' ')
      : null;
  const what =
    p.toolName === 'Bash' || p.toolName === 'PowerShell'
      ? `run ${cmd ?? 'a command'}`
      : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(p.toolName)
        ? `edit ${file ?? 'a file'}`
        : p.toolName === 'WebFetch'
          ? 'fetch a web page'
          : `use ${p.toolName.replace(/^mcp__/, '').replace(/__/g, ' ')}`;
  return `Claude wants to ${what} in ${where}.`;
}

/** A background command finished, said out loud: "Poll the pipeline is done in 6m, in orion-services." */
export function taskAnnouncement(t: BgTask, where: string): string {
  // what Claude called it; never the command itself read out (a command with no description is just "a background
  // command", or its program's name)
  const described = t.label !== '' && !t.command.startsWith(t.label.replace(/…$/, ''));
  const prog = /^[a-z][\w.-]{1,15}$/i.test(t.program) ? `${t.program} ` : '';
  const what = described ? t.label.replace(/…$/, '') : `A background ${prog}command`;
  if (t.status === 'completed') return `${what} is ${outcome(t)}, in ${where}.`;
  if (t.status === 'failed') return `${what} ${outcome(t).replace(/^failed/, 'failed')}, in ${where}.`;
  return `${what} ${outcome(t)}, in ${where}.`;
}

// Summaries and failures wait their turn: never over something being read or over push-to-talk. Per session only the
// newest unsaid summary is kept, and anything left unsaid for long is dropped.
type Queued = { id: string; text: string; group: string; at: number; sid?: string };
let queue: Queued[] = [];
const STALE_MS = 90_000;
/** Full replies this automation is reading (a speaker button's read of the same reply is yours, not these). */
const autoReads = new Set<string>();

function enqueue(q: Queued): void {
  queue = [...queue.filter((x) => x.group !== q.group), q].slice(-4);
  drain();
}

function drain(): void {
  const v = useVoice.getState();
  if (v.reading || v.ptt.phase !== 'idle') return;
  queue = queue.filter((x) => Date.now() - x.at < STALE_MS);
  const next = queue.shift();
  if (next) void speak(next.id, next.text, 400, false, next.sid);
}

/**
 * Voice automation (only when voice is on): say Claude's spoken summaries (any session) or read the whole reply when
 * a turn ends in the session you're looking at, and announce permission decisions, finished background commands and
 * (if asked) failures.
 */
export function useVoiceAutomation(): void {
  useEffect(() => {
    void loadVoice();
    let prevSessions = useBrain.getState().sessions;
    let prevPending = useBrain.getState().pending;
    let prevVersions = useBrain.getState().versions;
    // background commands already finished when the app opened aren't announced
    const told = new Set<string>();
    // speak calls and failures from before the app opened (history on load) aren't said
    const since = Date.now() - 5000;
    const cued = new Set<string>();
    let lastFail = 0;
    // after the change settles: speak() clears `reading` before setting its own, so draining at once would race it
    const offVoice = useVoice.subscribe((s, p) => {
      // automatic reading turned off (here, or in Settings): nothing waiting is read, and what's being read stops
      if (s.settings.read !== p.settings.read && s.settings.read === 'buttons') {
        queue = [];
        const id = s.reading?.id ?? '';
        if (id.startsWith('said:') || autoReads.has(id)) stopSpeaking();
        autoReads.clear();
      }
      if (s.reading !== p.reading || s.ptt.phase !== p.ptt.phase) setTimeout(drain, 0);
    });
    const offBrain = useBrain.subscribe((st) => {
      const v = useVoice.getState();
      const ready = v.settings.enabled && !!v.key?.set;
      if (st.sessions !== prevSessions) {
        const f = st.focus;
        const was = f ? prevSessions[f]?.state : undefined;
        prevSessions = st.sessions;
        if (ready && f && v.settings.read === 'full' && !v.settings.muted && (was === 'working' || was === 'thinking') && st.sessions[f]?.state === 'idle') {
          // the turn's final reply from main: the last main step with text, if it's recent
          const steps = buildSteps(sessionEvents(f), 'all');
          const last = [...steps].reverse().find((s) => s.agentId === 'main' && s.text);
          if (last?.text && Date.now() - last.ts < 10 * 60_000) {
            autoReads.add(last.key);
            void speak(last.key, last.text, v.settings.cap, false, f);
          }
        }
      }
      if (st.versions !== prevVersions) {
        const changed = Object.keys(st.versions).filter((k) => st.versions[k] !== prevVersions[k]);
        prevVersions = st.versions;
        for (const sid of changed) {
          // Cora's own session: its console says what Cora says (as Cora); said here too it was heard twice, once
          // as "In a session: …"
          if (coraLine('', sid)) continue;
          const evs = sessionEvents(sid);
          const s = st.sessions[sid];
          const where = s ? sessionName(s) : 'a session';
          for (const c of voiceCues(evs, since, cued)) {
            if (!ready) continue;
            if (c.kind === 'said') {
              if (v.settings.read === 'summaries' && !v.settings.muted) enqueue({ id: `said:${c.id}`, text: saidLine(c.text, sid === st.focus ? null : where), group: sid, at: Date.now(), sid });
            } else if (v.settings.announceFailures && !v.settings.muted && sid === st.focus && Date.now() - c.e.ts < 20_000 && Date.now() - lastFail > 20_000) {
              // one at a time: a burst of failures is said once
              lastFail = Date.now();
              enqueue({ id: c.id, text: failureAnnouncement(c.e, where), group: 'fail', at: Date.now() });
            }
          }
          const recent = evs.slice(-30).filter((e) => e.kind === 'task' && e.toolUseId && !told.has(e.id));
          for (const e of recent) {
            told.add(e.id);
            if (!ready || !v.settings.announceTasks || v.settings.muted || v.ptt.phase !== 'idle' || Date.now() - e.ts > 20_000) continue;
            const t = backgroundTasks(evs).find((x) => x.key === e.toolUseId);
            if (t && t.endedAt != null) void speak(`task:${e.id}`, taskAnnouncement(t, where), 400, true, sid);
          }
        }
      }
      if (st.pending !== prevPending) {
        const before = new Set(prevPending.map((p) => p.id));
        prevPending = st.pending;
        if (!ready || !v.settings.announce || v.settings.muted || v.ptt.phase !== 'idle') return;
        const fresh = st.pending.find((p) => !before.has(p.id));
        if (!fresh) return;
        const s = st.sessions[fresh.sessionId];
        void speak('announce', announcement(fresh, s ? sessionName(s) : coraLine('', fresh.sessionId) ? 'Cora' : 'a session'), 5000, true);
      }
    });
    return () => {
      offVoice();
      offBrain();
    };
  }, []);
}
