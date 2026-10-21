import { create } from 'zustand';
import { EMPTY_DEPLOYS, type BumpTarget, type DeployBump, type DeploysMsg, type DeploysState } from '@cora/shared';

/** What each environment runs, the sessions' tickets' journeys, Cora's bump cards (see server/src/deploys.ts). */
export const useDeploys = create<{ s: DeploysState; apply(m: DeploysMsg): void }>((set) => ({
  s: EMPTY_DEPLOYS,
  apply: ({ t: _t, ...s }) => set({ s }),
}));

const post = async (url: string, body: unknown): Promise<string | null> => {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? null : ((j as { error?: string }).error ?? `HTTP ${r.status}`);
  } catch {
    return "Couldn't reach Cora's server";
  }
};

/** Bump dev workloads to a tag (the server checks it's dev, reachable, and in the registry). Null: done; else why not. */
export const bumpDev = (env: string, tag: string, targets: BumpTarget[], key?: string) =>
  post('/api/deploys/bump', { env, tag, ...(key ? { key } : {}), targets: targets.map(({ kind, namespace, name, container }) => ({ kind, namespace, name, container })) });

/** Forget a card: Cora's offer for a ticket and tag, or a finished bump. */
export const dismissDeploy = (id: string) => post('/api/deploys/dismiss', { id });

/** Finished bumps stay on show this long (undismissed). */
const DONE_SHOWN_MS = 3 * 3600_000;
export const bumpsToShow = (bumps: DeployBump[], now = Date.now()) => bumps.filter((b) => b.state === 'rolling' || now - (b.doneAt ?? b.at) < DONE_SHOWN_MS);

if (import.meta.env?.DEV) (globalThis as { __deploys?: typeof useDeploys }).__deploys = useDeploys;
