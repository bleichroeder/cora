import { useEffect, useRef, useState } from 'react';
import { useDebrief } from '../state/debrief';
import { useBrain } from '../state/store';
import { Icon } from './Icon';

/**
 * The Debrief button (the session card's foot, the Changes tab's header): Quick or Teach me, and the session is asked
 * at once (a prompt, as if you typed it). A session that isn't running in Cora can't take one: the button says so.
 */
export function DebriefAsk({ sessionId, className = '', inline = false }: { sessionId: string; className?: string; /** the choice shown at once (the card's foot, under its "debrief" label) */ inline?: boolean }) {
  const hosted = useBrain((st) => st.terminals.some((t) => t.sessionId === sessionId && t.alive));
  const [pick, setPick] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!pick) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setPick(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [pick]);
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(null), 3500);
    return () => clearTimeout(t);
  }, [said]);
  const ask = async (depth: 'quick' | 'teach') => {
    setPick(false);
    const r = await useDebrief.getState().askFor(sessionId, depth);
    // asked: the Debriefs list (top of Changes) follows it as it's written
    setSaid(r.ok ? 'asked: writing it…' : (r.error ?? 'failed'));
  };
  return (
    <span className={`db-ask ${className}`} ref={box}>
      {said ? (
        <span className="db-said">{said}</span>
      ) : pick || (inline && hosted) ? (
        <>
          <button onClick={() => void ask('quick')} title="The delta, the why, the risks: a few steps">
            Quick
          </button>
          <i>·</i>
          <button onClick={() => void ask('teach')} title="Also the concepts and patterns, how it fits, links to read more, a quiz">
            Teach me
          </button>
        </>
      ) : (
        <button disabled={!hosted} onClick={() => setPick(true)} title={hosted ? 'Have the session walk you through its work in the IDE panel' : "It runs outside Cora: it can't take a debrief from here"}>
          <Icon name="Presentation" size={12} /> Debrief
        </button>
      )}
    </span>
  );
}
