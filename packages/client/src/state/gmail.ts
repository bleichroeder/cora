import { create } from 'zustand';
import type { GmailStatus } from '@cora/shared';

/** Gmail's state for the dashboard (Settings › Gmail, and its word in the Settings nav). */
export const useGmail = create<{ status: GmailStatus | null }>(() => ({ status: null }));

export async function loadGmail(): Promise<GmailStatus | null> {
  const r = await fetch('/api/gmail').catch(() => null);
  const s = r?.ok ? ((await r.json().catch(() => null)) as GmailStatus | null) : null;
  if (s) useGmail.setState({ status: s });
  return s;
}
export const setGmail = (status: GmailStatus) => useGmail.setState({ status });

/** Keep it fresh while the app is open (what's being waited for changes when an email comes): every 30 s. */
let polling = false;
export function pollGmail(): void {
  if (polling) return;
  polling = true;
  void loadGmail();
  setInterval(() => void loadGmail(), 30_000);
}
