/**
 * The user's VPN (OpenVPN Connect on this PC): its profiles, which one is connected, and sessions' requests to
 * switch. Only the user switches it, from Cora's VPN control; a session can only ask (`vpn_request`), because a
 * switch cuts off whatever other sessions are doing on the VPN that's up (see server/src/vpn.ts).
 */

/** An environment a profile reaches (learned: what was reachable while it was connected). */
export type VpnReach = { id: string; name: string; label: string };

export type VpnProfile = {
  id: string;
  name: string;
  /** its server */
  host: string;
  /** environments it reached when it was last connected (learned) */
  reaches: VpnReach[];
  /** user-locked: OpenVPN Connect may ask for a password when it connects */
  password: boolean;
  lastConnected?: number;
};

/** Connected, on the way, or waiting for the user in OpenVPN Connect (a password, a sign-in, a dialog). */
export type VpnPhase = 'connected' | 'connecting' | 'disconnected' | 'waiting' | 'failed';

export type VpnRequest = {
  id: string;
  sessionId: string;
  /** the session's name when it asked */
  session: string;
  /** what it asked for, as it said it (an environment or a profile) */
  asked: string;
  /** the profile that matches (null: the user picks) */
  profileId: string | null;
  why: string;
  at: number;
};

export type VpnState = {
  /** OpenVPN Connect is installed here */
  available: boolean;
  /** Cora's VPN control is on (Settings › Environments) */
  on: boolean;
  profiles: VpnProfile[];
  /** the connected profile's id */
  connected: string | null;
  connectedAt?: number;
  phase: VpnPhase;
  /** a switch the user started, while it's under way */
  switching?: { to: string | null; at: number };
  /** the last switch didn't work: why */
  error?: string;
  requests: VpnRequest[];
};

export type VpnMsg = { t: 'vpn' } & VpnState;

export const EMPTY_VPN: VpnState = { available: false, on: false, profiles: [], connected: null, phase: 'disconnected', requests: [] };

/** A session asks the user to switch the VPN (it never switches it itself). */
export const VPN_REQUEST_TOOL = 'mcp__cora__vpn_request';
