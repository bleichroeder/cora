import { create } from 'zustand';

/**
 * Something you did that didn't work, said where you'll see it: a toast in the corner for a few seconds (for the
 * clicks with no place of their own to say so: the rail's ×, resume again).
 */
export type Oops = { id: string; title: string; detail?: string };

export const useOops = create<{ list: Oops[] }>(() => ({ list: [] }));

let n = 0;
export function oops(title: string, detail?: string): void {
  const id = `oops${++n}`;
  useOops.setState((s) => ({ list: [...s.list.filter((o) => o.title !== title), { id, title, ...(detail ? { detail } : {}) }].slice(-3) }));
  setTimeout(() => dismissOops(id), 8000);
}

export function dismissOops(id: string): void {
  useOops.setState((s) => ({ list: s.list.filter((o) => o.id !== id) }));
}
