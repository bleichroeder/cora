import { useEffect } from 'react';
import { CoraOrb } from './CoraOrb';
import './slackBanner.css';

/**
 * Cora's Slack banner: the picture at the top of a message
 * Cora sends for you, on a page of its own (`/?banner=1`). The desktop app opens it out of sight, records a couple of
 * seconds of it and makes a GIF. Everything it says comes in the address: whose assistant, what the message is about,
 * where it came from, Cora's colour. When its words and orb are drawn its title turns to "ready".
 */
export function SlackBanner() {
  const q = new URLSearchParams(location.search);
  const name = q.get('name')?.slice(0, 40) || 'your';
  const line = q.get('line')?.slice(0, 120) || 'A message from Cora';
  const from = q.get('from')?.slice(0, 120) || '';
  const color = /^#[0-9a-f]{6}$/i.test(q.get('color') ?? '') ? q.get('color')! : undefined;
  if (color) document.documentElement.style.setProperty('--cora', color);
  useEffect(() => {
    document.documentElement.classList.add('banner-page');
    let done = false;
    // the fonts in, and the orb a few frames in
    void document.fonts.ready.then(() => setTimeout(() => !done && (document.title = 'ready'), 900));
    return () => void (done = true);
  }, []);
  return (
    <div className="slack-banner">
      <div className="sb-orb">
        <CoraOrb state="idle" size={64} ferro />
      </div>
      <div className="sb-words">
        <div className="sb-who">
          <b>CORA</b>
          <span>· {name === 'your' ? 'your' : `${name}'s`} assistant</span>
        </div>
        <div className="sb-line">{line}</div>
        {from ? <div className="sb-from">{from}</div> : null}
      </div>
    </div>
  );
}
