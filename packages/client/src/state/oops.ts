import { create } from 'zustand';

/**
 * Something you did that didn't work, said where you'll see it: a toast in the corner for a few seconds (for the
 * clicks with no place of their own to say so: the rail's ×, resume again).
 */
export type Oops = { id: string; title: string; detail?: string; /** not a failure: something Cora did for you, said in passing */ info?: true };

export const useOops = create<{ list: Oops[] }>(() => ({ list: [] }));

let n = 0;
export function oops(title: string, detail?: string, o: { info?: boolean } = {}): void {
  const id = `oops${++n}`;
  useOops.setState((s) => ({ list: [...s.list.filter((x) => x.title !== title), { id, title, ...(detail ? { detail } : {}), ...(o.info ? { info: true as const } : {}) }].slice(-3) }));
  setTimeout(() => dismissOops(id), 8000);
}
/** A short notice in the same corner (not a failure): something Cora did along with what you asked. */
export const notice = (title: string, detail?: string) => oops(title, detail, { info: true });

export function dismissOops(id: string): void {
  useOops.setState((s) => ({ list: s.list.filter((o) => o.id !== id) }));
}
