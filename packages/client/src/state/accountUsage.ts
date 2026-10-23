import { useEffect } from 'react';
import { create } from 'zustand';
import type { AccountUsage } from '@cora/shared';

/** Your plan's usage (the server reads it at most once a minute), and whether the usage view is open. */
export const useAccountUsage = create<{ u: AccountUsage | null; open: boolean }>(() => ({ u: null, open: false }));

let watchers = 0;
let timer = 0;
const load = () =>
  void fetch('/api/account-usage')
    .then((r) => (r.ok ? r.json() : null))
    .then((u: AccountUsage | null) => u && useAccountUsage.setState({ u }))
    .catch(() => {});

/** Keep it current while something shows it (asked every minute while any of them is up; nothing otherwise). */
export function useWatchUsage(on = true) {
  useEffect(() => {
    if (!on) return;
    if (watchers++ === 0) {
      load();
      timer = window.setInterval(load, 60_000);
    }
    return () => {
      if (--watchers === 0) clearInterval(timer);
    };
  }, [on]);
}

export const openUsage = (open = true) => useAccountUsage.setState({ open });
