import { create } from 'zustand';
import type { FfmpegState, VideoJob, VideoPlan, VideosMsg } from '@cora/shared';

/**
 * Debrief videos: the ones being made and made (from the
 * server, live), ffmpeg's state, and the one open in the player.
 */
export const useVideos = create<{ jobs: VideoJob[]; ffmpeg: FfmpegState; open: string | null; /** the Make a video modal: for this debrief */ maker: { sessionId: string; debriefId: string } | null; apply(m: VideosMsg): void; show(id: string | null): void; make(t: { sessionId: string; debriefId: string } | null): void }>((set) => ({
  jobs: [],
  ffmpeg: { state: 'missing', canDownload: false },
  open: null,
  maker: null,
  apply: (m) => set((s) => ({ jobs: m.jobs, ffmpeg: m.ffmpeg, open: s.open && m.jobs.some((j) => j.id === s.open) ? s.open : null })),
  show: (id) => set({ open: id }),
  make: (t) => set({ maker: t, ...(t ? { open: null } : {}) }),
}));

const call = async (method: string, url: string, body?: unknown): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> => {
  try {
    // a JSON content type only with a body: the server refuses an empty one (400)
    const r = await fetch(url, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, ...j } : { ok: false, error: j.error ?? `failed (${r.status})` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

/** Make a video of a debrief; the player opens on it (it shows its progress). */
export async function makeVideo(sessionId: string, debriefId: string, plan?: VideoPlan): Promise<string | null> {
  const r = await call('POST', `/api/debriefs/${encodeURIComponent(sessionId)}/${encodeURIComponent(debriefId)}/video`, plan ? { plan } : {});
  const job = r.ok ? (r.job as VideoJob) : null;
  if (job) useVideos.setState((s) => ({ jobs: s.jobs.some((j) => j.id === job.id) ? s.jobs : [...s.jobs, job], open: job.id }));
  return r.ok ? null : (r.error ?? 'failed');
}
export const downloadFfmpeg = () => call('POST', '/api/videos/ffmpeg', { download: true });
export const declineFfmpeg = () => call('POST', '/api/videos/ffmpeg', { decline: true });
export const deleteVideo = (id: string) => call('DELETE', `/api/videos/${encodeURIComponent(id)}`);
export const sendVideoInSlack = (id: string) => call('POST', `/api/videos/${encodeURIComponent(id)}/slack`);
export const videoUrl = (id: string, download = false) => `/api/videos/${encodeURIComponent(id)}/file${download ? '?download=1' : ''}`;
