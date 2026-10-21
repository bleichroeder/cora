import { setReadAloud, useVoice } from '../lib/voice';
import { Icon } from './Icon';

/**
 * Automatic reading on or off (Settings › Voice › Read aloud), for every session: on, replies (their short summaries,
 * or the whole reply) are read as they come; off, only when you click a reply's speaker.
 */
export function ReadAloudToggle() {
  const show = useVoice((s) => s.settings.enabled && !!s.key?.set);
  const read = useVoice((s) => s.settings.read);
  if (!show) return null;
  const on = read !== 'buttons';
  return (
    <button
      className={`act-read${on ? ' on' : ''}`}
      title={on ? `Reading replies aloud (${read === 'full' ? 'full replies' : 'short summaries'}): click to stop` : 'Replies are read only when you click their speaker: click to read them as they come'}
      onClick={() => void setReadAloud(!on)}
    >
      <Icon name={on ? 'Volume2' : 'VolumeX'} size={13} />
    </button>
  );
}
