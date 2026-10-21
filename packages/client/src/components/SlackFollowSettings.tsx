import { useEffect, useState } from 'react';
import { MAX_FOLLOW, type Settings, type SlackFollow, type SlackTarget } from '@cora/shared';
import { findSlack } from '../state/slack';
import { Row } from './settingsUi';
import { Icon } from './Icon';

const wordsOf = (s: string) => s.split(',').map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2).slice(0, 20);

/**
 * Channels you follow (Cora's Inbox): only what touches you there comes in (a reply in a thread you posted in, your
 * tickets and repos, @here) plus the words you set for each. Mentions of you count in any channel anyway.
 */
export function FollowRows({ server, save }: { server: Settings | null; save(p: object): Promise<void> }) {
  const follow = server?.slack?.follow ?? [];
  const [q, setQ] = useState('');
  const [found, setFound] = useState<SlackTarget[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!q.trim()) return setFound([]);
    const t = setTimeout(() => void findSlack(q).then((r) => setFound(r.filter((x) => x.kind === 'channel' && /^[CG]/.test(x.id)))).catch(() => setFound([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  const put = (next: SlackFollow[]) => {
    setErr(null);
    return save({ slack: { follow: next } }).catch((e) => setErr((e as Error).message));
  };
  const add = (t: SlackTarget) => {
    setQ('');
    setFound([]);
    if (!follow.some((f) => f.id === t.id)) void put([...follow, { id: t.id, label: t.label.startsWith('#') ? t.label : `#${t.label}`, words: [] }]);
  };
  return (
    <>
      {follow.map((f) => (
        <Row key={f.id} label={f.label} hint="Words to look for here, besides your tickets, your repos and @here (commas between)">
          <input
            className="set-input"
            defaultValue={f.words.join(', ')}
            placeholder="outage, node 3"
            spellCheck={false}
            onBlur={(e) => {
              const words = wordsOf(e.target.value);
              if (words.join(',') !== f.words.join(',')) void put(follow.map((x) => (x.id === f.id ? { ...x, words } : x)));
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <button className="btn ghost" onClick={() => void put(follow.filter((x) => x.id !== f.id))}>
            Remove
          </button>
        </Row>
      ))}
      {follow.length < MAX_FOLLOW ? (
        <Row label={follow.length ? 'Follow another' : 'Follow a channel'} hint="Cora's Inbox gets what touches you there: replies in threads you posted in, your tickets and repos, @here, and your words. Never every message.">
          <span className="jset-follow">
            <input className="set-input" value={q} placeholder="#channel" spellCheck={false} autoComplete="off" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && found[0] && add(found[0])} />
            {found.length ? (
              <span className="jset-found">
                {found.map((t) => (
                  <button key={t.id} className="btn ghost" disabled={follow.some((f) => f.id === t.id)} onClick={() => add(t)}>
                    <Icon name="Hash" size={12} /> {t.label.replace(/^#/, '')}
                  </button>
                ))}
              </span>
            ) : null}
          </span>
          {err ? <span className="ny-err">{err}</span> : null}
        </Row>
      ) : null}
    </>
  );
}
