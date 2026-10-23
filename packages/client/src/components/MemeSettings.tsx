import { useEffect, useState } from 'react';
import type { MemeMode, Settings } from '@cora/shared';
import { Choice, Row } from './settingsUi';
import { openInBrowser } from './JiraChip';
import { Icon } from './Icon';

/**
 * Settings › Sessions › Memes: how often sessions post to the Meme panel (off unless you turn it on; it applies to
 * sessions started from then on), and GIFs: your Giphy key, kept sealed on this machine and never shown again.
 */
export function MemeRows({ server, save }: { server: Settings; save(p: object): Promise<string | null | void> }) {
  const mode: MemeMode = server.memes?.mode ?? 'off';
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void fetch('/api/memes/giphy')
      .then((r) => r.json())
      .then((j: { key: boolean }) => setHasKey(j.key))
      .catch(() => setHasKey(false));
  }, []);
  const setGiphy = async (k: string | null) => {
    setErr(null);
    const r = await fetch('/api/memes/giphy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: k }) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) return setErr((j as { error?: string }).error ?? "Couldn't save it");
    setHasKey(!!(j as { key?: boolean }).key);
    setKey('');
  };
  return (
    <>
      <Row
        label="Memes"
        hint={
          mode === 'off'
            ? "Sessions can post memes and GIFs about what's happening to the board's Memes panel, just for fun. Off: they don't."
            : mode === 'sometimes'
              ? 'At real moments only (a stubborn fix, green tests after a fight, a scary failure), at most one every several turns. For sessions started from now on.'
              : 'Whenever something happens. For sessions started from now on.'
        }
      >
        <Choice value={mode} onChange={(m) => void save({ memes: { mode: m } })} options={[['off', 'Off'], ['sometimes', 'Now and then'], ['often', 'Often']]} />
      </Row>
      <Row
        label="GIFs"
        hint={
          hasKey
            ? 'Giphy is set up: sessions can post GIFs as well as memes. Your key is kept sealed on this machine.'
            : "With a Giphy key, sessions can post GIFs too (memes from templates need nothing). Make one at developers.giphy.com (pick API, not SDK) and paste it here."
        }
      >
        {hasKey ? (
          <button className="btn" onClick={() => void setGiphy(null)}>
            <Icon name="Trash2" size={12} /> Remove the key
          </button>
        ) : (
          <>
            <input className="set-input code" type="password" style={{ width: 200 }} value={key} placeholder="Giphy API key" spellCheck={false} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key.trim() && void setGiphy(key.trim())} />
            <button className="btn" disabled={!key.trim()} onClick={() => void setGiphy(key.trim())}>
              Save
            </button>
            <button className="btn ghost" title="Make a key" onClick={() => openInBrowser('https://developers.giphy.com/dashboard/')}>
              <Icon name="ExternalLink" size={12} />
            </button>
          </>
        )}
      </Row>
      {err ? <div className="ny-err">{err}</div> : null}
    </>
  );
}
