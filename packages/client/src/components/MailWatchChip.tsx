import { useEffect } from 'react';
import { pollGmail, useGmail } from '../state/gmail';
import { openSettings } from './SettingsModal';
import { Icon } from './Icon';

/**
 * In a session's header while it waits for an email (an email watch it set): a quiet mail mark, the same family as
 * the ticket's Slack button. Hover: what it waits for and what it'll do; click: Settings › Gmail (where it can stop).
 */
export function MailWatchChip({ sessionId }: { sessionId: string }) {
  useEffect(() => pollGmail(), []);
  const all = useGmail((g) => g.status?.watches);
  const mine = (all ?? []).filter((w) => w.sessionId === sessionId);
  if (!mine.length) return null;
  const when = (t: number) => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const title = [
    'Waiting for email:',
    ...mine.map((w) => `• ${w.about} (from ${w.from}${w.mode === 'thread' ? ', following the thread' : ''}, until ${when(w.until)})\n  then: ${w.act === 'ask' ? 'ask you, then ' : w.act === 'tell' ? 'tell you' : ''}${w.act === 'tell' ? '' : w.then}`),
    'Click: Settings › Gmail (stop one there)',
  ].join('\n');
  return (
    <button className="tslack" onClick={() => openSettings('gmail')} title={title}>
      <Icon name="MailSearch" size={13} />
      {mine.length > 1 ? <span>{mine.length}</span> : null}
    </button>
  );
}
