import { setMuted, useVoice } from '../lib/voice';
import { Icon } from './Icon';

/**
 * Voice updates on or off, for every session (the speaker by the transcript): off, nothing is said on its own: no
 * replies, finished commands, pipelines, failures, "needs you" or Cora's own news. A reply's speaker still reads it
 * when you click, and Cora still answers when you talk to it. What's said when it's on is in Settings › Voice.
 */
export function ReadAloudToggle() {
  const show = useVoice((s) => s.settings.enabled && !!s.key?.set);
  const muted = useVoice((s) => !!s.settings.muted);
  if (!show) return null;
  return (
    <button
      className={`act-read${muted ? '' : ' on'}`}
      title={muted ? 'Voice updates are off (replies, commands, pipelines, "needs you"): click to turn them on' : "Voice updates are on: click to mute them (a reply's speaker still reads it when you click)"}
      onClick={() => void setMuted(!muted)}
    >
      <Icon name={muted ? 'VolumeX' : 'Volume2'} size={13} />
    </button>
  );
}
