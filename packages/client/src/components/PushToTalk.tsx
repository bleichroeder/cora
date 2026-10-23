import { useEffect, useRef } from 'react';
import { useBrain } from '../state/store';
import { sessionName } from '../lib/format';
import { cancelPtt, sendPrompt, startListening, stopListening, stopSpeaking, useVoice, voiceLevels } from '../lib/voice';
import './popovers.css';

const inField = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable], .xterm');

/** Push-to-talk over the scene: hold Ctrl+Shift+Space anywhere, see your words, review and send (the composer has its own mic). */
export function PushToTalk({ sessionId }: { sessionId: string }) {
  const enabled = useVoice((s) => s.settings.enabled);
  const ptt = useVoice((s) => s.ptt);
  const note = useVoice((s) => s.notice);
  // this session being read aloud (not another one, or Cora)
  const speaking = useVoice((s) => s.reading?.sessionId === sessionId);
  const s = useBrain((st) => st.sessions[sessionId]);
  const hosted = useBrain((st) => st.terminals.some((t) => t.sessionId === sessionId && t.alive));
  const wave = useRef<HTMLCanvasElement>(null);
  const review = useRef<HTMLTextAreaElement>(null);

  // hold Ctrl+Shift+Space anywhere, the terminal included (captured first, so it never sees the keystroke)
  useEffect(() => {
    if (!enabled) return;
    let held = false;
    const down = (e: KeyboardEvent) => {
      // (Ctrl+Space is Cora's)
      if (e.code === 'Space' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat && !held) {
          held = true;
          void startListening(sessionId);
        }
      } else if (e.key === 'Escape' && voiceLevels.speaking && !inField(e.target)) stopSpeaking();
    };
    const up = (e: KeyboardEvent) => {
      if (held && (e.code === 'Space' || e.key === 'Control' || e.key === 'Shift')) {
        held = false;
        e.preventDefault();
        e.stopPropagation();
        void stopListening();
      }
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [enabled, sessionId]);

  // switching sessions abandons a half-finished prompt
  useEffect(() => () => void (useVoice.getState().ptt.phase !== 'idle' && cancelPtt()), [sessionId]);

  // the level meter
  const active = ptt.phase === 'listening' || ptt.phase === 'finishing';
  useEffect(() => {
    if (!active) return;
    const hist = new Array(46).fill(0);
    let raf = 0;
    const draw = () => {
      const g = wave.current?.getContext('2d');
      hist.push(voiceLevels.listening ? voiceLevels.listen : 0);
      hist.shift();
      if (g) {
        g.clearRect(0, 0, 184, 56);
        g.fillStyle = '#22d3ee';
        hist.forEach((v, i) => {
          const h = 3 + v * 46;
          g.globalAlpha = 0.3 + 0.7 * (i / hist.length);
          g.fillRect(i * 4, 28 - h / 2, 2.4, h);
        });
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  useEffect(() => {
    if (ptt.phase === 'review') review.current?.focus();
  }, [ptt.phase]);

  if (!enabled) return null;
  // words for someone else (Cora, talking from its console or its card) aren't this session's to show or send
  const mine = !ptt.sessionId || ptt.sessionId === sessionId;
  const send = () => {
    const text = review.current?.value.replace(/\s+/g, ' ').trim();
    if (text) void sendPrompt(ptt.sessionId ?? sessionId, text, true);
    else cancelPtt();
  };
  return (
    <>
      {note && ptt.phase === 'idle' ? <div className="ptt-note">{note}</div> : null}
      {ptt.phase !== 'idle' && mine ? (
        <div className="ptt">
          {ptt.phase !== 'review' ? (
            <div className="ptt-cap">
              <canvas ref={wave} width={184} height={56} />
              <div className="ptt-txt">
                {ptt.text || ptt.interim ? (
                  <>
                    {ptt.text} <span className="interim">{ptt.interim}</span>
                  </>
                ) : (
                  <span className="interim">{ptt.phase === 'finishing' ? 'Finishing…' : 'Listening…'}</span>
                )}
              </div>
              <div className="ptt-tgt">
                → <b>{s ? sessionName(s) : 'session'}</b>
              </div>
            </div>
          ) : (
            <div className="ptt-review">
              <textarea
                ref={review}
                defaultValue={ptt.text}
                placeholder={ptt.error ? '' : 'Nothing was heard'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelPtt();
                  }
                }}
              />
              <div className="ptt-row">
                <span>{hosted ? 'Enter sends it to the terminal · Esc cancels' : "Not running here: Enter copies it to the clipboard · Esc cancels"}</span>
                <button className="btn ghost" onClick={cancelPtt}>Cancel</button>
                <button className="btn on" onClick={send}>{hosted ? 'Send ↵' : 'Copy'}</button>
              </div>
            </div>
          )}
          {ptt.error ? <div className="ptt-err">{ptt.error}</div> : null}
        </div>
      ) : null}
    </>
  );
}
