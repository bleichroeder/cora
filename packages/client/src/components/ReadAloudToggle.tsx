import { setMuted, setSessionMuted, useVoice } from '../lib/voice';
import { Icon } from './Icon';

/**
 * This session's voice on or off (the speaker by its transcript): off, nothing it says is said on its own (its replies,
 * finished commands, failures, "needs you"). A reply's speaker still reads it when you click. Every session at once:
 * the speaker by the nav's Sessions heading (SessionsMute); Cora: its card's. What's said when it's on: Settings › Voice.
 */
export function ReadAloudToggle({ sessionId }: { sessionId: string }) {
  const show = useVoice((s) => s.settings.enabled && !!s.key?.set);
  const all = useVoice((s) => !!s.settings.muted);
  const mine = useVoice((s) => !!s.settings.mutedSessions?.includes(sessionId));
  if (!show) return null;
  const muted = all || mine;
  return (
    <button
      className={`act-read${muted ? '' : ' on'}`}
      title={
        all
          ? "Every session is muted (the speaker by Sessions in the nav): click to hear them all again"
          : mine
            ? 'This session is muted (its replies, commands, failures, "needs you"): click to hear it again'
            : "This session speaks: click to mute it (a reply's speaker still reads it when you click). Every session: the speaker by Sessions in the nav"
      }
      onClick={() => void (all ? setMuted(false) : setSessionMuted(sessionId, !mine))}
    >
      <Icon name={muted ? 'VolumeX' : 'Volume2'} size={13} />
    </button>
  );
}

/** Every session muted or not (the speaker by the nav's Sessions heading). Cora keeps its own switch. */
export function SessionsMute() {
  const show = useVoice((s) => s.settings.enabled && !!s.key?.set);
  const all = useVoice((s) => !!s.settings.muted);
  if (!show) return null;
  return (
    <button className={`rt-add${all ? ' muted' : ''}`} onClick={() => void setMuted(!all)} title={all ? 'Every session is muted: click to hear them again (the ones you muted one by one stay muted)' : 'Mute every session (Cora keeps speaking: its card has its own switch)'}>
      <Icon name={all ? 'VolumeX' : 'Volume2'} size={12} />
    </button>
  );
}
