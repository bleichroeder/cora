import { useEffect } from 'react';
import { useExplainAsk } from '../state/explainActions';
import { Icon } from './Icon';
import './explainAsk.css';

/**
 * A button pressed in a page that isn't Cora's own (a session's hand-written explain): what it would send or open,
 * asked here in Cora before anything happens (such a page could post "clicks" by script). Enter sends, Esc doesn't.
 */
export function ExplainAskHost() {
  const ask = useExplainAsk((s) => s.ask);
  useEffect(() => {
    if (!ask) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (e.stopPropagation(), ask.answer(false));
      else if (e.key === 'Enter') (e.stopPropagation(), ask.answer(true));
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [ask]);
  if (!ask) return null;
  const sends = ask.action.prompt != null;
  return (
    <div className="xask-scrim" onMouseDown={(e) => e.target === e.currentTarget && ask.answer(false)}>
      <div className="xask" role="dialog" aria-label="A page wants to act">
        <div className="xask-h">
          <Icon name={sends ? 'MessageSquareShare' : 'ExternalLink'} size={14} />
          <b>{ask.action.label}</b>
        </div>
        <p>{sends ? "This page (the session's own) wants to send this to the session as your message:" : "This page (the session's own) wants to open this link:"}</p>
        <pre>{ask.action.prompt ?? ask.action.url}</pre>
        <div className="xask-f">
          <button className="no" onClick={() => ask.answer(false)}>
            Cancel
          </button>
          <button className="yes" autoFocus onClick={() => ask.answer(true)}>
            {sends ? 'Send' : 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}
