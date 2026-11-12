import { create } from 'zustand';
import { EMPTY_VPN, type VpnMsg, type VpnState } from '@cora/shared';
import { desktop } from '../lib/desktop';

/**
 * Your VPN (OpenVPN Connect, see server/src/vpn.ts): its profiles, the connected one, and sessions' requests to switch.
 * Only you switch it, from here; a session can only ask.
 */
export const useVpn = create<{ s: VpnState; apply(m: VpnMsg): void }>((set, get) => ({
  s: EMPTY_VPN,
  apply: ({ t: _t, ...s }) => {
    // a new request: tell you (it waits on the VPN control's card)
    const before = new Set(get().s.requests.map((r) => r.id));
    const fresh = s.requests.filter((r) => !before.has(r.id));
    set({ s });
    for (const r of fresh) {
      const name = s.profiles.find((p) => p.id === r.profileId)?.name ?? r.asked;
      desktop?.notify(`${r.session} asks for the ${name} VPN`, r.why, r.sessionId);
    }
  },
}));

const post = async (url: string, body: unknown): Promise<string | null> => {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { error?: string; vpn?: VpnState };
    if (j.vpn) useVpn.setState({ s: j.vpn });
    return r.ok ? null : (j.error ?? `HTTP ${r.status}`);
  } catch {
    return "Couldn't reach Cora's server";
  }
};

/** Connect a profile (null: disconnect). Null: under way; else why not. */
export const switchVpn = (to: string | null) => post('/api/vpn/switch', { to });
/** Your answer to a session's request: switch (to its profile, or the one you picked), or not now. */
export const answerVpn = (id: string, sw: boolean, profileId?: string) => post(`/api/vpn/requests/${encodeURIComponent(id)}`, { switch: sw, ...(profileId ? { profileId } : {}) });
/** Cora's VPN control on or off. */
export const setVpnOn = (on: boolean) => post('/api/vpn/settings', { on });
