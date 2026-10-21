import { create } from 'zustand';
import type { CiHealth, CiJob, CiLink, CiMsg, CiPipeline } from '@cora/shared';

/** A failed job's log on show (clicked in the scene or the header strip). */
export type LogTarget = { sessionId: string; project: string; job: CiJob };

type CiState = {
  pipelines: Record<string, CiPipeline>;
  links: Record<string, CiLink>;
  health: CiHealth;
  log: LogTarget | null;
  apply(m: CiMsg): void;
  openLog(t: LogTarget | null): void;
};

/** GitLab pipelines the server follows for live sessions (see server/src/ci.ts). */
export const useCi = create<CiState>((set, get) => ({
  pipelines: {},
  links: {},
  health: { state: 'ok' },
  log: null,
  apply: (m) => {
    const st = get();
    const pipelines = m.full ? {} : { ...st.pipelines };
    const links = m.full ? {} : { ...st.links };
    for (const p of m.pipelines ?? []) pipelines[p.key] = p;
    for (const l of m.links ?? []) links[l.sessionId] = l;
    for (const sid of m.goneLinks ?? []) delete links[sid];
    // only pipelines some session still lists
    const listed = new Set(Object.values(links).flatMap((l) => l.pipelines.map((x) => x.key)));
    for (const k of Object.keys(pipelines)) if (!listed.has(k) && !(m.pipelines ?? []).some((p) => p.key === k)) delete pipelines[k];
    set({ pipelines, links, ...(m.health ? { health: m.health } : {}) });
  },
  openLog: (log) => set({ log }),
}));

if (import.meta.env?.DEV) (globalThis as { __ci?: typeof useCi }).__ci = useCi;
