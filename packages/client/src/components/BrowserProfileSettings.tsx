import { useEffect, useState } from 'react';
import type { Settings } from '@cora/shared';
import { setBrowserSettings } from '../state/browser';
import { Row, Toggle } from './settingsUi';

type Found = { id: string; name: string };

/** How a found profile is called in Cora: its name, and Edge's marked as Edge's. */
const label = (p: Found) => (p.id.startsWith('edge:') ? `Edge · ${p.name}` : p.name);

/**
 * The browser's profiles (Settings › Tools › Cora's browser): which of your Chrome and Edge profiles to bring in, each
 * with its own sign-ins and tabs in Cora's Browser, and the one sessions' browsers use.
 */
export function BrowserProfileRows({ server, save }: { server: Settings; save(p: object): Promise<void> }) {
  const [found, setFound] = useState<Found[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void fetch('/api/browser/profiles')
      .then((r) => (r.ok ? r.json() : { profiles: [] }))
      .then((j: { profiles: Found[] }) => setFound(j.profiles))
      .catch(() => setFound([]));
  }, []);
  // the Browser follows what's saved here
  useEffect(() => setBrowserSettings(server.browser), [server.browser]);
  if (!found?.length) return null;
  const mine = server.browser?.profiles ?? [];
  const has = (id: string) => mine.some((p) => p.id === id);
  const put = async (patch: object) => {
    setErr(null);
    await save({ browser: patch }).catch((e: Error) => setErr(e.message));
  };
  const toggle = (p: Found, on: boolean) => {
    // in the order your browsers list them, each keeping its name
    const next = found.filter((f) => (f.id === p.id ? on : has(f.id))).map((f) => ({ id: f.id, name: mine.find((m) => m.id === f.id)?.name ?? label(f) }));
    void put({ profiles: next });
  };
  const home = mine.find((p) => p.partition === 'persist:web');
  return (
    <>
      <Row
        wide
        label="Profiles"
        hint={
          mine.length
            ? `Each has its own sign-ins, bookmarks bar, suggestions and tabs; Cora's Browser switches between them. ${home ? `${home.name} keeps the sign-ins Cora had before, and Tools use those.` : ''}`
            : "Bring in your Chrome or Edge profiles to keep them apart, like Chrome does: each gets its own sign-ins, bookmarks bar and tabs. With none, Cora's browser has one profile with all your bookmarks."
        }
      >
        <div className="bp-list">
          {found.map((p) => (
            <Toggle key={p.id} label={label(p)} checked={has(p.id)} onChange={(on) => toggle(p, on)} />
          ))}
        </div>
      </Row>
      {mine.length > 1 ? (
        <Row
          label="Cora's sign-ins"
          hint="The profile that has the sign-ins you made in Cora before profiles (GitLab, Jira, Slack…), which Tools use too. Move them, and the profile that had them gets its own (already open pages switch when Cora restarts)."
        >
          <select className="set-input" value={home?.id ?? mine[0].id} onChange={(e) => void put({ home: e.target.value })}>
            {mine.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Row>
      ) : null}
      {mine.length > 1 ? (
        <Row label="Sessions use" hint="The profile a session's browser signs in with and suggests from.">
          <select className="set-input" value={server.browser?.sessions ?? home?.id ?? mine[0].id} onChange={(e) => void put({ sessions: e.target.value })}>
            {mine.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Row>
      ) : null}
      {err ? <div className="ny-err">{err}</div> : null}
    </>
  );
}
