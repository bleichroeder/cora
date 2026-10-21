import { useEffect, useState } from 'react';
import { DEFAULT_ONEPASSWORD, OP_SHORTCUT, type OnePasswordSettings, type OpStatus, type Settings } from '@cora/shared';
import { opStatus, setOpSettings } from '../state/onepassword';
import { Group, Row, Section, Toggle } from './settingsUi';
import { openSettings } from './SettingsModal';

/** Settings › 1Password (Connected): whether it's there, and what it fills. */
export function OnePasswordSection({ server, save }: { server: Settings | null; save(p: object): Promise<void> }) {
  const [status, setStatus] = useState<OpStatus | null | undefined>(undefined);
  useEffect(() => void opStatus().then(setStatus), []);
  const s: OnePasswordSettings = { ...DEFAULT_ONEPASSWORD, ...server?.onepassword };
  const set = (p: Partial<OnePasswordSettings>) => {
    const next = { ...s, ...p };
    setOpSettings(next);
    void save({ onepassword: p });
  };
  const missing = status && (!status.app ? 'The 1Password app isn’t installed' : !status.cli ? '1Password’s command line (op) isn’t installed' : !status.connected ? 'op isn’t connected to the 1Password app yet' : null);
  return (
    <Section
      id="onepassword"
      title="1Password"
      intro="Your logins, filled into Cora's browser when you ask: the key in the address bar, or Ctrl+\. 1Password unlocks with Windows Hello; Cora never keeps a password, and Claude sessions can't reach one."
    >
      <Row label="1Password" hint={status === undefined ? 'Checking…' : status === null ? 'Only in the desktop app.' : missing ? `${missing}: Setup walks you through it.` : 'Ready: the app, its command line, connected.'}>
        {missing ? (
          <button className="btn" onClick={() => openSettings('setup')}>
            Set it up
          </button>
        ) : (
          <span className={`dl-glyph ${status ? 'ok' : 'idle'}`} />
        )}
      </Row>
      <Group label="Filling">
        <Toggle label="Fill logins in Cora's browser" hint={`The key in a login field (or the address bar), or ${OP_SHORTCUT}: the logins 1Password has for the site, and a search for others.`} checked={s.on} onChange={(on) => set({ on })} />
        <Toggle label="Suggest at the field" hint="Focus a login field and the site's logins show under it, as 1Password's extension does. Only while 1Password is unlocked (it was used in the last 10 minutes), so it never asks for Windows Hello by itself." checked={s.suggest} onChange={(suggest) => set({ suggest })} />
        <Toggle label="One-time codes too" hint="When the login has a one-time password and the page has a field for it." checked={s.otp} onChange={(otp) => set({ otp })} />
        <Toggle label="In Tools too" hint={`The key in a login field, or ${OP_SHORTCUT}, in a Tool: in the drawer or in its own window.`} checked={s.tools} onChange={(tools) => set({ tools })} />
      </Group>
    </Section>
  );
}
