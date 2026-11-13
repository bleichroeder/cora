import { useEffect, useMemo, useState } from 'react';
import { stillQueued } from '../lib/queued';
import { sessionEvents, useBrain } from '../state/store';
import { isYourCommand } from '../lib/steps';
import { runningCommand } from '../lib/composer';
import { backgroundTasks, shortDur } from '../lib/background';
import { maskSecrets } from '../lib/mask';
import { takeBackQueued, useComposer } from '../state/composer';
import { Icon } from './Icon';
import { LiveActivity } from './LiveActivity';
import { TaskPanel } from './TaskPanel';
import { RecapBar } from './Recap';

/**
 * Everything live about a session in one place, under its transcript and over the composer: what it's doing now (and
 * each agent), Claude Code's latest recap, its task list, background commands still running, what you've queued for it, a command you're running.
 */
export function LiveBlock({ sessionId }: { sessionId: string }) {
  const version = useBrain((s) => s.versions[sessionId]);
  return (
    <div className="live-block">
      <LiveActivity sessionId={sessionId} />
      <RecapBar sessionId={sessionId} />
      <TaskPanel sessionId={sessionId} />
      <Background sessionId={sessionId} version={version} />
      <Queued sessionId={sessionId} version={version} />
      <Running sessionId={sessionId} version={version} />
    </div>
  );
}

/** Background commands still running: what each is, how long it's been. */
function Background({ sessionId, version }: { sessionId: string; version: number | undefined }) {
  const [, tick] = useState(0);
  const running = useMemo(
    () => backgroundTasks(sessionEvents(sessionId)).filter((t) => t.status === 'running'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, version],
  );
  useEffect(() => {
    if (!running.length) return;
    const h = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [running.length]);
  if (!running.length) return null;
  return (
    <div className="lb-rows">
      {running.map((t) => (
        <div key={t.key} className="lb-row" title={t.command}>
          <span className="lb-k">
            <Icon name="Timer" size={11} /> background
          </span>
          <span className="lb-v">{t.label}</span>
          <span className="lb-r">{shortDur(Date.now() - t.startedAt)}</span>
        </div>
      ))}
    </div>
  );
}

/** Messages you sent while Claude was working that it hasn't taken yet: pinned under the transcript until it does. */
function Queued({ sessionId, version }: { sessionId: string; version: number | undefined }) {
  // only while Claude is mid-turn: idle, it takes what you send at once, so nothing can still be waiting
  const midTurn = useBrain((s) => {
    const st = s.sessions[sessionId]?.state;
    return st === 'working' || st === 'thinking' || st === 'needs-you';
  });
  const waiting = useMemo(
    () => stillQueued(sessionEvents(sessionId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, version],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!midTurn || !waiting.length) return null;
  const back = async () => {
    setBusy(true);
    setErr(null);
    const r = await takeBackQueued(sessionId, waiting.map((e) => e.text ?? '').filter(Boolean));
    setBusy(false);
    if (!r.ok) setErr(r.error);
  };
  return (
    <div className="queued" title="Claude Code holds these until Claude is ready for them: at its next step, or when its turn ends">
      {waiting.map((e) => (
        <div key={e.id} className="q-row">
          <span className="q-tag">
            <Icon name="Clock" size={11} /> queued
          </span>
          <span className="q-t">{e.text}</span>
        </div>
      ))}
      <div className="q-note">
        {err ?? `Claude gets ${waiting.length === 1 ? 'it' : 'them'} at its next step.`}
        <button className="q-back" disabled={busy} onClick={() => void back()} title="Out of Claude's queue and back into the box, to change or drop">
          {busy ? 'taking back…' : 'take back'}
        </button>
      </div>
    </div>
  );
}

/**
 * A command you sent from the composer with `!`, while it runs: Claude Code writes it to the transcript only once it's
 * done (then it shows as "you ran" in the feed and this goes).
 */
function Running({ sessionId, version }: { sessionId: string; version: number | undefined }) {
  const sent = useComposer((c) => c.sent[sessionId]);
  const live = useBrain((s) => s.terminals.some((t) => t.sessionId === sessionId && t.alive));
  const ran = useMemo(
    () => sessionEvents(sessionId).filter((e) => e.kind === 'tool' && isYourCommand(e)).map((e) => (e.phase === 'end' ? e.ts - (e.durationMs ?? 0) : e.ts)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, version],
  );
  const r = live && sent ? runningCommand(sent, ran, Date.now()) : null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!r) return;
    const h = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [r?.at]);
  if (!r) return null;
  return (
    <div className="ran live ran-now" title="Claude Code writes it to the transcript once it's done">
      <div className="ran-h">
        <span className="pl">you ran</span>
        <span className="out">running · {shortDur(Date.now() - r.at)}</span>
        <span className="spin" />
      </div>
      <pre className="ran-cmd">
        <span className="ps">!</span> {maskSecrets(r.command).text}
      </pre>
    </div>
  );
}
